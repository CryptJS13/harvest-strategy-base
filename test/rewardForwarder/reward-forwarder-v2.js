// RewardForwarderV2 against the live Base system at the block before the fee distribution
// 0x8b33f163... (2026-10-23 14:17 UTC). At this block the current forwarder (V1) holds 1037.8 USDC of
// fees from one 40Acres harvest. Its distributeAllFees sold the 726.46 USDC profit share for 30.23 iFARM,
// a 47% loss: the WETH -> FARM -> iFARM route runs through two thin Uniswap V3 pools, minOut was 1, and
// SwapRouter02 kept the 29.18 FARM the drained FARM/iFARM pool could not take.
//
// Production setup assumed here: the WETH -> FARM -> iFARM path on UniV3ExactDex
// (harvest-universal-liquidator-base, branch claude/univ3-exact-dex), USDC sold into WETH above a
// Chainlink floor, and the profit share bought in 0.02 WETH chunks above 0.85x fair.
//
// Needs the compiled UniV3ExactDex: set UL_EXACT_DEX_ARTIFACT to its build JSON, or compile it in
// ~/Harvest/harvest-universal-liquidator-base. Run: npx hardhat test test/rewardForwarder/reward-forwarder-v2.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const BigNumber = require("bignumber.js");
const { impersonates } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

// truffle's confirmation pollers flood the in-process node; this suite never needs them
function load(name) {
  const C = artifacts.require(name);
  C.disableConfirmationListener = true;
  return C;
}
const IERC20 = load("IERC20");
const IController = load("IController");
const RewardForwarder = load("RewardForwarder");
const RewardForwarderV2 = load("RewardForwarderV2");
const IUniversalLiquidatorRegistry = load("IUniversalLiquidatorRegistry");
const MockLiquidityDex = load("MockLiquidityDex");

const FORK_BLOCK = 52987864;

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = addresses.WETH;
const FARM = addresses.FARM;
const IFARM = addresses.iFARM;
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
const V1_FORWARDER = "0x1695A1BE5E2D67554baaeC18d97F2d1f92271718";
const HARD_WORKER = addresses.ULOwner; // a Controller hardWorker and the registry owner
const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const USDC_USD_FEED = "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B";
// fUSDC vault whose strategy pays a USDC fee a few minutes after FORK_BLOCK
const FEE_VAULT = "0xed5A6691a3663045c6D9F12f334FBc796EE12f45";
const FEE_STRATEGY = "0xfd5497d9a3825EaEe92078c7364FAFcD3a62A20e";

const INCIDENT_PS = "726458067";   // USDC profit share the incident sold
const INCIDENT_PF = "311339167";   // USDC platform fee
const INCIDENT_TOTAL = new BigNumber(INCIDENT_PS).plus(INCIDENT_PF).toFixed();
const INCIDENT_IFARM = "30234170614579381197";

// Base pool spot before the incident: 340.253 FARM/WETH x 0.549906 iFARM/FARM = 187.1 iFARM per WETH
const GOV_FLOOR_RATE = new BigNumber("159e18");   // 0.85x fair, iFARM wei per 1e18 WETH wei
const CHUNK = new BigNumber("0.02e18");
const BUY_INTERVAL = 600;

const UNIV3_ID = web3.utils.keccak256("uniV3");
const EXACT_ID = web3.utils.keccak256("uniV3Exact");
const MOCK_ID = web3.utils.keccak256("mockDex");

