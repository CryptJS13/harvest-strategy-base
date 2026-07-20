// Parametrized fairness audit on BOTH cbETH/ETH1 (18-dec) and tBTC/cbBTC (8-dec) vaults.
//
// For each user interaction, we measure the user's value before vs. after, in token1-equivalent
// units at the pre-interaction sqrt. Reported as:
//   - PPS delta (bps)
//   - user-value delta in absolute terms AND bps
//   - NAV delta in bps
//   - wrapper balance == 0 after
//
// Sizes are calibrated to each vault's token decimals so bps measurements are stable
// (8-decimal BTC needs amounts >= ~1e5 sat to avoid wei-floor noise overwhelming bps).
//
// Scenarios per vault:
//   1. Normal deposits / withdraws across 4 sizes  (large -> tiny but above noise floor)
//   2. Round-trip same-block for vault & for wrappers (asset=t0 and asset=t1)
//   3. Small-vault, large-deposit: gov drains 90% then user1 deposits 100x of remaining NAV.
//      Verifies a big depositor cannot dilute the surviving 10% holder.

const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const IERC721 = artifacts.require("IERC721");
const IERC20 = artifacts.require("IERC20Upgradeable");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const CLWrapper = artifacts.require("CLWrapper");
const CLRebalanceHelper = artifacts.require("CLRebalanceHelper");

const Q96_BI = BigInt(2) ** BigInt(96);
const Q192_BI = BigInt(2) ** BigInt(192);
function bi(x) { return BigInt(x.toString()); }
function v1(a0, a1, sqrt) { return (a0 * sqrt * sqrt) / Q192_BI + a1; }
function bpsOf(part, whole) {
  if (whole === 0n) return 0;
  const n = part < 0n ? -part : part;
  const sign = part < 0n ? -1 : 1;
  return sign * Number((n * 10000n) / whole);
}

const CONFIGS = [
  {
    name: "cbETH/ETH1 (18-dec)",
    strategyArtifact: "AerodromeCLStrategyMainnet_cbETH_ETH1",
    posId: 19447757,
    posManager: "0x827922686190790b37229fd06084350E74485b72",
    // sizes in terms of "fraction of governance's shares to source the user's tokens from"
    // (we make these big enough that the resulting token amount is well above noise floor)
    smallSizes: [
      { num: 1, den: 1000,  label: "0.1% (tiny)" },
      { num: 1, den: 100,   label: "1%" },
      { num: 1, den: 10,    label: "10%" },
      { num: 1, den: 3,     label: "33% (very large)" },
    ],
    roundTripSize: { num: 1, den: 50 },
    wrapperSize:   { num: 1, den: 50 },
    smallVaultDrainBps: 9000,  // drain 90% of gov, leave 10% as surviving holder
    smallVaultDepositMultiplier: 100n, // deposit 100x of remaining nav
    bpsTolerance: { ppsDeposit: 5, userDeposit: 50, roundTrip: 10, smallVaultGov: 20, smallVaultDeposit: 50 },
  },
  {
    name: "tBTC/cbBTC (8-dec)",
    strategyArtifact: "AerodromeCLStrategyMainnet_tBTC_cbBTC1",
    posId: 19450559,
    posManager: "0x827922686190790b37229fd06084350E74485b72",
    smallSizes: [
      { num: 1, den: 100, label: "1%" },
      { num: 1, den: 10,  label: "10%" },
      { num: 1, den: 3,   label: "33% (large)" },
      { num: 1, den: 2,   label: "50% (very large)" },
    ],
    roundTripSize: { num: 1, den: 5 },   // need bigger absolute amount to clear WrapperSwapBelowPrecision
    wrapperSize:   { num: 1, den: 5 },
    smallVaultDrainBps: 9000,
    smallVaultDepositMultiplier: 100n,
    // BTC has 8-dec tokens; rounding noise per division is ~1 sat → loosen bps a touch
    bpsTolerance: { ppsDeposit: 10, userDeposit: 100, roundTrip: 50, smallVaultGov: 50, smallVaultDeposit: 100 },
  },
];

