// Diagnostic: isolate the source of the BTC-vault wrapper's high haircut.
// Walks raw UL.swap calls (bypassing the wrapper) at multiple sizes for both directions,
// compares to the vault's pool spot price, and prints per-leg slippage.
const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const Strategy = artifacts.require("AerodromeCLStrategyMainnet_tBTC_cbBTC1");
const IERC721 = artifacts.require("IERC721");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IUniversalLiquidator = artifacts.require("IUniversalLiquidator");
const IController = artifacts.require("IController");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const IFactory = artifacts.require("IFactory");
const IPool = artifacts.require("contracts/base/interface/concentrated-liquidity/IPool.sol:IPool");

const BN = web3.utils.toBN;
const Q96 = BN("2").pow(BN("96"));
const Q192 = BN("2").pow(BN("192"));

describe("BTC vault diagnostic [tBTC/cbBTC1]", function() {
  this.timeout(2000000);

  let governance;
  let underlyingWhale;
  const posId = 19450559;
  const posManager = "0x827922686190790b37229fd06084350E74485b72";
  let vault;
  let strategy;
  let controller;
  let token0; // tBTC
  let token1; // cbBTC
  let ulAddr;
  let pool;
  let user;
  const rows = [];

  before(async function() {
    governance = addresses.Governance;
    const accs = await web3.eth.getAccounts();
    user = accs[6];

    const nft = await IERC721.at(posManager);
    underlyingWhale = await nft.ownerOf(posId);
    await impersonates([governance, underlyingWhale]);
    for (const a of [governance, underlyingWhale, user]) {
      await hre.network.provider.request({
        method: "hardhat_setBalance",
        params: [a, "0x8AC7230489E80000"],
      });
    }
    if (underlyingWhale.toLowerCase() !== governance.toLowerCase()) {
      await nft.transferFrom(underlyingWhale, governance, posId, { from: underlyingWhale });
    }

    [controller, vault, strategy] = await setupCoreProtocol({
      CLVault: true,
      CLSetup: { posId, posManager, targetWidth: 1 },
      existingVaultAddress: null,
      strategyArtifact: Strategy,
      strategyArtifactIsUpgradable: true,
      governance,
    });

    await vault.setLanePause(false, false, false, false, { from: governance });
    await vault.setRebalanceConfig(0, 0, governance, { from: governance });

    token0 = await IERC20.at(await vault.token0());
    token1 = await IERC20.at(await vault.token1());

    const ctrl = await IController.at(await vault.controller());
    ulAddr = await ctrl.universalLiquidator();

    const pm = await IPosManager.at(posManager);
    const factory = await IFactory.at(await pm.factory());
    const poolAddr = await factory.getPool(await vault.token0(), await vault.token1(), await vault.tickSpacing());
    pool = await IPool.at(poolAddr);
  });

  // Pull tokens for the user from governance via vault.withdraw of a slice.
  async function fundUser(divisor, isToken0) {
    const govShares = BN(await vault.balanceOf(governance));
    const slice = govShares.div(BN(divisor));
    if (slice.isZero()) return BN("0");
    const t0Before = BN(await token0.balanceOf(governance));
    const t1Before = BN(await token1.balanceOf(governance));
    await vault.withdraw(slice.toString(), 0, 0, { from: governance });
    const dt0 = BN(await token0.balanceOf(governance)).sub(t0Before);
    const dt1 = BN(await token1.balanceOf(governance)).sub(t1Before);
    if (isToken0) {
      if (dt0.gt(BN("0"))) await token0.transfer(user, dt0.toString(), { from: governance });
      return dt0;
    }
    if (dt1.gt(BN("0"))) await token1.transfer(user, dt1.toString(), { from: governance });
    return dt1;
  }

  function fmtDec(rawBN, decimals) {
    const s = rawBN.toString();
    const padded = s.padStart(decimals + 1, "0");
    const intPart = padded.slice(0, padded.length - decimals);
    const fracPart = padded.slice(padded.length - decimals).slice(0, 6);
    return intPart + "." + fracPart;
  }

  it("pool snapshot: ticks, sqrtPrice, position liquidity", async function() {
    const slot0 = await pool.slot0();
    const sqrt = BN(slot0[0].toString());
    const tick = parseInt(slot0[1]);
    const tickLower = parseInt(await vault.tickLower());
    const tickUpper = parseInt(await vault.tickUpper());
    const inRange = tick > tickLower && tick < tickUpper;

    const navUnderlying = BN(await vault.underlyingBalanceWithInvestment());
    const ts = BN(await vault.totalSupply());
    const weights = await vault.getCurrentTokenWeights();
    const amounts = await vault.getCurrentTokenAmounts();
    const a0 = BN(amounts[0]);
    const a1 = BN(amounts[1]);

    // sqrt^2 / 2^192 gives token1_per_token0 in raw units. With t0=18d, t1=8d, expect ratio ≈ 1e-10
    // for 1:1 BTC parity.
    console.log("\n--- BTC pool snapshot ---");
    console.log("pool address    :", pool.address);
    console.log("pool fee (hun-bps):", parseInt(await pool.fee()));
    console.log("currentTick     :", tick);
    console.log("range           : [" + tickLower + ", " + tickUpper + "]");
    console.log("in-range        :", inRange);
    console.log("sqrtPriceX96    :", sqrt.toString());
    console.log("position amount0 (tBTC, 18d):", fmtDec(a0, 18));
    console.log("position amount1 (cbBTC, 8d):", fmtDec(a1, 8));
    console.log("position weights w0/w1      :", (parseFloat(weights[0])/1e18).toFixed(4), "/", (parseFloat(weights[1])/1e18).toFixed(4));
    console.log("vault NAV (underlying L)    :", navUnderlying.toString());
    console.log("totalSupply                 :", ts.toString());
  });

  // For a swap of `amountIn` tokenIn → tokenOut at the pool's spot price (no fee, no impact),
  // returns expected amountOut.
  async function spotQuote(amountIn, isInToken0) {
    const slot0 = await pool.slot0();
    const sqrt = BN(slot0[0].toString());
    if (isInToken0) {
      // amountOut1 = amountIn0 * sqrt^2 / 2^192
      const step = BN(amountIn).mul(sqrt).div(Q96);
      return step.mul(sqrt).div(Q96);
    } else {
      // amountOut0 = amountIn1 * 2^192 / sqrt^2
      const step = BN(amountIn).mul(Q96).div(sqrt);
      return step.mul(Q96).div(sqrt);
    }
  }

  async function ulSwap(tokenIn, tokenOut, amountIn) {
    const ul = await IUniversalLiquidator.at(ulAddr);
    const tokenInContract = (await tokenIn.address.toLowerCase()) === (token0.address.toLowerCase()) ? token0 : token1;
    const tokenOutContract = tokenInContract === token0 ? token1 : token0;
    await tokenInContract.approve(ulAddr, amountIn.toString(), { from: user });
    const outBefore = BN(await tokenOutContract.balanceOf(user));
    let err = null;
    try {
      await ul.swap(tokenInContract.address, tokenOutContract.address, amountIn.toString(), 1, user, { from: user });
    } catch (e) {
      err = String(e.message || e).split("\n")[0];
    }
    const outAfter = BN(await tokenOutContract.balanceOf(user));
    return { received: outAfter.sub(outBefore), err };
  }

  it("walks UL.swap sizes for tBTC -> cbBTC and cbBTC -> tBTC", async function() {
    // Sizes as a fraction of governance shares (vault NAV proxy)
    const divisors = [10000, 1000, 100, 10, 4];
    for (const dir of [{ in: token0, out: token1, dirLabel: "tBTC -> cbBTC", isInToken0: true },
                       { in: token1, out: token0, dirLabel: "cbBTC -> tBTC", isInToken0: false }]) {
      for (const d of divisors) {
        const sizeIn = await fundUser(d, dir.isInToken0);
        if (sizeIn.isZero()) continue;
        const expected = await spotQuote(sizeIn, dir.isInToken0);
        const { received, err } = await ulSwap(dir.in, dir.out, sizeIn);
        const lossBps = (!err && expected.gt(BN("0")) && expected.gte(received))
          ? expected.sub(received).mul(BN("10000")).div(expected).toNumber()
          : null;
        rows.push({
          dir: dir.dirLabel,
          divisor: d,
          inDec: dir.isInToken0 ? 18 : 8,
          outDec: dir.isInToken0 ? 8 : 18,
          sizeIn: sizeIn.toString(),
          sizeInPretty: fmtDec(sizeIn, dir.isInToken0 ? 18 : 8),
          expected: expected.toString(),
          expectedPretty: fmtDec(expected, dir.isInToken0 ? 8 : 18),
          received: received.toString(),
          receivedPretty: fmtDec(received, dir.isInToken0 ? 8 : 18),
          lossBps: err ? "ERR" : lossBps,
          err,
        });

        // dump leftover received side back to governance.
        const leftover = await dir.out.balanceOf(user);
        if (BN(leftover).gt(BN("0"))) await dir.out.transfer(governance, leftover.toString(), { from: user });
        const leftoverIn = await dir.in.balanceOf(user);
        if (BN(leftoverIn).gt(BN("0"))) await dir.in.transfer(governance, leftoverIn.toString(), { from: user });
      }
    }
  });

  after(function() {
    console.log("\n========================================");
    console.log("BTC swap-path diagnostic (UL.swap direct)");
    console.log("========================================");
    console.log(
      "direction        | divisor | sizeIn               | expected@spot       | received            | loss"
    );
    console.log(
      "-----------------|---------|----------------------|---------------------|---------------------|------"
    );
    for (const r of rows) {
      console.log(
        r.dir.padEnd(16) + " | " +
        ("1/" + r.divisor).padStart(7) + " | " +
        r.sizeInPretty.padStart(20) + " | " +
        r.expectedPretty.padStart(19) + " | " +
        r.receivedPretty.padStart(19) + " | " +
        ((r.lossBps === null ? "—" : r.lossBps + " bps") + (r.err ? " (" + r.err.slice(0, 40) + ")" : ""))
      );
    }
    console.log("========================================\n");
  });
});