// runtime code for a feed whose latestRoundData answers 0 or -1 (fresh updatedAt)
const ZERO_ANSWER_FEED = "0x600160005242606052600160805260a06000f3";
const NEGATIVE_ANSWER_FEED = "0x60016000527f" + "ff".repeat(32) + "60205242606052600160805260a06000f3";
const FEED_ABI = [{
  name: "latestRoundData", type: "function", stateMutability: "view", inputs: [],
  outputs: [
    { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" }, { name: "startedAt", type: "uint256" },
    { name: "updatedAt", type: "uint256" }, { name: "answeredInRound", type: "uint80" },
  ],
}];

function bn(x) {
  return new BigNumber(x.toString());
}

async function expectRevertWith(promise, needle) {
  try {
    await promise;
  } catch (e) {
    assert.include(e.message, needle, `reverted, but not with ${needle}: ${e.message}`);
    return;
  }
  assert.fail(`expected a revert with ${needle}`);
}

async function advance(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

describe("RewardForwarderV2 (fork at block 52987864)", function () {
  let accounts, governance, deployer, strategyActor, stranger, psReceiver, feeReceiver;
  let usdc, weth, farm, ifarm, controller, registry, v1, v2, exactDex;
  let snapshotId;

  async function balance(token, who) {
    return bn(await token.balanceOf(who));
  }

  async function books(token) {
    return {
      ps: bn(await v2.pendingProfitShare(token)),
      pf: bn(await v2.pendingPlatformFee(token)),
    };
  }

  async function assertBacked(token) {
    const held = await balance(token, v2.address);
    const b = await books(token.address);
    assert.equal(held.toFixed(), b.ps.plus(b.pf).toFixed(), `V2 ${token.address} balance != books`);
  }

  // nothing may be left behind on the exact dex, in the router, or as iFARM in the forwarder
  async function assertNothingStranded(routerFarmBefore) {
    assert.equal((await balance(farm, ROUTER)).toFixed(), routerFarmBefore.toFixed(), "FARM left in SwapRouter02");
    assert.equal((await balance(farm, exactDex.address)).toFixed(), "0", "FARM left in the exact dex");
    assert.equal((await balance(weth, exactDex.address)).toFixed(), "0", "WETH left in the exact dex");
    assert.equal((await balance(ifarm, v2.address)).toFixed(), "0", "iFARM left in the forwarder");
  }

  // the incident's fees arrive at V2 the way a strategy sends them: approve, then notifyFee
  async function notifyIncidentFees() {
    await usdc.approve(v2.address, INCIDENT_TOTAL, { from: strategyActor });
    await v2.notifyFee(USDC, INCIDENT_PS, 0, INCIDENT_PF, { from: strategyActor });
  }

  async function wrapWeth(who, amount) {
    await web3.eth.sendTransaction({ from: who, to: WETH, value: amount });
  }

  async function setWethToIfarmDex(id) {
    await registry.setPath(id, [WETH, FARM, IFARM], { from: HARD_WORKER });
  }

  async function deployMockDex(pathTokens) {
    const mock = await MockLiquidityDex.new({ from: deployer });
    await registry.addDex(MOCK_ID, mock.address, { from: HARD_WORKER });
    await registry.setPath(MOCK_ID, pathTokens, { from: HARD_WORKER });
    return mock;
  }

  before(async function () {
    await network.provider.request({
      method: "hardhat_reset",
      params: [{
        forking: {
          jsonRpcUrl: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`,
          blockNumber: FORK_BLOCK,
        },
      }],
    });
    await network.provider.send("evm_mine");

    accounts = await web3.eth.getAccounts();
    deployer = accounts[0];
    strategyActor = accounts[1];
    stranger = accounts[2];
    governance = addresses.Governance;

    usdc = await IERC20.at(USDC);
    weth = await IERC20.at(WETH);
    farm = await IERC20.at(FARM);
    ifarm = await IERC20.at(IFARM);
    controller = await IController.at(addresses.Controller);
    registry = await IUniversalLiquidatorRegistry.at(addresses.UniversalLiquidatorRegistry);
    v1 = await RewardForwarder.at(V1_FORWARDER);
    psReceiver = await controller.profitSharingReceiver();
    feeReceiver = await controller.protocolFeeReceiver();
    assert.equal(await controller.rewardForwarder(), V1_FORWARDER);
    assert.isTrue(await controller.hardWorkers(HARD_WORKER));
    assert.isFalse(await controller.hardWorkers(stranger));

    await impersonates([governance, HARD_WORKER, V1_FORWARDER, psReceiver]);
    for (const a of [governance, HARD_WORKER, V1_FORWARDER, psReceiver]) {
      await network.provider.send("hardhat_setBalance", [a, "0x56BC75E2D63100000"]);
    }

    // the incident's USDC, taken from V1, plays the strategy's fee payment to V2
    await usdc.transfer(strategyActor, INCIDENT_TOTAL, { from: V1_FORWARDER });

    // UniV3ExactDex from the liquidator repo, registered for WETH -> FARM -> iFARM
    const artifactPath = process.env.UL_EXACT_DEX_ARTIFACT || path.join(os.homedir(),
      "Harvest/harvest-universal-liquidator-base/build/contracts/contracts/core/dexes/UniV3ExactDex.sol/UniV3ExactDex.json");
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`UniV3ExactDex artifact not found at ${artifactPath}; compile it in the liquidator repo or set UL_EXACT_DEX_ARTIFACT`);
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const signer = await ethers.getSigner(deployer);
    exactDex = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer).deploy();
    await exactDex.deployed();
    await (await exactDex.setFee(WETH, FARM, 3000)).wait();
    await (await exactDex.setFee(FARM, IFARM, 3000)).wait();
    await (await exactDex.setFee(USDC, WETH, 100)).wait();
    await registry.addDex(EXACT_ID, exactDex.address, { from: HARD_WORKER });
    await setWethToIfarmDex(EXACT_ID);

    v2 = await RewardForwarderV2.new(addresses.Storage, WETH, IFARM, { from: deployer });
    await v2.setPriceFeed(WETH, ETH_USD_FEED, 3600, { from: governance });
    await v2.setPriceFeed(USDC, USDC_USD_FEED, 90000, { from: governance });
    await v2.setOracleTolerance(200, { from: governance });
    await v2.setSwapLimit(USDC, WETH, "50000000000", 0, { from: governance });
    await v2.addRewardToken(USDC, { from: governance });
    await v2.setSwapLimit(WETH, IFARM, CHUNK.toFixed(), GOV_FLOOR_RATE.toFixed(), { from: governance });
    await v2.setMinBuyInterval(BUY_INTERVAL, { from: governance });

    snapshotId = await network.provider.send("evm_snapshot");
  });

  afterEach(async function () {
    await network.provider.send("evm_revert", [snapshotId]);
    snapshotId = await network.provider.send("evm_snapshot");
  });

  describe("V1 controls", function () {
    beforeEach(async function () {
      // give the incident USDC back to V1 (the before hook lent it to the strategy actor)
      await usdc.transfer(V1_FORWARDER, INCIDENT_TOTAL, { from: strategyActor });
    });

    it("on the old route V1 repeats the incident: 30.23 iFARM, FARM stranded in the router", async function () {
      await setWethToIfarmDex(UNIV3_ID);
      const iFarmBefore = await balance(ifarm, psReceiver);
      const routerFarmBefore = await balance(farm, ROUTER);

      // distributeFee(USDC) is the incident's USDC legs alone: the xStocks in V1's list cannot run on a fork
      await v1.distributeFee(USDC, { from: HARD_WORKER });

      assert.equal((await balance(ifarm, psReceiver)).minus(iFarmBefore).toFixed(), INCIDENT_IFARM);
      const stranded = (await balance(farm, ROUTER)).minus(routerFarmBefore);
      assert.isTrue(stranded.gt("29e18"), `stranded FARM ${stranded.toFixed()}`);
    });

    it("on UniV3ExactDex the same V1 swap reverts, so V1 keeps the profit share pending", async function () {
      const routerFarmBefore = await balance(farm, ROUTER);

      const tx = await v1.distributeFee(USDC, { from: HARD_WORKER });

      const failed = tx.logs.filter(l => l.event === "SwapFailed");
      assert.equal(failed.length, 1);
      assert.equal(failed[0].args.tokenIn, USDC);
      assert.equal(failed[0].args.tokenOut, IFARM);
      assert.equal(bn(failed[0].args.amount).toFixed(), INCIDENT_PS);
      assert.equal(bn(await v1.pendingProfitShare(USDC)).toFixed(), INCIDENT_PS);
      assert.equal(bn(await v1.pendingPlatformFee(USDC)).toFixed(), "0");
      assert.equal((await balance(farm, ROUTER)).toFixed(), routerFarmBefore.toFixed());
    });

    it("a direct USDC -> iFARM entry (live since 2026-10-27) bypasses the WETH entry; V1 is covered only once it moves too", async function () {
      // the entry 0x6a74 set at block 53155748, on the old dex
      await registry.setPath(UNIV3_ID, [USDC, WETH, FARM, IFARM], { from: HARD_WORKER });
      const inner = await network.provider.send("evm_snapshot");
      const routerFarmBefore = await balance(farm, ROUTER);
      await v1.distributeFee(USDC, { from: HARD_WORKER });
      assert.isTrue((await balance(farm, ROUTER)).minus(routerFarmBefore).gt("29e18"), "old direct entry should strand");
      await network.provider.send("evm_revert", [inner]);

      await registry.setPath(EXACT_ID, [USDC, WETH, FARM, IFARM], { from: HARD_WORKER });
      const tx = await v1.distributeFee(USDC, { from: HARD_WORKER });
      assert.isOk(tx.logs.find(l => l.event === "SwapFailed" && l.args.tokenOut === IFARM));
      assert.equal(bn(await v1.pendingProfitShare(USDC)).toFixed(), INCIDENT_PS);
      assert.equal((await balance(farm, ROUTER)).toFixed(), routerFarmBefore.toFixed());
    });
  });

  describe("settling and buying", function () {
    it("books what a strategy sends and nothing else", async function () {
      await notifyIncidentFees();
      const b = await books(USDC);
      assert.equal(b.ps.toFixed(), INCIDENT_PS);
      assert.equal(b.pf.toFixed(), INCIDENT_PF);
      await assertBacked(usdc);
    });

    it("settles the incident USDC above the Chainlink floor and buys one capped iFARM chunk", async function () {
      await notifyIncidentFees();
      const wethFeeBefore = await balance(weth, feeReceiver);
      const iFarmBefore = await balance(ifarm, psReceiver);
      const routerFarmBefore = await balance(farm, ROUTER);
      const oracleFloor = bn(await v2.floorFor(USDC, WETH, INCIDENT_TOTAL));
      assert.isTrue(oracleFloor.gt("0.42e18") && oracleFloor.lt("0.44e18"), `oracle floor ${oracleFloor.toFixed()}`);

      const tx = await v2.distributeAllFees({ from: HARD_WORKER });

      const swapped = tx.logs.find(l => l.event === "FeeSwapped");
      const wethOut = bn(swapped.args.amountOut);
      assert.equal(bn(swapped.args.minOut).toFixed(), oracleFloor.toFixed(), "stage 1 must pass its floor to the swap");
      assert.isTrue(wethOut.gte(oracleFloor), "stage 1 below its floor");
      const b = await books(USDC);
      assert.equal(b.ps.toFixed(), "0");
      assert.equal(b.pf.toFixed(), "0");

      const platformWeth = (await balance(weth, feeReceiver)).minus(wethFeeBefore);
      assert.equal(platformWeth.toFixed(), wethOut.times(INCIDENT_PF).idiv(INCIDENT_TOTAL).toFixed());

      const bought = tx.logs.find(l => l.event === "ProfitShareBought");
      assert.equal(bn(bought.args.hubIn).toFixed(), CHUNK.toFixed());
      assert.equal(bn(bought.args.minOut).toFixed(), CHUNK.times(GOV_FLOOR_RATE).idiv("1e18").toFixed());
      const iFarmOut = (await balance(ifarm, psReceiver)).minus(iFarmBefore);
      assert.equal(iFarmOut.toFixed(), bn(bought.args.amountOut).toFixed());
      assert.isTrue(iFarmOut.gte(bought.args.minOut.toString()), "stage 2 below its floor");
      assert.equal(bn(await v2.pendingProfitShare(WETH)).toFixed(), wethOut.minus(platformWeth).minus(CHUNK).toFixed());
      await assertNothingStranded(routerFarmBefore);
      await assertBacked(weth);
      await assertBacked(usdc);
    });

    it("buys the rest in chunks until the floor binds, never below it and never stranding", async function () {
      await notifyIncidentFees();
      const iFarmBefore = await balance(ifarm, psReceiver);
      const routerFarmBefore = await balance(farm, ROUTER);
      await v2.distributeAllFees({ from: HARD_WORKER });
      const firstBuffer = bn(await v2.pendingProfitShare(WETH)).plus(CHUNK);

      let spent = CHUNK;
      let failedAt = -1;
      for (let i = 0; i < 20; i++) {
        await advance(BUY_INTERVAL);
        const tx = await v2.distributeAllFees({ from: HARD_WORKER });
        const bought = tx.logs.find(l => l.event === "ProfitShareBought");
        const failed = tx.logs.find(l => l.event === "SwapFailed");
        await assertNothingStranded(routerFarmBefore);
        if (bought) {
          const rate = bn(bought.args.amountOut).times("1e18").idiv(bought.args.hubIn);
          assert.isTrue(rate.gte(GOV_FLOOR_RATE), `chunk ${i} bought at ${rate.toFixed()}`);
          spent = spent.plus(bought.args.hubIn);
        } else {
          assert.isOk(failed, `run ${i} neither bought nor failed`);
          assert.equal(failed.args.tokenIn, WETH);
          assert.equal(failed.args.tokenOut, IFARM);
          assert.equal(bn(failed.args.amount).toFixed(), CHUNK.toFixed());
          failedAt = i;
          break;
        }
      }
      assert.isAtLeast(failedAt, 1, "the pool should take a few chunks before the floor binds");

      // nothing lost: what was not spent is still buffered
      assert.equal(bn(await v2.pendingProfitShare(WETH)).toFixed(), firstBuffer.minus(spent).toFixed());
      const iFarmOut = (await balance(ifarm, psReceiver)).minus(iFarmBefore);
      assert.isTrue(iFarmOut.times("1e18").idiv(spent).gte(GOV_FLOOR_RATE), "average rate below the floor");
      await assertBacked(weth);
      // shiftedBy, not div: the suite's BigNumber config rounds div to integers
      console.log(`      bought ${iFarmOut.shiftedBy(-18).toFixed(4)} iFARM for ${spent.shiftedBy(-18).toFixed(4)} WETH ` +
        `(${iFarmOut.times(100).idiv(spent).shiftedBy(-2).toFixed(2)} iFARM/WETH) in ${failedAt + 1} chunks before the ` +
        `floor bound; ${bn(await v2.pendingProfitShare(WETH)).shiftedBy(-18).toFixed(4)} WETH still buffered`);
    });

    it("waits for the buy interval between chunks", async function () {
      await notifyIncidentFees();
      await v2.distributeAllFees({ from: HARD_WORKER });
      const buffered = bn(await v2.pendingProfitShare(WETH));
      const tx = await v2.distributeAllFees({ from: HARD_WORKER });
      assert.isUndefined(tx.logs.find(l => l.event === "ProfitShareBought"));
      assert.isUndefined(tx.logs.find(l => l.event === "SwapFailed"));
      assert.equal(bn(await v2.pendingProfitShare(WETH)).toFixed(), buffered.toFixed());
      await expectRevertWith(v2.buyProfitShare(CHUNK.toFixed(), "1", { from: HARD_WORKER }), "TooSoon");
    });
  });

  describe("accounting", function () {
    it("a WETH fee pays its platform share directly and the last chunk is limited by the buffer", async function () {
      const ps = new BigNumber("0.01e18");
      const pf = new BigNumber("0.004e18");
      await wrapWeth(strategyActor, ps.plus(pf).toFixed());
      await weth.approve(v2.address, ps.plus(pf).toFixed(), { from: strategyActor });
      await v2.notifyFee(WETH, ps.toFixed(), 0, pf.toFixed(), { from: strategyActor });
      const wethFeeBefore = await balance(weth, feeReceiver);

      const tx = await v2.distributeAllFees({ from: HARD_WORKER });

      assert.equal((await balance(weth, feeReceiver)).minus(wethFeeBefore).toFixed(), pf.toFixed());
      const bought = tx.logs.find(l => l.event === "ProfitShareBought");
      assert.equal(bn(bought.args.hubIn).toFixed(), ps.toFixed(), "the chunk is the whole buffer when it is below the cap");
      const b = await books(WETH);
      assert.equal(b.ps.toFixed(), "0");
      assert.equal(b.pf.toFixed(), "0");
      await assertBacked(weth);

      await advance(BUY_INTERVAL);
      const again = await v2.distributeAllFees({ from: HARD_WORKER });
      assert.isUndefined(again.logs.find(l => l.event === "ProfitShareBought" || l.event === "SwapFailed"));
      assert.equal((await balance(weth, feeReceiver)).minus(wethFeeBefore).toFixed(), pf.toFixed(), "paid twice");
    });

    it("capped stage-1 chunks split platform fee and profit share pro rata and end at exactly zero", async function () {
      await notifyIncidentFees();
      const cap = new BigNumber("300000000"); // 300 USDC
      await v2.setSwapLimit(USDC, WETH, cap.toFixed(), 0, { from: governance });

      for (let i = 0; i < 4; i++) {
        const before = await books(USDC);
        const total = before.ps.plus(before.pf);
        const amountIn = BigNumber.min(total, cap);
        const platformIn = before.pf.times(amountIn).idiv(total);
        const wethFeeBefore = await balance(weth, feeReceiver);
        const bufferBefore = bn(await v2.pendingProfitShare(WETH));

        const tx = await v2.distributeFee(USDC, { from: HARD_WORKER });

        const swapped = tx.logs.find(l => l.event === "FeeSwapped");
        assert.equal(bn(swapped.args.amountIn).toFixed(), amountIn.toFixed());
        const out = bn(swapped.args.amountOut);
        const platformOut = out.times(platformIn).idiv(amountIn);
        const after = await books(USDC);
        assert.equal(after.pf.toFixed(), before.pf.minus(platformIn).toFixed(), `chunk ${i} platform book`);
        assert.equal(after.ps.toFixed(), before.ps.minus(amountIn.minus(platformIn)).toFixed(), `chunk ${i} profit book`);
        assert.equal((await balance(weth, feeReceiver)).minus(wethFeeBefore).toFixed(), platformOut.toFixed());
        assert.equal(bn(await v2.pendingProfitShare(WETH)).minus(bufferBefore).toFixed(), out.minus(platformOut).toFixed());
        await assertBacked(usdc);
        await assertBacked(weth);
      }
      const end = await books(USDC);
      assert.equal(end.ps.toFixed(), "0");
      assert.equal(end.pf.toFixed(), "0");
      assert.equal((await balance(usdc, v2.address)).toFixed(), "0");
    });
  });

  describe("keeper path", function () {
    beforeEach(async function () {
      await notifyIncidentFees();
      await v2.distributeFee(USDC, { from: HARD_WORKER }); // stage 1 only: the WETH buffer, no buy yet
    });

    it("guards caller, size, pending amount and floor", async function () {
      const floor = CHUNK.times(GOV_FLOOR_RATE).idiv("1e18");
      await expectRevertWith(v2.buyProfitShare(CHUNK.toFixed(), floor.toFixed(), { from: stranger }), "only hard worker can call this");
      await expectRevertWith(v2.buyProfitShare(CHUNK.plus(1).toFixed(), floor.toFixed(), { from: HARD_WORKER }), "ExceedsCap");
      await expectRevertWith(v2.buyProfitShare("0", floor.toFixed(), { from: HARD_WORKER }), "ExceedsCap");
      await expectRevertWith(v2.buyProfitShare(CHUNK.toFixed(), floor.minus(1).toFixed(), { from: HARD_WORKER }), "BelowFloor");

      await v2.setSwapLimit(WETH, IFARM, "1000000000000000000", GOV_FLOOR_RATE.toFixed(), { from: governance });
      const buffered = bn(await v2.pendingProfitShare(WETH));
      await expectRevertWith(
        v2.buyProfitShare(buffered.plus(1).toFixed(), buffered.times(GOV_FLOOR_RATE).idiv("1e18").toFixed(), { from: HARD_WORKER }),
        "ExceedsPending");
    });

    it("buys exactly the quoted chunk, starts the interval, and reverts with nothing spent when the quote is too high", async function () {
      const floor = CHUNK.times(GOV_FLOOR_RATE).idiv("1e18");
      const quote = bn(await v2.buyProfitShare.call(CHUNK.toFixed(), floor.toFixed(), { from: HARD_WORKER }));
      assert.isTrue(quote.gte(floor));
      const buffered = bn(await v2.pendingProfitShare(WETH));

      await expectRevertWith(v2.buyProfitShare(CHUNK.toFixed(), quote.plus(1).toFixed(), { from: HARD_WORKER }), "Too little received");
      assert.equal(bn(await v2.pendingProfitShare(WETH)).toFixed(), buffered.toFixed());

      const before = await balance(ifarm, psReceiver);
      await v2.buyProfitShare(CHUNK.toFixed(), quote.toFixed(), { from: HARD_WORKER });
      assert.equal((await balance(ifarm, psReceiver)).minus(before).toFixed(), quote.toFixed());
      assert.equal(bn(await v2.pendingProfitShare(WETH)).toFixed(), buffered.minus(CHUNK).toFixed());
      await assertBacked(weth);

      // the keeper buy starts the interval for both paths
      const tx = await v2.distributeAllFees({ from: HARD_WORKER });
      assert.isUndefined(tx.logs.find(l => l.event === "ProfitShareBought" || l.event === "SwapFailed"));
      await expectRevertWith(v2.buyProfitShare(CHUNK.toFixed(), quote.toFixed(), { from: HARD_WORKER }), "TooSoon");
    });

    it("a keeper rate tightens the unattended floor but cannot loosen it", async function () {
      await expectRevertWith(v2.setKeeperRate(WETH, IFARM, "1", { from: stranger }), "only hard worker can call this");

      // below governance's floor: no effect
      await v2.setKeeperRate(WETH, IFARM, GOV_FLOOR_RATE.idiv(2).toFixed(), { from: HARD_WORKER });
      assert.equal(bn(await v2.floorFor(WETH, IFARM, CHUNK.toFixed())).toFixed(), CHUNK.times(GOV_FLOOR_RATE).idiv("1e18").toFixed());

      // between governance's floor and the pool: the unattended buy uses it and succeeds
      const keeper = new BigNumber("170e18");
      await v2.setKeeperRate(WETH, IFARM, keeper.toFixed(), { from: HARD_WORKER });
      let tx = await v2.distributeAllFees({ from: HARD_WORKER });
      const bought = tx.logs.find(l => l.event === "ProfitShareBought");
      assert.equal(bn(bought.args.minOut).toFixed(), CHUNK.times(keeper).idiv("1e18").toFixed());
      assert.isTrue(bn(bought.args.amountOut).gte(bought.args.minOut.toString()));

      // above what the pool pays: the unattended buy fails and keeps the WETH
      await advance(BUY_INTERVAL);
      await v2.setKeeperRate(WETH, IFARM, "250000000000000000000", { from: HARD_WORKER });
      const buffered = bn(await v2.pendingProfitShare(WETH));
      tx = await v2.distributeAllFees({ from: HARD_WORKER });
      const failed = tx.logs.find(l => l.event === "SwapFailed");
      assert.equal(failed.args.tokenIn, WETH);
      assert.equal(failed.args.tokenOut, IFARM);
      assert.equal(bn(await v2.pendingProfitShare(WETH)).toFixed(), buffered.toFixed());
    });
  });

  describe("fail-closed floors", function () {
    it("stage 1 enforces its floor: a USDC -> WETH floor above the pool fails the swap and keeps the books", async function () {
      await notifyIncidentFees();
      const oracleFloor = bn(await v2.floorFor(USDC, WETH, INCIDENT_TOTAL));
      // a keeper rate 5% above the Chainlink value (WETH wei per 1e18 USDC wei)
      const rate = oracleFloor.times(10000).idiv(9800).times(105).idiv(100).times("1e18").idiv(INCIDENT_TOTAL);
      await v2.setKeeperRate(USDC, WETH, rate.toFixed(), { from: HARD_WORKER });
      assert.isTrue(bn(await v2.floorFor(USDC, WETH, INCIDENT_TOTAL)).gt(oracleFloor));
      const wethFeeBefore = await balance(weth, feeReceiver);

      const tx = await v2.distributeAllFees({ from: HARD_WORKER });

      const failed = tx.logs.find(l => l.event === "SwapFailed" && l.args.tokenIn === USDC);
      assert.isOk(failed);
      assert.equal(failed.args.tokenOut, WETH);
      assert.equal(bn(failed.args.amount).toFixed(), INCIDENT_TOTAL);
      assert.isUndefined(tx.logs.find(l => l.event === "FeeSwapped"));
      const b = await books(USDC);
      assert.equal(b.ps.toFixed(), INCIDENT_PS);
      assert.equal(b.pf.toFixed(), INCIDENT_PF);
      assert.equal((await balance(weth, feeReceiver)).toFixed(), wethFeeBefore.toFixed());
      assert.equal(bn(await v2.pendingProfitShare(WETH)).toFixed(), "0");
      await assertBacked(usdc);
    });

    it("stage 2 with no governance floor skips the buy, and the keeper path refuses it", async function () {
      await notifyIncidentFees();
      await v2.distributeFee(USDC, { from: HARD_WORKER });
      await v2.setSwapLimit(WETH, IFARM, CHUNK.toFixed(), "0", { from: governance });
      // a keeper rate cannot turn a pair governance left unpriced back on
      await v2.setKeeperRate(WETH, IFARM, "170000000000000000000", { from: HARD_WORKER });
      assert.equal(bn(await v2.floorFor(WETH, IFARM, CHUNK.toFixed())).toFixed(), "0");
      const buffered = bn(await v2.pendingProfitShare(WETH));
      const before = await balance(ifarm, psReceiver);

      const tx = await v2.distributeAllFees({ from: HARD_WORKER });

      const skipped = tx.logs.find(l => l.event === "SwapSkipped" && l.args.tokenIn === WETH);
      assert.isOk(skipped);
      assert.equal(skipped.args.tokenOut, IFARM);
      assert.equal(bn(skipped.args.amount).toFixed(), CHUNK.toFixed());
      assert.isUndefined(tx.logs.find(l => l.event === "ProfitShareBought" || l.event === "SwapFailed"));
      assert.equal(bn(await v2.pendingProfitShare(WETH)).toFixed(), buffered.toFixed());
      assert.equal((await balance(ifarm, psReceiver)).toFixed(), before.toFixed());
      assert.equal(bn(await v2.lastBuyTime()).toFixed(), "0");
      await expectRevertWith(v2.buyProfitShare(CHUNK.toFixed(), "1", { from: HARD_WORKER }), "BelowFloor");
      await assertBacked(weth);
    });

    it("a keeper rate cannot unlock a stage-1 pair whose feed governance cleared", async function () {
      await notifyIncidentFees();
      await v2.setKeeperRate(USDC, WETH, "1", { from: HARD_WORKER });
      for (const cleared of [USDC, WETH]) {
        const inner = await network.provider.send("evm_snapshot");
        await v2.setPriceFeed(cleared, "0x0000000000000000000000000000000000000000", 0, { from: governance });
        assert.equal(bn(await v2.floorFor(USDC, WETH, INCIDENT_TOTAL)).toFixed(), "0", `feed of ${cleared} cleared`);
        const tx = await v2.distributeAllFees({ from: HARD_WORKER });
        assert.isOk(tx.logs.find(l => l.event === "SwapSkipped" && l.args.tokenIn === USDC));
        assert.isUndefined(tx.logs.find(l => l.event === "FeeSwapped"));
        assert.equal(bn(await v2.pendingPlatformFee(USDC)).toFixed(), INCIDENT_PF);
        await network.provider.send("evm_revert", [inner]);
      }
    });

    // a static minRate at half the oracle value, so a stale feed must block the swap rather than fall back to it
    async function setHalfOracleStaticFloor() {
      const rate = bn(await v2.floorFor(USDC, WETH, INCIDENT_TOTAL)).times("1e18").idiv(INCIDENT_TOTAL).idiv(2);
      await v2.setSwapLimit(USDC, WETH, "50000000000", rate.toFixed(), { from: governance });
    }

    it("a stale tokenOut feed (ETH/USD) blocks stage 1, even with a static floor set", async function () {
      await notifyIncidentFees();
      await setHalfOracleStaticFloor();
      await advance(3601); // past the ETH/USD maxAge; feeds do not update on a fork
      assert.equal(bn(await v2.floorFor(USDC, WETH, INCIDENT_PS)).toFixed(), "0");
      const tx = await v2.distributeAllFees({ from: HARD_WORKER });
      assert.isOk(tx.logs.find(l => l.event === "SwapSkipped" && l.args.tokenIn === USDC));
      assert.isUndefined(tx.logs.find(l => l.event === "FeeSwapped"));
      assert.equal(bn(await v2.pendingProfitShare(USDC)).toFixed(), INCIDENT_PS);
      await assertBacked(usdc);
    });

    it("a stale tokenIn feed (USDC/USD) blocks stage 1 while ETH/USD is fresh, even with a static floor set", async function () {
      await notifyIncidentFees();
      await setHalfOracleStaticFloor();
      const feed = new web3.eth.Contract(FEED_ABI, USDC_USD_FEED);
      const updatedAt = Number((await feed.methods.latestRoundData().call()).updatedAt);
      const now = Number((await web3.eth.getBlock("latest")).timestamp);
      await v2.setPriceFeed(USDC, USDC_USD_FEED, now - updatedAt + 300, { from: governance });
      assert.isTrue(bn(await v2.floorFor(USDC, WETH, INCIDENT_PS)).gt(0));

      await advance(400);
      assert.equal(bn(await v2.floorFor(USDC, WETH, INCIDENT_PS)).toFixed(), "0");
      const tx = await v2.distributeAllFees({ from: HARD_WORKER });
      assert.isOk(tx.logs.find(l => l.event === "SwapSkipped" && l.args.tokenIn === USDC));
      assert.equal(bn(await v2.pendingProfitShare(USDC)).toFixed(), INCIDENT_PS);
    });

    it("a feed answering 0 or a negative price blocks stage 1 without reverting the run", async function () {
      await notifyIncidentFees();
      for (const code of [ZERO_ANSWER_FEED, NEGATIVE_ANSWER_FEED]) {
        const inner = await network.provider.send("evm_snapshot");
        await network.provider.send("hardhat_setCode", [ETH_USD_FEED, code]);
        assert.equal(bn(await v2.floorFor(USDC, WETH, INCIDENT_PS)).toFixed(), "0");
        const tx = await v2.distributeAllFees({ from: HARD_WORKER });
        assert.isOk(tx.logs.find(l => l.event === "SwapSkipped" && l.args.tokenIn === USDC));
        assert.equal(bn(await v2.pendingPlatformFee(USDC)).toFixed(), INCIDENT_PF);
        await network.provider.send("evm_revert", [inner]);
      }
    });

    it("a pair with a cap but no floor is never swapped", async function () {
      await notifyIncidentFees();
      await v2.setPriceFeed(USDC, "0x0000000000000000000000000000000000000000", 0, { from: governance });
      assert.equal(bn(await v2.floorFor(USDC, WETH, INCIDENT_PS)).toFixed(), "0");
      const tx = await v2.distributeAllFees({ from: HARD_WORKER });
      assert.isOk(tx.logs.find(l => l.event === "SwapSkipped" && l.args.tokenIn === USDC));
      assert.equal(bn(await v2.pendingPlatformFee(USDC)).toFixed(), INCIDENT_PF);
    });

    it("rejects a stale feed, and feed changes from anyone but governance", async function () {
      await expectRevertWith(v2.setPriceFeed(USDC, ETH_USD_FEED, 1, { from: governance }), "BadFeed");
      await expectRevertWith(v2.setPriceFeed(USDC, ETH_USD_FEED, 3600, { from: stranger }), "Not governance");
    });

    it("on the old dex a mis-set floor would still let a partial fill through; UniV3ExactDex stops it", async function () {
      await notifyIncidentFees();
      await v2.distributeFee(USDC, { from: HARD_WORKER });
      const big = "304461543030811641"; // the incident's WETH
      await v2.setSwapLimit(WETH, IFARM, big, "1000000000000000000", { from: governance }); // floor 1 iFARM/WETH
      const buffered = bn(await v2.pendingProfitShare(WETH));
      const routerFarmBefore = await balance(farm, ROUTER);

      const tx = await v2.distributeAllFees({ from: HARD_WORKER });
      assert.isOk(tx.logs.find(l => l.event === "SwapFailed" && l.args.tokenOut === IFARM));
      assert.equal(bn(await v2.pendingProfitShare(WETH)).toFixed(), buffered.toFixed());
      await assertNothingStranded(routerFarmBefore);

      // the same with the old UniV3Dex goes through and strands FARM again
      await setWethToIfarmDex(UNIV3_ID);
      await v2.distributeAllFees({ from: HARD_WORKER });
      assert.isTrue((await balance(farm, ROUTER)).minus(routerFarmBefore).gt("20e18"));
    });
  });

  describe("misbehaving routes", function () {
    it("a dex that pays less than the minimum is caught by the receipt check (stage 1 and keeper path)", async function () {
      await notifyIncidentFees();
      // stage 2 needs a buffer, so fill it on the real route first
      await v2.setSwapLimit(USDC, WETH, "500000000", 0, { from: governance });
      await v2.distributeFee(USDC, { from: HARD_WORKER });
      const mock = await deployMockDex([USDC, WETH]);
      await mock.configure(1, "0x0000000000000000000000000000000000000000", 0);
      await wrapWeth(strategyActor, "1000000000000000000");
      await weth.transfer(mock.address, "1000000000000000000", { from: strategyActor });
      const before = await books(USDC);

      const tx = await v2.distributeFee(USDC, { from: HARD_WORKER });
      const failed = tx.logs.find(l => l.event === "SwapFailed");
      assert.equal(failed.args.tokenIn, USDC);
      assert.equal(failed.args.tokenOut, WETH);
      const after = await books(USDC);
      assert.equal(after.ps.toFixed(), before.ps.toFixed());
      assert.equal(after.pf.toFixed(), before.pf.toFixed());
      await assertBacked(usdc);
      await assertBacked(weth);

      // stage 2 through a short-paying dex: the keeper path reverts with ShortReceipt
      await registry.setPath(MOCK_ID, [WETH, IFARM], { from: HARD_WORKER });
      await ifarm.transfer(mock.address, "10000000000000000000", { from: psReceiver });
      const floor = CHUNK.times(GOV_FLOOR_RATE).idiv("1e18");
      await expectRevertWith(v2.buyProfitShare(CHUNK.toFixed(), floor.toFixed(), { from: HARD_WORKER }), "ShortReceipt");
    });

    it("a route that re-enters notifyFee mid-swap fails the swap instead of double-booking", async function () {
      await notifyIncidentFees();
      const mock = await deployMockDex([USDC, WETH]);
      await mock.configure(0, v2.address, "1000000000000000"); // re-books 0.001 WETH from inside the swap
      await wrapWeth(strategyActor, "1000000000000000000");
      await weth.transfer(mock.address, "1000000000000000000", { from: strategyActor });

      const tx = await v2.distributeAllFees({ from: HARD_WORKER });

      const failed = tx.logs.find(l => l.event === "SwapFailed" && l.args.tokenIn === USDC);
      assert.isOk(failed);
      const b = await books(USDC);
      assert.equal(b.ps.toFixed(), INCIDENT_PS);
      assert.equal(b.pf.toFixed(), INCIDENT_PF);
      await assertBacked(usdc);
      await assertBacked(weth);
    });
  });

  describe("token handling", function () {
    it("with WETH as the profit-share token the buffer is paid directly", async function () {
      await notifyIncidentFees();
      await v2.setProfitShareToken(WETH, { from: governance });
      const before = await balance(weth, psReceiver);
      await v2.distributeAllFees({ from: HARD_WORKER }); // stage 1 fills the buffer, the hub settle pays it
      assert.equal(bn(await v2.pendingProfitShare(WETH)).toFixed(), "0");
      assert.isTrue((await balance(weth, psReceiver)).minus(before).gt("0.29e18"));
      await expectRevertWith(v2.buyProfitShare(CHUNK.toFixed(), "1", { from: HARD_WORKER }), "NothingToBuy");
      await assertBacked(weth);
    });

    it("an unlisted token is booked but not iterated", async function () {
      const aero = await IERC20.at(AERO);
      const amount = bn(await aero.balanceOf(V1_FORWARDER));
      assert.isTrue(amount.gt(0));
      await aero.transfer(strategyActor, amount.toFixed(), { from: V1_FORWARDER });
      await aero.approve(v2.address, amount.toFixed(), { from: strategyActor });
      await v2.notifyFee(AERO, amount.toFixed(), 0, "0", { from: strategyActor });
      // with a limit and a floor, iterating AERO would emit FeeSwapped, SwapFailed or SwapSkipped
      await v2.setSwapLimit(AERO, WETH, amount.toFixed(), "1000000000000000", { from: governance });
      assert.equal(bn(await v2.rewardTokensLength()).toFixed(), "1"); // only USDC; the hub is not listed

      const tx = await v2.distributeAllFees({ from: HARD_WORKER });
      assert.isUndefined(tx.logs.find(l => l.args && l.args.tokenIn === AERO));
      assert.equal(bn(await v2.pendingProfitShare(AERO)).toFixed(), amount.toFixed());
      await assertBacked(aero);
    });

    it("the token list adds, removes with swap-and-pop, and re-adds", async function () {
      await v2.addRewardToken(AERO, { from: governance });
      await v2.addRewardToken(FARM, { from: governance });
      await v2.addRewardToken(FARM, { from: governance }); // no duplicate
      assert.equal(bn(await v2.rewardTokensLength()).toFixed(), "3");

      await v2.removeRewardToken(USDC, { from: governance });
      assert.equal(bn(await v2.rewardTokensLength()).toFixed(), "2");
      assert.equal(await v2.rewardTokens(0), FARM);
      assert.equal(await v2.rewardTokens(1), AERO);

      await v2.removeRewardToken(FARM, { from: governance }); // the moved token's index must be right
      assert.equal(bn(await v2.rewardTokensLength()).toFixed(), "1");
      assert.equal(await v2.rewardTokens(0), AERO);

      const tx = await v2.addRewardToken(USDC, { from: governance });
      assert.isOk(tx.logs.find(l => l.event === "RewardTokenAdded" && l.args.token === USDC));
      assert.equal(await v2.rewardTokens(1), USDC);
      await expectRevertWith(v2.addRewardToken(FARM, { from: stranger }), "Not governance");
    });

    it("migrates a token's books to a successor, which can re-book them only if backed", async function () {
      await notifyIncidentFees();
      const v3 = await RewardForwarderV2.new(addresses.Storage, WETH, IFARM, { from: deployer });
      await expectRevertWith(v2.migrateFees(USDC, v3.address, { from: stranger }), "Not governance");

      const tx = await v2.migrateFees(USDC, v3.address, { from: governance });
      const ev = tx.logs.find(l => l.event === "FeesMigrated");
      assert.equal(bn(ev.args.profitSharingFee).toFixed(), INCIDENT_PS);
      assert.equal(bn(ev.args.platformFee).toFixed(), INCIDENT_PF);
      assert.equal(bn(await v2.pendingProfitShare(USDC)).toFixed(), "0");
      assert.equal((await balance(usdc, v2.address)).toFixed(), "0");

      await expectRevertWith(v3.notifyFeeAdmin(USDC, INCIDENT_PS, bn(INCIDENT_PF).plus(1).toFixed(), { from: governance }), "Unbacked");
      await v3.notifyFeeAdmin(USDC, INCIDENT_PS, INCIDENT_PF, { from: governance });
      assert.equal(bn(await v3.pendingProfitShare(USDC)).toFixed(), INCIDENT_PS);
    });

    it("removing a token stops iteration but keeps its books", async function () {
      await notifyIncidentFees();
      await v2.removeRewardToken(USDC, { from: governance });
      const tx = await v2.distributeAllFees({ from: HARD_WORKER });
      assert.isUndefined(tx.logs.find(l => l.event === "FeeSwapped"));
      assert.equal(bn(await v2.pendingProfitShare(USDC)).toFixed(), INCIDENT_PS);
      await v2.distributeFee(USDC, { from: HARD_WORKER });
      assert.equal(bn(await v2.pendingProfitShare(USDC)).toFixed(), "0");
    });

    it("only hardWorkers or governance distribute, and swapChecked only answers to the forwarder", async function () {
      await notifyIncidentFees();
      await expectRevertWith(v2.distributeAllFees({ from: stranger }), "only hard worker can call this");
      await expectRevertWith(v2.distributeFee(USDC, { from: stranger }), "only hard worker can call this");
      await expectRevertWith(v2.swapChecked(USDC, WETH, "1", "1", stranger, { from: stranger }), "OnlySelf");
      await v2.distributeFee(USDC, { from: governance });
      assert.equal(bn(await v2.pendingProfitShare(USDC)).toFixed(), "0");
    });
  });

  describe("live strategy", function () {
    it("a real harvest pays V2, and base-cron's measurement sees the platform WETH in the same block", async function () {
      await controller.setRewardForwarder(v2.address, { from: governance });
      // base-cron's sequence: flush, read CommunityMsig WETH, doHardWork, distribute, read again
      await v2.distributeAllFees({ from: HARD_WORKER });
      const wethFeeBefore = await balance(weth, feeReceiver);
      const block = await web3.eth.getBlockNumber();

      await controller.doHardWork(FEE_VAULT, { from: HARD_WORKER });

      const events = await v2.getPastEvents("FeeNotified", { fromBlock: block + 1, toBlock: "latest" });
      assert.equal(events.length, 1, "the harvest should notify one fee");
      assert.equal(events[0].args.token, USDC);
      assert.equal(events[0].args.from.toLowerCase(), FEE_STRATEGY.toLowerCase());
      const ps = bn(events[0].args.profitSharingFee);
      const pf = bn(events[0].args.platformFee);
      assert.isTrue(pf.gt(0));
      const b = await books(USDC);
      assert.equal(b.ps.plus(b.pf).toFixed(), ps.plus(pf).toFixed());
      await assertBacked(usdc);

      const tx = await v2.distributeAllFees({ from: HARD_WORKER });
      const swapped = tx.logs.find(l => l.event === "FeeSwapped" && l.args.tokenIn === USDC);
      const platformOut = bn(swapped.args.amountOut).times(pf).idiv(ps.plus(pf));
      const measured = (await balance(weth, feeReceiver)).minus(wethFeeBefore);
      assert.isTrue(measured.gt(0));
      assert.equal(measured.toFixed(), platformOut.toFixed());
    });
  });
});
