// Comprehensive interaction trace. For every kind of interaction with the CL position
// (deposit/withdraw direct, deposit/redeem via wrapper, doHardWork, rebalance), snapshots
// position state + every contract's idle balances + user state, computes deltas in raw token,
// USD, and %, and prints a clean per-interaction report. Runs against ETH-based and BTC-based
// vaults so both decimals regimes and both UL paths are exercised.
//
// Usage: FORK_BLOCK=32897925 npx hardhat test test/aeroCL/cl-interaction-trace.js

const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");
const Utils = require("../utilities/Utils.js");
const addresses = require("../test-config.js");

const StrategyEth = artifacts.require("AerodromeCLStrategyMainnet_cbETH_ETH1");
const StrategyBtc = artifacts.require("AerodromeCLStrategyMainnet_tBTC_cbBTC1");
const IERC721 = artifacts.require("IERC721");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const CLWrapper = artifacts.require("CLWrapper");

const BN = web3.utils.toBN;
const Q192 = BN("2").pow(BN("192"));
const Q96 = BN("2").pow(BN("96"));
const E18 = BN("10").pow(BN("18"));

// Approximate USD anchors used purely for human-readable reporting. Both sides of each pair are
// at near-parity in their underlying asset, so we use one anchor per pair-class.
const USD = { ETH: 3000, BTC: 50000 };

function fmtRaw(rawBN, decimals) {
  // returns "12.345678" style human string, decimals-aware
  const s = BN(rawBN).toString();
  const padded = s.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).slice(0, Math.min(decimals, 8));
  return intPart + "." + fracPart;
}

function tokenToUsd(rawBN, decimals, usdPerToken) {
  const numerator = parseFloat(BN(rawBN).toString()) * usdPerToken;
  return numerator / Math.pow(10, decimals);
}

function pct(deltaBN, baseBN) {
  if (BN(baseBN).isZero()) return 0;
  // Use BN for the numerator/denominator then convert to float
  const ratio = parseFloat(BN(deltaBN).toString()) / parseFloat(BN(baseBN).toString());
  return ratio * 100;
}

function fmtDelta(beforeBN, afterBN, decimals, usdPerToken, label) {
  const a = BN(beforeBN);
  const b = BN(afterBN);
  const d = b.gt(a) ? b.sub(a) : a.sub(b);
  const sign = b.gt(a) ? "+" : (b.lt(a) ? "-" : " ");
  const dTok = sign + fmtRaw(d, decimals);
  const dUsd = (b.gt(a) ? 1 : (b.lt(a) ? -1 : 0)) * tokenToUsd(d, decimals, usdPerToken);
  const dPctNum = (b.gt(a) ? 1 : (b.lt(a) ? -1 : 0)) * pct(d, a.gt(BN("0")) ? a : BN("1"));
  const beforeT = fmtRaw(a, decimals);
  const afterT = fmtRaw(b, decimals);
  return (
    label.padEnd(28) +
    " | " + beforeT.padStart(20) +
    " -> " + afterT.padStart(20) +
    " | Δ " + dTok.padStart(14) +
    " | $" + dUsd.toFixed(4).padStart(10) +
    " | " + dPctNum.toFixed(4).padStart(8) + "%"
  );
}

async function snap(ctx) {
  const { vault, strategy, wrapper, user, posMgr, pos, token0, token1 } = ctx;
  const slot0 = await posMgr.positions(pos);
  const a0 = BN(slot0.tokensOwed0); // tokensOwed (fees, not amounts)
  // Better: use vault.getCurrentTokenAmounts which queries spot.
  const amounts = await vault.getCurrentTokenAmounts();
  const out = {
    sqrt: BN(await vault.getSqrtPriceX96()),
    posL: BN((await posMgr.positions(pos)).liquidity),
    posA0: BN(amounts[0]),
    posA1: BN(amounts[1]),
    posTokensOwed0: BN((await posMgr.positions(pos)).tokensOwed0),
    posTokensOwed1: BN((await posMgr.positions(pos)).tokensOwed1),
    vaultIdle0: BN(await token0.balanceOf(vault.address)),
    vaultIdle1: BN(await token1.balanceOf(vault.address)),
    strategyIdle0: BN(await token0.balanceOf(strategy.address)),
    strategyIdle1: BN(await token1.balanceOf(strategy.address)),
    wrapperIdle0: wrapper ? BN(await token0.balanceOf(wrapper.address)) : BN("0"),
    wrapperIdle1: wrapper ? BN(await token1.balanceOf(wrapper.address)) : BN("0"),
    userT0: BN(await token0.balanceOf(user)),
    userT1: BN(await token1.balanceOf(user)),
    userShares: BN(await vault.balanceOf(user)),
    supply: BN(await vault.totalSupply()),
    pps: BN(await vault.getPricePerFullShare()),
    navInToken0: BN(await vault.underlyingBalanceWithInvestment()), // L units
  };
  return out;
}

