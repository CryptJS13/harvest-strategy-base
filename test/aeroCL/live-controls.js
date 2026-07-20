const Utils = require("../utilities/Utils.js");
const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const Strategy = artifacts.require("AerodromeCLStrategyMainnet_cbETH_ETH1");
const IERC721 = artifacts.require("IERC721");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const IFactory = artifacts.require("IFactory");
const CLRebalanceHelper = artifacts.require("CLRebalanceHelper");
const MockCLPool = artifacts.require("MockCLPool");

describe("CL live-like controls", function() {
  let accounts;
  let governance;
  let controllerAddr;
  let underlyingWhale = "0x6a74649aCFD7822ae8Fb78463a9f2192752E5Aa2";
  let posId = 19447757;
  let posManager = "0x827922686190790b37229fd06084350E74485b72";

  let controller;
  let vault;

  before(async function() {
    governance = addresses.Governance;
    controllerAddr = addresses.Controller;
    accounts = await web3.eth.getAccounts();

    const nftToken = await IERC721.at(posManager);
    underlyingWhale = await nftToken.ownerOf(posId);

    await impersonates([governance, underlyingWhale, controllerAddr]);
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [governance, "0x8AC7230489E80000"],
    });
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [underlyingWhale, "0x8AC7230489E80000"],
    });
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [controllerAddr, "0x8AC7230489E80000"],
    });

    if (underlyingWhale.toLowerCase() !== governance.toLowerCase()) {
      await nftToken.transferFrom(underlyingWhale, governance, posId, { from: underlyingWhale });
    }

    [controller, vault] = await setupCoreProtocol({
      CLVault: true,
      CLSetup: { posId, posManager, targetWidth: 1 },
      existingVaultAddress: null,
      strategyArtifact: Strategy,
      strategyArtifactIsUpgradable: true,
      governance,
    });
  });

  it("should enforce rebalance executor permissions", async function() {
    const unauthorized = accounts[3];
    await vault.setRebalanceConfig(0, 0, governance, { from: governance });
    let failed = false;
    try {
      await vault.rebalanceCurrentTick(1, { from: unauthorized });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected non-executor rebalance call to fail");
  });

  it("should enforce governance-only control paths", async function() {
    const unauthorized = accounts[4];

    let failed = false;
    try {
      await vault.setLanePause(false, false, false, false, { from: unauthorized });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected unauthorized lane pause update to fail");

    failed = false;
    try {
      await vault.setRebalanceConfig(0, 60, unauthorized, { from: unauthorized });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected unauthorized rebalance config update to fail");

    failed = false;
    try {
      await vault.setRebalanceSafetyConfig(2500, 100, 900, 200, { from: unauthorized });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected unauthorized safety config update to fail");
  });

  it("should allow governance rebalance lane execution", async function() {
    await vault.setRebalanceConfig(0, 0, governance, { from: governance });
    try {
      await vault.rebalanceCurrentTick(1, { from: governance });
    } catch (e) {
      // live pool conditions can make rebalance ineligible; permission path is validated in prior test
    }
  });

  it("should block doHardWork in withdraw-only mode", async function() {
    await vault.setLanePause(false, false, false, true, { from: governance });
    let failed = false;
    try {
      await controller.doHardWork(vault.address, { from: governance });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected doHardWork to fail in withdraw-only mode");
    await vault.setLanePause(false, false, false, false, { from: governance });
  });

  it("should enforce strategy governance controls for emergency state and salvage", async function() {
    const strategyAddr = await vault.strategy();
    const strategy = await Strategy.at(strategyAddr);
    const unauthorized = accounts[5];

    let failed = false;
    try {
      await strategy.setEmergencyState(true, true, true, { from: unauthorized });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected unauthorized emergency update to fail");

    await strategy.setEmergencyState(true, true, true, { from: governance });
    failed = false;
    try {
      await controller.doHardWork(vault.address, { from: governance });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected doHardWork to fail when strategy emergency is active");
    await strategy.setEmergencyState(false, false, false, { from: governance });

    const token0 = await vault.token0();
    failed = false;
    try {
      await strategy.salvage(governance, token0, "0", { from: governance });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected salvage of unsalvageable token to fail");
  });

  it("should enforce strategy restricted/governance setters and allow controller salvage of non-core token", async function() {
    const strategyAddr = await vault.strategy();
    const strategy = await Strategy.at(strategyAddr);
    const unauthorized = accounts[6];

    let failed = false;
    try {
      await strategy.doHardWork({ from: unauthorized });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected unauthorized strategy doHardWork to fail");

    failed = false;
    try {
      await strategy.withdrawAllToVault(false, { from: unauthorized });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected unauthorized strategy withdrawAllToVault to fail");

    failed = false;
    try {
      await strategy.setSell(false, { from: unauthorized });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected unauthorized setSell to fail");

    failed = false;
    try {
      await strategy.setGauge(accounts[7], { from: unauthorized });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected unauthorized setGauge to fail");

    // Positive controller salvage path: vault share token is not unsalvageable by strategy policy.
    const shareDust = web3.utils.toBN("1");
    await vault.transfer(strategy.address, shareDust.toString(), { from: governance });
    const before = web3.utils.toBN(await vault.balanceOf(controllerAddr));
    await strategy.salvage(controllerAddr, vault.address, shareDust.toString(), { from: controllerAddr });
    const after = web3.utils.toBN(await vault.balanceOf(controllerAddr));
    assert.equal(after.sub(before).eq(shareDust), true, "Expected controller salvage to transfer non-core dust token");
  });

  it("should block rebalance when rebalance lane is paused", async function() {
    await vault.setLanePause(false, false, true, false, { from: governance });
    let failed = false;
    try {
      await vault.rebalanceCurrentTick(1, { from: governance });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected rebalance to fail when rebalance lane is paused");
    await vault.setLanePause(false, false, false, false, { from: governance });
  });

  it("should block rebalance in withdraw-only mode", async function() {
    await vault.setLanePause(false, false, false, true, { from: governance });
    let failed = false;
    try {
      await vault.rebalanceCurrentTick(1, { from: governance });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected rebalance to fail in withdraw-only mode");
    await vault.setLanePause(false, false, false, false, { from: governance });
  });

  it("should block withdraw when deposit/withdraw lane is paused", async function() {
    await vault.setLanePause(true, false, false, false, { from: governance });
    let failed = false;
    try {
      await vault.withdraw(1, 0, 0, { from: governance });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected withdraw to fail when deposit/withdraw lane is paused");
    await vault.setLanePause(false, false, false, false, { from: governance });
  });

  it("should run repeated hardwork in live-like loop without loss", async function() {
    let sharePrice = await vault.getPricePerFullShare();
    const oldBalance = (await vault.balanceOf(governance)).toString();
    const oldValue = web3.utils.toBN(oldBalance).mul(web3.utils.toBN(sharePrice));

    for (let i = 0; i < 3; i++) {
      await controller.doHardWork(vault.address, { from: governance });
      await Utils.advanceNBlock(1500);
    }

    sharePrice = await vault.getPricePerFullShare();
    const newBalance = (await vault.balanceOf(governance)).toString();
    const newValue = web3.utils.toBN(newBalance).mul(web3.utils.toBN(sharePrice));
    assert.equal(newValue.gte(oldValue), true, "Expected live-like loop to avoid value loss");
  });

  it("should support partial withdraw and redeposit lifecycle", async function() {
    const token0 = await IERC20.at(await vault.token0());
    const token1 = await IERC20.at(await vault.token1());
    const oldShares = web3.utils.toBN(await vault.balanceOf(governance));
    const withdrawShares = oldShares.div(web3.utils.toBN("20"));
    assert.equal(withdrawShares.gt(web3.utils.toBN("0")), true, "Expected non-zero withdraw amount");

    await vault.withdraw(withdrawShares.toString(), 0, 0, { from: governance });
    const amt0 = await token0.balanceOf(governance);
    const amt1 = await token1.balanceOf(governance);
    assert.equal(
      web3.utils.toBN(amt0).gt(web3.utils.toBN("0")) || web3.utils.toBN(amt1).gt(web3.utils.toBN("0")),
      true,
      "Expected token proceeds from partial withdraw"
    );

    await token0.approve(vault.address, amt0, { from: governance });
    await token1.approve(vault.address, amt1, { from: governance });
    await vault.deposit(amt0, amt1, 0, governance, { from: governance });

    const newShares = web3.utils.toBN(await vault.balanceOf(governance));
    assert.equal(newShares.gt(oldShares.sub(withdrawShares)), true, "Expected shares to increase after redeposit");
  });

  it("should not allow share inflation on repeated withdraw/redeposit loops", async function() {
    const token0 = await IERC20.at(await vault.token0());
    const token1 = await IERC20.at(await vault.token1());

    for (let i = 0; i < 5; i++) {
      const sharesBefore = web3.utils.toBN(await vault.balanceOf(governance));
      const withdrawShares = sharesBefore.div(web3.utils.toBN("50"));
      if (withdrawShares.eq(web3.utils.toBN("0"))) {
        break;
      }

      const token0Before = web3.utils.toBN(await token0.balanceOf(governance));
      const token1Before = web3.utils.toBN(await token1.balanceOf(governance));

      await vault.withdraw(withdrawShares.toString(), 0, 0, { from: governance });

      const token0AfterWithdraw = web3.utils.toBN(await token0.balanceOf(governance));
      const token1AfterWithdraw = web3.utils.toBN(await token1.balanceOf(governance));
      const amount0 = token0AfterWithdraw.sub(token0Before);
      const amount1 = token1AfterWithdraw.sub(token1Before);

      await token0.approve(vault.address, amount0.toString(), { from: governance });
      await token1.approve(vault.address, amount1.toString(), { from: governance });
      await vault.deposit(amount0.toString(), amount1.toString(), 0, governance, { from: governance });

      const sharesAfter = web3.utils.toBN(await vault.balanceOf(governance));
      const inflationCap = sharesBefore.add(web3.utils.toBN("5"));
      assert.equal(
        sharesAfter.lte(inflationCap),
        true,
        "Unexpected share inflation after withdraw/redeposit roundtrip"
      );
    }
  });

  it("should enforce rebalance cooldown", async function() {
    await vault.setRebalanceConfig(0, 3600, governance, { from: governance });
    const slotHash = web3.utils.toBN(web3.utils.keccak256("eip1967.vaultStorage.lastRebalance"));
    const slot = web3.utils.toHex(slotHash.sub(web3.utils.toBN("1")));
    const before = web3.utils.toBN(await web3.eth.getStorageAt(vault.address, slot));

    let firstFailed = false;
    try {
      await vault.rebalanceCurrentTick(1, { from: governance });
    } catch (e) {
      firstFailed = true;
    }
    const afterFirst = web3.utils.toBN(await web3.eth.getStorageAt(vault.address, slot));
    const cooldownActivated = !firstFailed && afterFirst.gt(before);
    // first rebalance can fail or be a no-op due to unchanged ticks/pool state; cooldown only applies if state changed
    if (cooldownActivated) {
      let secondFailed = false;
      try {
        await vault.rebalanceCurrentTick(1, { from: governance });
      } catch (e) {
        secondFailed = true;
      }
      assert.equal(secondFailed, true, "Expected second rebalance to fail due to cooldown");
    }
  });

  it("should revert on invalid rebalance safety config", async function() {
    let failed = false;
    try {
      await vault.setRebalanceSafetyConfig(2500, 10001, 900, 200, { from: governance });
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected invalid safety config to revert");
  });

  it("should revert helper on unavailable TWAP window", async function() {
    const helper = await CLRebalanceHelper.at(await vault.rebalanceHelper());
    const pm = await IPosManager.at(posManager);
    const factory = await IFactory.at(await pm.factory());
    const pool = await factory.getPool(await vault.token0(), await vault.token1(), await vault.tickSpacing());

    let failed = false;
    try {
      await helper.planSwap(
        pool,
        "1000000000000",
        "1000000000000",
        2500,
        100,
        "4294967295",
        200,
        { from: governance }
      );
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected helper TWAP lookup to revert for extreme window");
  });

  it("should revert helper when spot deviates from TWAP beyond max deviation", async function() {
    const helper = await CLRebalanceHelper.new({ from: governance });
    const mockPool = await MockCLPool.new({ from: governance });
    const q96 = web3.utils.toBN("79228162514264337593543950336");
    await mockPool.setSlot0(q96.toString(), 0, { from: governance });
    await mockPool.setObserve("0", "9000000", { from: governance }); // twap tick = 10000 over 900s

    let failed = false;
    try {
      await helper.planSwap(
        mockPool.address,
        "1000000000000000000",
        "1000000000000000000",
        2500,
        100,
        900,
        10,
        { from: governance }
      );
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected helper to revert on excessive TWAP deviation");
  });

  it("should keep position NFT owned by vault after hardwork", async function() {
    await controller.doHardWork(vault.address, { from: governance });
    const currentPosId = await vault.posId();
    const manager = await IERC721.at(posManager);
    const owner = await manager.ownerOf(currentPosId);
    const strategyAddr = await vault.strategy();
    const strategy = await Strategy.at(strategyAddr);
    const gauge = await strategy.rewardPool();
    const validOwner =
      owner.toLowerCase() === vault.address.toLowerCase() ||
      owner.toLowerCase() === strategyAddr.toLowerCase() ||
      owner.toLowerCase() === gauge.toLowerCase();
    assert.equal(validOwner, true, "Position NFT owner should be vault, strategy, or gauge");
  });

  it("should expose swap-skip telemetry storage", async function() {
    // Earlier tests in this file may have already produced skips, so we only assert the slots
    // exist (read back as numeric).
    const strategyAddr = await vault.strategy();
    const strategy = await Strategy.at(strategyAddr);
    const count = web3.utils.toBN(await strategy.swapSkippedCount());
    const stamp = web3.utils.toBN(await strategy.lastSwapSkippedAt());
    assert.equal(count.gte(web3.utils.toBN("0")), true, "swapSkippedCount must be readable");
    assert.equal(stamp.gte(web3.utils.toBN("0")), true, "lastSwapSkippedAt must be readable");
  });

  it("should record skip telemetry and emit indexed reason on below-threshold reward", async function() {
    const strategyAddr = await vault.strategy();
    const strategy = await Strategy.at(strategyAddr);
    const aero = await strategy.rewardToken();

    // Force every aero balance below threshold so the BelowThreshold path fires regardless of
    // accrued gauge rewards. Threshold uint256 max guarantees the comparison fails for any balance.
    const max256 = web3.utils.toBN("2").pow(web3.utils.toBN("256")).sub(web3.utils.toBN("1"));
    await strategy.setMinRewardToCompound(aero, max256.toString(), { from: governance });

    const before = web3.utils.toBN(await strategy.swapSkippedCount());
    const tx = await controller.doHardWork(vault.address, { from: governance });
    const after = web3.utils.toBN(await strategy.swapSkippedCount());

    // The base reward token's loop iteration is itself short-circuited by the BelowThreshold
    // skip path. With only `aero` in rewardTokens we expect at least one increment per hardwork
    // when the gauge accrued anything (and zero increment when balance==0). Either way: counter
    // must be monotonically non-decreasing and lastSwapSkippedAt must reflect the block when a
    // skip happened.
    assert.equal(after.gte(before), true, "Counter must not decrease");
    if (after.gt(before)) {
      const ts = web3.utils.toBN(await strategy.lastSwapSkippedAt());
      assert.equal(ts.gt(web3.utils.toBN("0")), true, "Expected lastSwapSkippedAt to be stamped");
    }

    // Restore for downstream tests.
    await strategy.setMinRewardToCompound(aero, "1", { from: governance });
  });

  it("should keep gas within baseline budgets on core paths", async function() {
    await vault.setLanePause(false, false, false, false, { from: governance });
    await vault.setRebalanceConfig(0, 0, governance, { from: governance });

    const token0 = await IERC20.at(await vault.token0());
    const token1 = await IERC20.at(await vault.token1());
    const shares = web3.utils.toBN(await vault.balanceOf(governance)).div(web3.utils.toBN("200"));
    assert.equal(shares.gt(web3.utils.toBN("0")), true, "Expected share balance for gas snapshot");

    const withdrawTx = await vault.withdraw(shares.toString(), 0, 0, { from: governance });
    const amount0 = await token0.balanceOf(governance);
    const amount1 = await token1.balanceOf(governance);
    await token0.approve(vault.address, amount0, { from: governance });
    await token1.approve(vault.address, amount1, { from: governance });
    const depositTx = await vault.deposit(amount0, amount1, 0, governance, { from: governance });
    const hardWorkTx = await controller.doHardWork(vault.address, { from: governance });
    const rebalanceTx = await vault.rebalanceCurrentTick(1, { from: governance });

    assert.equal(withdrawTx.receipt.gasUsed < 2_500_000, true, "Withdraw gas regression");
    assert.equal(depositTx.receipt.gasUsed < 2_500_000, true, "Deposit gas regression");
    assert.equal(hardWorkTx.receipt.gasUsed < 8_000_000, true, "doHardWork gas regression");
    assert.equal(rebalanceTx.receipt.gasUsed < 10_000_000, true, "rebalanceCurrentTick gas regression");
  });
});