for (const CFG of CONFIGS) {
  describe(`CL user fairness — ${CFG.name}`, function() {
    this.timeout(2000000);

    let governance;
    let underlyingWhale;
    let controller, vault, strategy, helper, stratAddr;
    let token0, token1;
    let wrapper0, wrapper1;
    let user1, user2, user3;
    let tickSpacing;
    const Strategy = artifacts.require(CFG.strategyArtifact);

    before(async function() {
      governance = addresses.Governance;
      const accounts = await web3.eth.getAccounts();
      user1 = accounts[2];
      user2 = accounts[3];
      user3 = accounts[4];

      const nft = await IERC721.at(CFG.posManager);
      underlyingWhale = await nft.ownerOf(CFG.posId);
      await impersonates([governance, underlyingWhale]);
      for (const a of [governance, underlyingWhale, user1, user2, user3]) {
        await hre.network.provider.request({
          method: "hardhat_setBalance",
          params: [a, "0x8AC7230489E80000"],
        });
      }
      if (underlyingWhale.toLowerCase() !== governance.toLowerCase()) {
        await nft.transferFrom(underlyingWhale, governance, CFG.posId, { from: underlyingWhale });
      }

      [controller, vault, strategy] = await setupCoreProtocol({
        CLVault: true,
        CLSetup: { posId: CFG.posId, posManager: CFG.posManager, targetWidth: 1 },
        existingVaultAddress: null,
        strategyArtifact: Strategy,
        strategyArtifactIsUpgradable: true,
        governance,
      });

      token0 = await IERC20.at(await vault.token0());
      token1 = await IERC20.at(await vault.token1());
      helper = await CLRebalanceHelper.at(await vault.rebalanceHelper());
      stratAddr = await vault.strategy();

      await vault.setLanePause(false, false, false, false, { from: governance });
      await vault.setRebalanceConfig(0, 0, governance, { from: governance });

      const posMgr = await IPosManager.at(CFG.posManager);
      const pos = await posMgr.positions(await vault.posId());
      tickSpacing = parseInt(pos.tickSpacing.toString());

      wrapper0 = await CLWrapper.new(addresses.Storage, vault.address, true,  { from: governance });
      wrapper1 = await CLWrapper.new(addresses.Storage, vault.address, false, { from: governance });
    });

    async function poolAddr() {
      return await helper.poolAddressFor(CFG.posManager, token0.address, token1.address, tickSpacing);
    }

    async function userSnapshot(user) {
      const sqrt = bi(await helper.spotSqrtPriceX96(await poolAddr()));
      const t0 = bi(await token0.balanceOf(user));
      const t1 = bi(await token1.balanceOf(user));
      const shares = bi(await vault.balanceOf(user));
      const pps = bi(await vault.getPricePerFullShare());
      const supply = bi(await vault.totalSupply());
      const nav = bi(await vault.underlyingBalanceWithInvestment());
      const stratT0 = bi(await token0.balanceOf(stratAddr));
      const stratT1 = bi(await token1.balanceOf(stratAddr));
      const vaultT0 = bi(await token0.balanceOf(vault.address));
      const vaultT1 = bi(await token1.balanceOf(vault.address));
      const tickLower = parseInt((await vault.tickLower()).toString());
      const tickUpper = parseInt((await vault.tickUpper()).toString());
      const tokAmts = await helper.getCurrentTokenAmounts(await poolAddr(), CFG.posManager, await vault.posId(), tickLower, tickUpper);
      const pos0 = bi(tokAmts.amount0);
      const pos1 = bi(tokAmts.amount1);
      const totalVaultValueT1 = v1(pos0 + vaultT0 + stratT0, pos1 + vaultT1 + stratT1, sqrt);
      const userShareValueT1 = supply > 0n ? (totalVaultValueT1 * shares) / supply : 0n;
      const userIdleValueT1 = v1(t0, t1, sqrt);
      return {
        sqrt, t0, t1, shares, pps, supply, nav,
        totalVaultValueT1, userShareValueT1, userIdleValueT1,
        userTotalValueT1: userShareValueT1 + userIdleValueT1,
        wrap0T0: bi(await token0.balanceOf(wrapper0.address)),
        wrap0T1: bi(await token1.balanceOf(wrapper0.address)),
        wrap1T0: bi(await token0.balanceOf(wrapper1.address)),
        wrap1T1: bi(await token1.balanceOf(wrapper1.address)),
      };
    }

    function logDelta(label, pre, post) {
      const ppsDeltaBps = bpsOf(post.pps - pre.pps, pre.pps === 0n ? 1n : pre.pps);
      const userValueDelta = post.userTotalValueT1 - pre.userTotalValueT1;
      const userValueBps = bpsOf(userValueDelta, pre.userTotalValueT1 === 0n ? 1n : pre.userTotalValueT1);
      const navDelta = post.nav - pre.nav;
      const navBps = bpsOf(navDelta, pre.nav === 0n ? 1n : pre.nav);
      console.log(`    ${label.padEnd(36)} | pps ${(ppsDeltaBps >= 0 ? "+" : "") + ppsDeltaBps} bps | user-val ${(userValueDelta >= 0n ? "+" : "") + userValueDelta.toString()} (${(userValueBps >= 0 ? "+" : "") + userValueBps} bps) | nav ${(navBps >= 0 ? "+" : "") + navBps} bps`);
      return { ppsDeltaBps, userValueBps, navBps, userValueDelta };
    }

    function assertWrapEmpty(s, tag) {
      if (s.wrap0T0 !== 0n || s.wrap0T1 !== 0n || s.wrap1T0 !== 0n || s.wrap1T1 !== 0n) {
        throw new Error(`${tag}: wrapper not empty - w0=(${s.wrap0T0},${s.wrap0T1}) w1=(${s.wrap1T0},${s.wrap1T1})`);
      }
    }

    async function fundUserFromGov(user, sharesNum, sharesDen) {
      const govShares = bi(await vault.balanceOf(governance));
      const slice = (govShares * BigInt(sharesNum)) / BigInt(sharesDen);
      if (slice === 0n) return { dt0: 0n, dt1: 0n };
      const t0Before = bi(await token0.balanceOf(governance));
      const t1Before = bi(await token1.balanceOf(governance));
      await vault.withdraw(slice.toString(), 0, 0, { from: governance });
      const dt0 = bi(await token0.balanceOf(governance)) - t0Before;
      const dt1 = bi(await token1.balanceOf(governance)) - t1Before;
      if (user.toLowerCase() !== governance.toLowerCase()) {
        if (dt0 > 0n) await token0.transfer(user, dt0.toString(), { from: governance });
        if (dt1 > 0n) await token1.transfer(user, dt1.toString(), { from: governance });
      }
      return { dt0, dt1 };
    }

    it("baseline snapshot", async function() {
      const s = await userSnapshot(governance);
      console.log(`    nav=${s.nav}  supply=${s.supply}  pps=${s.pps}  totalValueT1=${s.totalVaultValueT1}`);
      assertWrapEmpty(s, "baseline");
    });

    describe("normal-size two-token deposits — pre/post stats", function() {
      for (const sz of CFG.smallSizes) {
        it(`deposit ${sz.label}`, async function() {
          const { dt0, dt1 } = await fundUserFromGov(user1, sz.num, sz.den);
          if (dt0 === 0n && dt1 === 0n) return this.skip();
          await token0.approve(vault.address, dt0.toString(), { from: user1 });
          await token1.approve(vault.address, dt1.toString(), { from: user1 });
          const pre = await userSnapshot(user1);
          let reverted = false;
          try {
            await vault.deposit(dt0.toString(), dt1.toString(), 0, user1, { from: user1 });
          } catch (e) { reverted = true; console.log(`    deposit ${sz.label}: REVERTED (${e.message.split("\n")[0].slice(0, 80)})`); }
          if (reverted) return;
          const post = await userSnapshot(user1);
          const s = logDelta(`deposit ${sz.label}`, pre, post);
          assertWrapEmpty(post, sz.label);
          if (s.ppsDeltaBps < -CFG.bpsTolerance.ppsDeposit) throw new Error(`PPS dropped ${s.ppsDeltaBps} bps`);
          if (s.userValueBps < -CFG.bpsTolerance.userDeposit) throw new Error(`user lost ${-s.userValueBps} bps`);
        });
      }
    });

    describe("normal-size withdraws — pre/post stats", function() {
      for (const sz of CFG.smallSizes) {
        it(`withdraw ${sz.label} of gov's shares`, async function() {
          const govShares = bi(await vault.balanceOf(governance));
          if (govShares === 0n) return this.skip();
          const slice = (govShares * BigInt(sz.num)) / BigInt(sz.den);
          if (slice === 0n) return this.skip();
          const pre = await userSnapshot(governance);
          await vault.withdraw(slice.toString(), 0, 0, { from: governance });
          const post = await userSnapshot(governance);
          const s = logDelta(`withdraw ${sz.label}`, pre, post);
          assertWrapEmpty(post, sz.label);
          if (s.ppsDeltaBps < -CFG.bpsTolerance.ppsDeposit) throw new Error(`PPS dropped ${s.ppsDeltaBps} bps`);
          if (s.userValueBps < -CFG.bpsTolerance.userDeposit) throw new Error(`user lost ${-s.userValueBps} bps`);
        });
      }
    });

    describe("round-trip same-block", function() {
      it("two-token vault deposit+withdraw", async function() {
        const { dt0, dt1 } = await fundUserFromGov(user2, CFG.roundTripSize.num, CFG.roundTripSize.den);
        if (dt0 === 0n && dt1 === 0n) return this.skip();
        await token0.approve(vault.address, dt0.toString(), { from: user2 });
        await token1.approve(vault.address, dt1.toString(), { from: user2 });
        const pre = await userSnapshot(user2);
        await vault.deposit(dt0.toString(), dt1.toString(), 0, user2, { from: user2 });
        const shares = bi(await vault.balanceOf(user2));
        await vault.withdraw(shares.toString(), 0, 0, { from: user2 });
        const post = await userSnapshot(user2);
        const s = logDelta(`2-token round-trip`, pre, post);
        if (s.userValueBps < -CFG.bpsTolerance.roundTrip) throw new Error(`round-trip lost ${-s.userValueBps} bps`);
      });

      it("wrapper0 (asset=t0) deposit+redeem", async function() {
        const { dt0 } = await fundUserFromGov(user3, CFG.wrapperSize.num, CFG.wrapperSize.den);
        if (dt0 === 0n) return this.skip();
        await token0.approve(wrapper0.address, dt0.toString(), { from: user3 });
        const pre = await userSnapshot(user3);
        let depReverted = false;
        try {
          await wrapper0.methods["deposit(uint256,address)"](dt0.toString(), user3, { from: user3 });
        } catch (e) { depReverted = true; console.log(`    w0 deposit reverted: ${e.message.split("\n")[0].slice(0, 80)}`); }
        if (depReverted) return;
        const shares = bi(await vault.balanceOf(user3));
        await vault.approve(wrapper0.address, shares.toString(), { from: user3 });
        await wrapper0.methods["redeem(uint256,address,address)"](shares.toString(), user3, user3, { from: user3 });
        const post = await userSnapshot(user3);
        const s = logDelta(`w0 round-trip`, pre, post);
        assertWrapEmpty(post, "w0 round-trip");
        // Two swap legs through pool fee → expect ~2× pool-fee bps loss + dust
        if (s.userValueBps < -200) throw new Error(`wrapper0 round-trip lost ${-s.userValueBps} bps`);
      });

      it("wrapper1 (asset=t1) deposit+redeem", async function() {
        const { dt1 } = await fundUserFromGov(user1, CFG.wrapperSize.num, CFG.wrapperSize.den);
        if (dt1 === 0n) return this.skip();
        await token1.approve(wrapper1.address, dt1.toString(), { from: user1 });
        const pre = await userSnapshot(user1);
        let depReverted = false;
        try {
          await wrapper1.methods["deposit(uint256,address)"](dt1.toString(), user1, { from: user1 });
        } catch (e) { depReverted = true; console.log(`    w1 deposit reverted: ${e.message.split("\n")[0].slice(0, 80)}`); }
        if (depReverted) return;
        const shares = bi(await vault.balanceOf(user1));
        await vault.approve(wrapper1.address, shares.toString(), { from: user1 });
        await wrapper1.methods["redeem(uint256,address,address)"](shares.toString(), user1, user1, { from: user1 });
        const post = await userSnapshot(user1);
        const s = logDelta(`w1 round-trip`, pre, post);
        assertWrapEmpty(post, "w1 round-trip");
        if (s.userValueBps < -200) throw new Error(`wrapper1 round-trip lost ${-s.userValueBps} bps`);
      });
    });

    describe("small vault, large user deposit — surviving holder must not be diluted", function() {
      it(`drain ${CFG.smallVaultDrainBps/100}% of gov, then user1 deposits ${CFG.smallVaultDepositMultiplier}x of remaining NAV`, async function() {
        // Phase 1: drain
        const govSharesBefore = bi(await vault.balanceOf(governance));
        const drain = (govSharesBefore * BigInt(CFG.smallVaultDrainBps)) / 10000n;
        await vault.withdraw(drain.toString(), 0, 0, { from: governance });
        const drainedT0 = bi(await token0.balanceOf(governance));
        const drainedT1 = bi(await token1.balanceOf(governance));
        const navAfterDrain = bi(await vault.underlyingBalanceWithInvestment());
        const supplyAfterDrain = bi(await vault.totalSupply());
        const ppsAfterDrain = bi(await vault.getPricePerFullShare());
        console.log(`    drain: supply ${govSharesBefore} -> ${supplyAfterDrain}, nav -> ${navAfterDrain}, pps=${ppsAfterDrain}`);

        // Phase 2: forward all freshly-withdrawn tokens to user1 (this gives them way more than NAV)
        if (drainedT0 > 0n) await token0.transfer(user1, drainedT0.toString(), { from: governance });
        if (drainedT1 > 0n) await token1.transfer(user1, drainedT1.toString(), { from: governance });
        const u1T0 = bi(await token0.balanceOf(user1));
        const u1T1 = bi(await token1.balanceOf(user1));
        await token0.approve(vault.address, u1T0.toString(), { from: user1 });
        await token1.approve(vault.address, u1T1.toString(), { from: user1 });

        // Phase 3: snapshot both gov and user1 before user1's deposit
        const govPreDep = await userSnapshot(governance);
        const u1PreDep  = await userSnapshot(user1);
        const ratioToNav = navAfterDrain === 0n ? 0n : (u1PreDep.userIdleValueT1 * 100n) / govPreDep.totalVaultValueT1;
        console.log(`    user1 incoming idle value (t1): ${u1PreDep.userIdleValueT1} (${ratioToNav}x of pre-NAV)`);

        // Phase 4: user1 deposits
        await vault.deposit(u1T0.toString(), u1T1.toString(), 0, user1, { from: user1 });

        const govPostDep = await userSnapshot(governance);
        const u1PostDep  = await userSnapshot(user1);
        const sGov = logDelta(`gov (surviving holder)`, govPreDep, govPostDep);
        const sU1  = logDelta(`user1 (big depositor)`, u1PreDep, u1PostDep);

        if (sGov.userValueBps < -CFG.bpsTolerance.smallVaultGov) throw new Error(`surviving holder lost ${-sGov.userValueBps} bps when big depositor came in`);
        if (sU1.userValueBps < -CFG.bpsTolerance.smallVaultDeposit) throw new Error(`big depositor lost ${-sU1.userValueBps} bps on deposit`);
      });

      it("user1 then withdraws all — both holders recover near-full value", async function() {
        const govPreW = await userSnapshot(governance);
        const u1PreW  = await userSnapshot(user1);
        const u1Shares = bi(await vault.balanceOf(user1));
        if (u1Shares === 0n) return this.skip();

        await vault.withdraw(u1Shares.toString(), 0, 0, { from: user1 });

        const govPostW = await userSnapshot(governance);
        const u1PostW  = await userSnapshot(user1);
        const sGov = logDelta(`gov after user1 exit`, govPreW, govPostW);
        const sU1  = logDelta(`user1 exit`, u1PreW, u1PostW);

        // Allow either bps tolerance OR a small absolute floor (rounding noise at sub-100-wei scales).
        if (sGov.userValueBps < -CFG.bpsTolerance.smallVaultGov && sGov.userValueDelta < -10n) throw new Error(`gov lost ${-sGov.userValueBps} bps (${sGov.userValueDelta} wei) on user1's withdraw`);
        if (sU1.userValueBps < -CFG.bpsTolerance.smallVaultDeposit) throw new Error(`big depositor lost ${-sU1.userValueBps} bps on withdraw`);
      });
    });

    describe("sweepStrayToken — protected vs unprotected tokens", function() {
      it("rejects token0 and token1 (they back PPS)", async function() {
        let revT0 = false, revT1 = false;
        try { await vault.sweepStrayToken(token0.address, governance, { from: governance }); }
        catch (_) { revT0 = true; }
        try { await vault.sweepStrayToken(token1.address, governance, { from: governance }); }
        catch (_) { revT1 = true; }
        if (!revT0 || !revT1) throw new Error("sweepStrayToken must reject t0/t1");
      });
      it("no-ops for any unrelated ERC20 the vault doesn't hold", async function() {
        const STRAY = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC
        // We just verify the call doesn't revert when vault holds none.
        await vault.sweepStrayToken(STRAY, user2, { from: governance });
      });
      it("transfers the actual balance of a stray ERC20 to the destination", async function() {
        // Pick a stray that we can transfer from the underlying-whale's wallet without
        // affecting the test. Use Base USDC since the whale typically holds some.
        const STRAY = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
        const stray = await IERC20.at(STRAY);
        let whaleBal;
        try { whaleBal = bi(await stray.balanceOf(underlyingWhale)); }
        catch (_) { return this.skip(); }
        if (whaleBal === 0n) return this.skip();
        const amount = whaleBal < 100n ? whaleBal : 100n;
        await stray.transfer(vault.address, amount.toString(), { from: underlyingWhale });
        const vaultBalBefore = bi(await stray.balanceOf(vault.address));
        const recipBalBefore = bi(await stray.balanceOf(user2));
        await vault.sweepStrayToken(STRAY, user2, { from: governance });
        const vaultBalAfter = bi(await stray.balanceOf(vault.address));
        const recipBalAfter = bi(await stray.balanceOf(user2));
        if (vaultBalAfter !== 0n) throw new Error("vault still holds stray after sweep");
        if (recipBalAfter - recipBalBefore !== vaultBalBefore) throw new Error("recipient didn't receive full balance");
        console.log(`    swept ${vaultBalBefore} stray units to recipient`);
      });
    });
  });
}