function totalUsd(snap, dec0, dec1, usd) {
  // total tracked token value in USD (position + all contracts + user). Excludes shares since
  // shares are derivative of NAV.
  const t0 = BN(snap.posA0).add(snap.vaultIdle0).add(snap.strategyIdle0).add(snap.wrapperIdle0).add(snap.userT0);
  const t1 = BN(snap.posA1).add(snap.vaultIdle1).add(snap.strategyIdle1).add(snap.wrapperIdle1).add(snap.userT1);
  return tokenToUsd(t0, dec0, usd) + tokenToUsd(t1, dec1, usd);
}

function reportDeltas(label, before, after, dec0, dec1, usd) {
  console.log("\n--- " + label + " ---");
  console.log(
    "field                        |              before |               after | Δ (raw)         | Δ ($)       | Δ %"
  );
  console.log(fmtDelta(before.posA0, after.posA0, dec0, usd, "position amount0"));
  console.log(fmtDelta(before.posA1, after.posA1, dec1, usd, "position amount1"));
  console.log(fmtDelta(before.posL, after.posL, 0, 0, "position liquidity (raw L)"));
  console.log(fmtDelta(before.vaultIdle0, after.vaultIdle0, dec0, usd, "vault idle token0"));
  console.log(fmtDelta(before.vaultIdle1, after.vaultIdle1, dec1, usd, "vault idle token1"));
  console.log(fmtDelta(before.strategyIdle0, after.strategyIdle0, dec0, usd, "strategy idle token0"));
  console.log(fmtDelta(before.strategyIdle1, after.strategyIdle1, dec1, usd, "strategy idle token1"));
  console.log(fmtDelta(before.wrapperIdle0, after.wrapperIdle0, dec0, usd, "wrapper idle token0"));
  console.log(fmtDelta(before.wrapperIdle1, after.wrapperIdle1, dec1, usd, "wrapper idle token1"));
  console.log(fmtDelta(before.userT0, after.userT0, dec0, usd, "user token0"));
  console.log(fmtDelta(before.userT1, after.userT1, dec1, usd, "user token1"));
  console.log(fmtDelta(before.userShares, after.userShares, 0, 0, "user shares"));
  console.log(fmtDelta(before.supply, after.supply, 0, 0, "total supply"));
  console.log(fmtDelta(before.pps, after.pps, 18, 0, "PPS (1e18-scaled)"));
  console.log(fmtDelta(before.posTokensOwed0, after.posTokensOwed0, dec0, usd, "position fees-owed token0"));
  console.log(fmtDelta(before.posTokensOwed1, after.posTokensOwed1, dec1, usd, "position fees-owed token1"));

  const totalBefore = totalUsd(before, dec0, dec1, usd);
  const totalAfter = totalUsd(after, dec0, dec1, usd);
  const delta = totalAfter - totalBefore;
  const lossUsd = -delta;
  console.log(("internal cost (USD value vanished)").padEnd(28) + " : $" + lossUsd.toFixed(4));
}

async function harness(label, posId, posManager, strategyArtifact, dec0, dec1, usdAnchor) {
  describe(label, function() {
    this.timeout(2000000);

    let governance, underlyingWhale;
    let vault, controller, strategy;
    let wrapperT0, wrapperT1;
    let token0, token1;
    let user;
    let posMgr;
    let ctx;

    before(async function() {
      governance = addresses.Governance;
      const accs = await web3.eth.getAccounts();
      user = accs[8];

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
        strategyArtifact,
        strategyArtifactIsUpgradable: true,
        governance,
      });

      token0 = await IERC20.at(await vault.token0());
      token1 = await IERC20.at(await vault.token1());
      posMgr = await IPosManager.at(posManager);

      await vault.setLanePause(false, false, false, false, { from: governance });
      await vault.setRebalanceConfig(0, 0, governance, { from: governance });

      wrapperT0 = await CLWrapper.new(addresses.Storage, vault.address, true, { from: governance });
      wrapperT1 = await CLWrapper.new(addresses.Storage, vault.address, false, { from: governance });

      ctx = { vault, strategy, wrapper: null, user, posMgr, pos: posId, token0, token1 };
    });

    // Snapshot wrapping that lets us swap which wrapper to track.
    function snapAll(wrapper) {
      ctx.wrapper = wrapper;
      return snap(ctx);
    }

    // ---- helpers ----

    async function fundUser(divisor, isToken0, dumpOther = true) {
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
        if (dumpOther && dt1.gt(BN("0"))) await token1.transfer(governance, dt1.toString(), { from: governance });
        return dt0;
      }
      if (dt1.gt(BN("0"))) await token1.transfer(user, dt1.toString(), { from: governance });
      if (dumpOther && dt0.gt(BN("0"))) await token0.transfer(governance, dt0.toString(), { from: governance });
      return dt1;
    }

    async function returnToGov() {
      // sweep any user holdings back to governance so each interaction starts from a clean slate.
      const t0 = await token0.balanceOf(user);
      const t1 = await token1.balanceOf(user);
      const sh = await vault.balanceOf(user);
      if (BN(t0).gt(BN("0"))) await token0.transfer(governance, t0.toString(), { from: user });
      if (BN(t1).gt(BN("0"))) await token1.transfer(governance, t1.toString(), { from: user });
      if (BN(sh).gt(BN("0"))) await vault.transfer(governance, sh.toString(), { from: user });
    }

    // ---- direct vault interactions ----

    it("traces direct vault.deposit at 3 sizes", async function() {
      const sizes = [{ div: 100, label: "~1% NAV (medium)" }, { div: 20, label: "~5% NAV (large)" }, { div: 4, label: "~25% NAV (whale)" }];
      for (const s of sizes) {
        // First withdraw a slice (gives both tokens), then redeposit both. Using the wrapper-less
        // path so we measure pure vault behaviour.
        const slice = BN(await vault.balanceOf(governance)).div(BN(s.div));
        if (slice.isZero()) continue;
        await vault.withdraw(slice.toString(), 0, 0, { from: governance });
        const a0 = BN(await token0.balanceOf(governance));
        const a1 = BN(await token1.balanceOf(governance));
        if (a0.isZero() || a1.isZero()) continue;
        // Move to user so the trace shows user-side change.
        await token0.transfer(user, a0.toString(), { from: governance });
        await token1.transfer(user, a1.toString(), { from: governance });

        const before = await snapAll(null);
        await token0.approve(vault.address, a0.toString(), { from: user });
        await token1.approve(vault.address, a1.toString(), { from: user });
        await vault.deposit(a0.toString(), a1.toString(), 0, user, { from: user });
        const after = await snapAll(null);
        reportDeltas("vault.deposit (" + s.label + ", inputs: " + fmtRaw(a0, dec0) + " t0 + " + fmtRaw(a1, dec1) + " t1)", before, after, dec0, dec1, usdAnchor);
        await returnToGov();
      }
    });

    it("traces direct vault.withdraw at 3 sizes", async function() {
      const sizes = [{ div: 100, label: "~1% supply" }, { div: 20, label: "~5% supply" }, { div: 4, label: "~25% supply" }];
      for (const s of sizes) {
        const slice = BN(await vault.balanceOf(governance)).div(BN(s.div));
        if (slice.isZero()) continue;
        await vault.transfer(user, slice.toString(), { from: governance });
        const before = await snapAll(null);
        await vault.withdraw(slice.toString(), 0, 0, { from: user });
        const after = await snapAll(null);
        reportDeltas("vault.withdraw (" + s.label + ", " + slice.toString() + " shares)", before, after, dec0, dec1, usdAnchor);
        await returnToGov();
      }
    });

    // ---- wrapper interactions ----

    async function traceWrapperDeposit(wrapper, divisor, label) {
      const isToken0 = (await wrapper.asset()) === (await vault.token0());
      const sizeAsset = await fundUser(divisor, isToken0);
      if (sizeAsset.isZero()) {
        console.log("\n[skipping " + label + " — funded zero]");
        return;
      }
      const before = await snapAll(wrapper);
      const assetTok = isToken0 ? token0 : token1;
      await assetTok.approve(wrapper.address, sizeAsset.toString(), { from: user });
      let depositErr = null;
      try {
        await wrapper.methods["deposit(uint256,address,uint256)"](sizeAsset.toString(), user, "0", { from: user });
      } catch (e) {
        depositErr = String(e.message || e).split("\n")[0];
      }
      const after = await snapAll(wrapper);
      const tag = depositErr ? " [REVERTED: " + depositErr.slice(0, 60) + "]" : "";
      reportDeltas("wrapper.deposit (" + label + ", asset=" + (isToken0 ? "token0" : "token1") + ", " + fmtRaw(sizeAsset, isToken0 ? dec0 : dec1) + " " + (isToken0 ? "t0" : "t1") + ")" + tag, before, after, dec0, dec1, usdAnchor);
      await returnToGov();
    }

    async function traceWrapperRedeem(wrapper, divisor, label) {
      const isToken0 = (await wrapper.asset()) === (await vault.token0());
      // Acquire shares first via wrapper.deposit (so the user has shares to redeem).
      const sizeAsset = await fundUser(divisor, isToken0);
      if (sizeAsset.isZero()) return;
      const assetTok = isToken0 ? token0 : token1;
      await assetTok.approve(wrapper.address, sizeAsset.toString(), { from: user });
      try {
        await wrapper.methods["deposit(uint256,address,uint256)"](sizeAsset.toString(), user, "0", { from: user });
      } catch (e) {
        console.log("\n[skipping wrapper.redeem " + label + " — deposit reverted: " + String(e.message || e).split("\n")[0].slice(0, 50) + "]");
        await returnToGov();
        return;
      }
      const userShares = BN(await vault.balanceOf(user));
      if (userShares.isZero()) return;
      await vault.approve(wrapper.address, userShares.toString(), { from: user });
      const before = await snapAll(wrapper);
      let redeemErr = null;
      try {
        await wrapper.methods["redeem(uint256,address,address,uint256)"](userShares.toString(), user, user, "0", { from: user });
      } catch (e) {
        redeemErr = String(e.message || e).split("\n")[0];
      }
      const after = await snapAll(wrapper);
      const tag = redeemErr ? " [REVERTED: " + redeemErr.slice(0, 60) + "]" : "";
      reportDeltas("wrapper.redeem (" + label + ", asset=" + (isToken0 ? "token0" : "token1") + ", " + userShares.toString() + " shares)" + tag, before, after, dec0, dec1, usdAnchor);
      await returnToGov();
    }

    it("traces wrapper.deposit (asset=token0) at 3 sizes", async function() {
      await traceWrapperDeposit(wrapperT0, 100, "~1% NAV");
      await traceWrapperDeposit(wrapperT0, 20, "~5% NAV");
      await traceWrapperDeposit(wrapperT0, 4, "~25% NAV");
    });

    it("traces wrapper.deposit (asset=token1) at 3 sizes", async function() {
      await traceWrapperDeposit(wrapperT1, 100, "~1% NAV");
      await traceWrapperDeposit(wrapperT1, 20, "~5% NAV");
      await traceWrapperDeposit(wrapperT1, 4, "~25% NAV");
    });

    it("traces wrapper.redeem (asset=token0) at 3 sizes (via deposit first)", async function() {
      await traceWrapperRedeem(wrapperT0, 100, "~1% NAV");
      await traceWrapperRedeem(wrapperT0, 20, "~5% NAV");
    });

    it("traces wrapper.redeem (asset=token1) at 3 sizes (via deposit first)", async function() {
      await traceWrapperRedeem(wrapperT1, 100, "~1% NAV");
      await traceWrapperRedeem(wrapperT1, 20, "~5% NAV");
    });

    // ---- operational interactions ----

    it("traces doHardWork (cold + warm)", async function() {
      const beforeCold = await snapAll(null);
      let coldErr = null;
      try {
        await controller.doHardWork(vault.address, { from: governance });
      } catch (e) {
        coldErr = String(e.message || e).split("\n")[0];
      }
      const afterCold = await snapAll(null);
      reportDeltas("doHardWork [cold]" + (coldErr ? " [REVERTED: " + coldErr.slice(0, 50) + "]" : ""), beforeCold, afterCold, dec0, dec1, usdAnchor);

      // Advance ~1 hour so the gauge accrues something between hardworks.
      await Utils.advanceNBlock(1800);

      const beforeWarm = await snapAll(null);
      let warmErr = null;
      try {
        await controller.doHardWork(vault.address, { from: governance });
      } catch (e) {
        warmErr = String(e.message || e).split("\n")[0];
      }
      const afterWarm = await snapAll(null);
      reportDeltas("doHardWork [warm, +1h advance]" + (warmErr ? " [REVERTED: " + warmErr.slice(0, 50) + "]" : ""), beforeWarm, afterWarm, dec0, dec1, usdAnchor);
    });

    it("traces rebalanceCurrentTick", async function() {
      const before = await snapAll(null);
      let err = null;
      try {
        await vault.rebalanceCurrentTick(1, { from: governance });
      } catch (e) {
        err = String(e.message || e).split("\n")[0];
      }
      const after = await snapAll(null);
      reportDeltas("rebalanceCurrentTick(1)" + (err ? " [REVERTED: " + err.slice(0, 50) + "]" : ""), before, after, dec0, dec1, usdAnchor);
    });

    // ---- edge cases ----

    it("edge: tiny single-wei deposit (asset=token0)", async function() {
      // Send user 1 wei of token0 + 1 wei of token1 and try a direct vault.deposit. Expectation:
      // ErrZeroShares because the resulting L is below 1.
      await token0.transfer(user, "1", { from: governance });
      await token1.transfer(user, "1", { from: governance });
      const before = await snapAll(null);
      await token0.approve(vault.address, "1", { from: user });
      await token1.approve(vault.address, "1", { from: user });
      let err = null;
      try {
        await vault.deposit("1", "1", 0, user, { from: user });
      } catch (e) {
        err = String(e.message || e).split("\n")[0];
      }
      const after = await snapAll(null);
      reportDeltas("edge: 1-wei deposit" + (err ? " [REVERTED: " + err.slice(0, 50) + "]" : ""), before, after, dec0, dec1, usdAnchor);
      await returnToGov();
    });

    it("edge: deposit only token0 (a1=0)", async function() {
      const slice = BN(await vault.balanceOf(governance)).div(BN("100"));
      await vault.withdraw(slice.toString(), 0, 0, { from: governance });
      const a0 = BN(await token0.balanceOf(governance));
      const a1 = BN(await token1.balanceOf(governance));
      if (a1.gt(BN("0"))) await token1.transfer(governance, a1.toString(), { from: governance }); // dump
      await token0.transfer(user, a0.toString(), { from: governance });
      const before = await snapAll(null);
      await token0.approve(vault.address, a0.toString(), { from: user });
      let err = null;
      try {
        await vault.deposit(a0.toString(), "0", 0, user, { from: user });
      } catch (e) {
        err = String(e.message || e).split("\n")[0];
      }
      const after = await snapAll(null);
      reportDeltas("edge: deposit a1=0" + (err ? " [REVERTED: " + err.slice(0, 50) + "]" : ""), before, after, dec0, dec1, usdAnchor);
      await returnToGov();
    });

    it("edge: wrapper.deposit just below the truncation guard", async function() {
      // Compute the smallest size that would clear (intended * 99 > 100*1e18) etc.
      // For asset=token0, intended = assets * w1. Want intended/100 >= leftover, so we need
      // assets such that (assets * w1) / 1e18 has truncation < 1% of intended. Easiest: just try
      // a few sizes around the threshold.
      for (const div of [10000, 5000, 2000, 1000, 500]) {
        const sizeAsset = await fundUser(div, true, true);
        if (sizeAsset.isZero()) {
          console.log("[" + div + "] funded zero, skip");
          continue;
        }
        const before = await snapAll(wrapperT0);
        await token0.approve(wrapperT0.address, sizeAsset.toString(), { from: user });
        let err = null;
        try {
          await wrapperT0.methods["deposit(uint256,address,uint256)"](sizeAsset.toString(), user, "0", { from: user });
        } catch (e) {
          err = String(e.message || e).split("\n")[0];
        }
        const after = await snapAll(wrapperT0);
        const tag = err ? " [REVERTED: " + err.slice(0, 50) + "]" : "";
        reportDeltas("edge: wrapper.deposit div=1/" + div + " (size " + fmtRaw(sizeAsset, dec0) + " t0)" + tag, before, after, dec0, dec1, usdAnchor);
        await returnToGov();
      }
    });
  });
}

harness("ETH-based vault [cbETH/ETH1]", 19447757, "0x827922686190790b37229fd06084350E74485b72", StrategyEth, 18, 18, USD.ETH);
harness("BTC-based vault [tBTC/cbBTC1]", 19450559, "0x827922686190790b37229fd06084350E74485b72", StrategyBtc, 18, 8, USD.BTC);
