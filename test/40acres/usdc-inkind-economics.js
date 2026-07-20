// Economics invariant tests for in-kind redemptions.
//
// Core invariant: while the switch is on, NO vault interaction may decrease the
// assets-per-share of remaining holders — neither at the live rate (totalAssets)
// nor at the cached rate (underlyingBalanceWithInvestment). The comparison is
// exact (cross-multiplied, no division rounding). Because the invariant holds
// per-transaction, no sequence of interactions can extract value from the vault.
//
// Attack scenarios are bounded by FAIR YIELD: each transaction sits in its own
// block and the pool accrues real yield every second, so an actor holding shares
// across N blocks legitimately earns their pro-rata slice of that growth. The
// hard bound for every scenario is therefore
//   P&L <= sharesHeld * (assets-per-share growth over the holding window) + dust
// i.e. nobody can earn MORE than the per-share growth all holders received.

const Utils = require("../utilities/Utils.js");
const { impersonates } = require("../utilities/hh-utils.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");
const IERC20 = artifacts.require("IERC20");
const IERC4626 = artifacts.require("contracts/base/interface/IERC4626.sol:IERC4626");
const IController = artifacts.require("IController");
const VaultV2InKind = artifacts.require("VaultV2InKind");
const VaultProxy = artifacts.require("VaultProxy");
const IUpgradeableStrategy = artifacts.require("IUpgradeableStrategy");
const Strategy = artifacts.require("FortyAcresLendStrategyMainnet_USDC");

const FORK_BLOCK = 48873800;

const existingVaultAddress = "0xC777031D50F632083Be7080e51E390709062263E";
const existingStrategyAddress = "0x1d59868D7767d703929393bDaB313302840f533c";
const poolAddress = "0xB99B6dF96d4d5448cC0a5B3e0ef7896df9507Cf5";
const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const fusdcWhale = "0xD092a3165c9f18D35854C4B6cdcB4e2f1775A8D4";
const passiveHolder = "0x4f4366b13d499B4248b084A4c3F00Ad960C53ea0";
const usdcWhale = "0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A";

// deterministic PRNG so failures are reproducible
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

describe("Base Mainnet 40Acres in-kind redemption economics", function() {
  let accounts, governance, sink;
  let underlying, poolShare, pool, vault, strategy, controller;

  async function snapshot() {
    return {
      live: new BigNumber((await vault.totalAssets()).toString()),
      cached: new BigNumber((await vault.underlyingBalanceWithInvestment()).toString()),
      supply: new BigNumber((await vault.totalSupply()).toString()),
    };
  }

  // exact per-share comparison: value-per-share after >= before
  // <=> TA_a * S_b >= TA_b * S_a (cross-multiplied, no division)
  function assertNoDilution(before, after, label) {
    assert.isTrue(
      after.live.times(before.supply).gte(before.live.times(after.supply)),
      `${label}: live assets-per-share decreased ` +
      `(${after.live.toFixed()}/${after.supply.toFixed()} < ${before.live.toFixed()}/${before.supply.toFixed()})`
    );
    assert.isTrue(
      after.cached.times(before.supply).gte(before.cached.times(after.supply)),
      `${label}: cached assets-per-share decreased ` +
      `(${after.cached.toFixed()}/${after.supply.toFixed()} < ${before.cached.toFixed()}/${before.supply.toFixed()})`
    );
  }

  async function guarded(label, fn) {
    const before = await snapshot();
    await fn();
    const after = await snapshot();
    assertNoDilution(before, after, label);
    // fee backing must always be intact
    const pendingFee = new BigNumber((await strategy.pendingFee()).toString());
    const feeShares = new BigNumber((await pool.previewWithdraw(pendingFee.toFixed())).toString());
    const stratShares = new BigNumber((await poolShare.balanceOf(existingStrategyAddress)).toString());
    assert.isTrue(stratShares.gte(feeShares), `${label}: fee backing broken`);
    return after;
  }

  // fair yield for holding `shares` from snapshot a to snapshot b:
  // shares * (assets-per-share_b - assets-per-share_a), floored
  function fairYield(shares, a, b) {
    const at = shares.times(b.live).dividedToIntegerBy(b.supply);
    const before = shares.times(a.live).dividedToIntegerBy(a.supply);
    return BigNumber.max(at.minus(before), 0);
  }

  // total value of an account: USDC + pool shares valued at the pool's own rate
  async function valueOf(account) {
    const usdc = new BigNumber((await underlying.balanceOf(account)).toString());
    const shares = new BigNumber((await poolShare.balanceOf(account)).toString());
    const shareValue = shares.gt(0)
      ? new BigNumber((await pool.previewRedeem(shares.toFixed())).toString())
      : new BigNumber(0);
    return usdc.plus(shareValue);
  }

  // move any pool shares away so the next measurement starts clean
  async function sweep(account) {
    const bal = new BigNumber((await poolShare.balanceOf(account)).toString());
    if (bal.gt(0)) await poolShare.transfer(sink, bal.toFixed(), { from: account });
  }

  async function fundActor(account, usdcAmount, shareAmount) {
    if (usdcAmount && usdcAmount.gt(0)) {
      await underlying.transfer(account, usdcAmount.toFixed(), { from: usdcWhale });
    }
    if (shareAmount && shareAmount.gt(0)) {
      await vault.transfer(account, shareAmount.toFixed(), { from: fusdcWhale });
    }
  }

  before(async function() {
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [{
        forking: {
          jsonRpcUrl: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`,
          blockNumber: FORK_BLOCK,
        },
      }],
    });

    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();
    sink = accounts[8];

    await impersonates([governance, fusdcWhale, usdcWhale]);
    const etherGiver = accounts[9];
    for (const a of [governance, fusdcWhale, usdcWhale]) {
      await web3.eth.sendTransaction({ from: etherGiver, to: a, value: 10e18 });
    }

    underlying = await IERC20.at(usdcAddress);
    poolShare = await IERC20.at(poolAddress);
    pool = await IERC4626.at(poolAddress);
    vault = await VaultV2InKind.at(existingVaultAddress);
    strategy = await Strategy.at(existingStrategyAddress);
    controller = await IController.at(addresses.Controller);

    // upgrade both proxies in place
    const newStrategyImpl = await Strategy.new();
    const strategyAsUpgradable = await IUpgradeableStrategy.at(existingStrategyAddress);
    await strategyAsUpgradable.scheduleUpgrade(newStrategyImpl.address, { from: governance });
    const newVaultImpl = await VaultV2InKind.new();
    await vault.scheduleUpgrade(newVaultImpl.address, { from: governance });
    await Utils.waitHours(13);
    await strategyAsUpgradable.upgrade({ from: governance });
    await (await VaultProxy.at(existingVaultAddress)).upgrade({ from: governance });
    await vault.setRedeemInKindEnabled(true, { from: governance });
  });

  it("every operation type preserves assets-per-share exactly (live and cached)", async function() {
    const dep = new BigNumber(50000e6);
    await underlying.approve(vault.address, dep.times(3).toFixed(), { from: usdcWhale });

    await guarded("deposit", () =>
      vault.methods["deposit(uint256)"](dep.toFixed(), { from: usdcWhale }));
    await guarded("mint", () =>
      vault.mint(new BigNumber(10000e6).toFixed(), usdcWhale, { from: usdcWhale }));
    await guarded("erc4626 deposit", () =>
      vault.methods["deposit(uint256,address)"](new BigNumber(10000e6).toFixed(), usdcWhale, { from: usdcWhale }));
    await guarded("idle-funded withdraw", () =>
      vault.methods["withdraw(uint256)"](new BigNumber(5000e6).toFixed(), { from: usdcWhale }));
    await guarded("redeemInKind partial", () =>
      vault.redeemInKind(new BigNumber(20000e6).toFixed(), fusdcWhale, fusdcWhale, { from: fusdcWhale }));
    await guarded("redeemInKind tiny", () =>
      vault.redeemInKind(new BigNumber(1e4).toFixed(), fusdcWhale, fusdcWhale, { from: fusdcWhale }));
    await vault.approve(sink, new BigNumber(1000e6).toFixed(), { from: fusdcWhale });
    await guarded("third-party redeemInKind", () =>
      vault.redeemInKind(new BigNumber(1000e6).toFixed(), sink, fusdcWhale, { from: sink }));
    await guarded("doHardWork", () =>
      controller.doHardWork(vault.address, { from: governance }));
    await guarded("time drift + doHardWork", async () => {
      await Utils.advanceNBlock(600);
      await controller.doHardWork(vault.address, { from: governance });
    });
  });

  it("randomized operation sequence never dilutes holders (seeded fuzz)", async function() {
    const rnd = mulberry32(0xC0FFEE);
    const passiveSharesStart = new BigNumber((await vault.balanceOf(passiveHolder)).toString());
    assert.isTrue(passiveSharesStart.gt(0), "passive holder must hold shares");
    const startSnap = await snapshot();

    await underlying.approve(vault.address, new BigNumber(1e12).toFixed(), { from: usdcWhale });

    const ops = [];
    for (let i = 0; i < 40; i++) {
      const r = rnd();
      if (r < 0.25) {
        const amt = new BigNumber(Math.floor(rnd() * 15000e6) + 1e6);
        ops.push([`#${i} deposit ${amt.div(1e6).toFixed(0)}`, () =>
          vault.methods["deposit(uint256)"](amt.toFixed(), { from: usdcWhale })]);
      } else if (r < 0.45) {
        ops.push([`#${i} redeemInKind (whale)`, async () => {
          const bal = new BigNumber((await vault.balanceOf(fusdcWhale)).toString());
          if (bal.lt(1e6)) return;
          const s = BigNumber.min(
            bal.times(Math.floor(rnd() * 30) + 1).dividedToIntegerBy(100),
            new BigNumber(8000e6)
          );
          if (s.gt(0)) await vault.redeemInKind(s.toFixed(), fusdcWhale, fusdcWhale, { from: fusdcWhale });
        }]);
      } else if (r < 0.6) {
        ops.push([`#${i} redeemInKind (depositor)`, async () => {
          const bal = new BigNumber((await vault.balanceOf(usdcWhale)).toString());
          if (bal.lt(1e6)) return;
          const s = bal.times(Math.floor(rnd() * 50) + 1).dividedToIntegerBy(100);
          if (s.gt(0)) await vault.redeemInKind(s.toFixed(), usdcWhale, usdcWhale, { from: usdcWhale });
        }]);
      } else if (r < 0.75) {
        ops.push([`#${i} idle-funded withdraw`, async () => {
          const snap = await snapshot();
          const idle = new BigNumber((await underlying.balanceOf(vault.address)).toString());
          // stay within idle so it does not revert against the illiquid pool
          const maxShares = idle.times(snap.supply).dividedToIntegerBy(snap.live).times(9).dividedToIntegerBy(10);
          const bal = new BigNumber((await vault.balanceOf(usdcWhale)).toString());
          const s = BigNumber.min(maxShares, bal.dividedToIntegerBy(4));
          if (s.gt(1000)) await vault.methods["withdraw(uint256)"](s.toFixed(), { from: usdcWhale });
        }]);
      } else if (r < 0.85) {
        ops.push([`#${i} time drift`, () => Utils.advanceNBlock(Math.floor(rnd() * 1200) + 60)]);
      } else if (r < 0.95) {
        ops.push([`#${i} doHardWork`, () => controller.doHardWork(vault.address, { from: governance })]);
      } else {
        const d = new BigNumber(Math.floor(rnd() * 5000e6) + 1e6);
        ops.push([`#${i} pool donation ${d.div(1e6).toFixed(0)}`, () =>
          underlying.transfer(poolAddress, d.toFixed(), { from: usdcWhale })]);
      }
    }

    for (const [label, fn] of ops) {
      await guarded(label, fn);
    }

    // a passive holder can only have gained per-share value over the sequence
    const endSnap = await snapshot();
    assert.equal(
      new BigNumber((await vault.balanceOf(passiveHolder)).toString()).toFixed(),
      passiveSharesStart.toFixed(),
      "passive holder balance must be untouched"
    );
    assertNoDilution(startSnap, endSnap, "whole fuzz sequence");
    console.log("start assets/share (micro-USDC):", startSnap.live.times(1e6).dividedToIntegerBy(startSnap.supply).toFixed());
    console.log("end assets/share (micro-USDC):  ", endSnap.live.times(1e6).dividedToIntegerBy(endSnap.supply).toFixed());
  });

  it("deposit -> immediate redeemInKind loop earns at most fair yield", async function() {
    const actor = accounts[10];
    const per = new BigNumber(30000e6);
    await fundActor(actor, per.times(5).plus(1e6), null);
    await underlying.approve(vault.address, per.times(5).toFixed(), { from: actor });

    let cumulativeExcess = new BigNumber(0);
    for (let i = 0; i < 5; i++) {
      const valueBefore = await valueOf(actor);
      const sharesBefore = new BigNumber((await vault.balanceOf(actor)).toString());
      await vault.methods["deposit(uint256)"](per.toFixed(), { from: actor });
      const snapHeld = await snapshot();
      const minted = new BigNumber((await vault.balanceOf(actor)).toString()).minus(sharesBefore);
      await vault.redeemInKind(minted.toFixed(), actor, actor, { from: actor });
      const snapDone = await snapshot();

      const pnl = (await valueOf(actor)).minus(valueBefore);
      const fair = fairYield(minted, snapHeld, snapDone);
      const excess = pnl.minus(fair);
      cumulativeExcess = cumulativeExcess.plus(excess);
      console.log(`iter ${i}: pnl=${pnl.toFixed()} fair=${fair.toFixed()} excess=${excess.toFixed()}`);
      assert.isTrue(excess.lte(2), `iteration ${i}: profit beyond fair yield`);
      await sweep(actor);
    }
    assert.isTrue(cumulativeExcess.lte(0), "cumulative excess over fair yield must not be positive");
  });

  it("mint -> immediate redeemInKind earns at most fair yield", async function() {
    const actor = accounts[11];
    await fundActor(actor, new BigNumber(60000e6), null);
    await underlying.approve(vault.address, new BigNumber(60000e6).toFixed(), { from: actor });

    const valueBefore = await valueOf(actor);
    const sharesBefore = new BigNumber((await vault.balanceOf(actor)).toString());
    await vault.mint(new BigNumber(40000e6).toFixed(), actor, { from: actor });
    const snapHeld = await snapshot();
    const minted = new BigNumber((await vault.balanceOf(actor)).toString()).minus(sharesBefore);
    await vault.redeemInKind(minted.toFixed(), actor, actor, { from: actor });
    const snapDone = await snapshot();

    const pnl = (await valueOf(actor)).minus(valueBefore);
    const fair = fairYield(minted, snapHeld, snapDone);
    console.log("mint round trip: pnl=", pnl.toFixed(), " fair=", fair.toFixed());
    assert.isTrue(pnl.minus(fair).lte(2), "mint round trip must not beat fair yield");
  });

  it("chunked redemption cannot beat a lump-sum redemption", async function() {
    const total = new BigNumber(10000e6);
    const chunks = 20;
    const lumpPreview = await vault.previewRedeemInKind(total.toFixed());
    const lumpPoolShares = new BigNumber(lumpPreview.poolSharesOut.toString());

    const poolBefore = new BigNumber((await poolShare.balanceOf(fusdcWhale)).toString());
    for (let i = 0; i < chunks; i++) {
      await vault.redeemInKind(total.dividedToIntegerBy(chunks).toFixed(), fusdcWhale, fusdcWhale, { from: fusdcWhale });
    }
    const received = new BigNumber((await poolShare.balanceOf(fusdcWhale)).toString()).minus(poolBefore);
    console.log("lump preview: ", lumpPoolShares.toFixed());
    console.log("chunked total:", received.toFixed());
    // chunking may only differ by per-chunk flooring dust (and inter-block fee drift)
    assert.isTrue(
      received.lte(lumpPoolShares.plus(chunks)),
      "chunked redemption must not receive more than lump + dust"
    );
  });

  it("donating to the pool before redeeming is strictly value-losing", async function() {
    const actor = accounts[12];
    const donation = new BigNumber(10000e6);
    const redeemShares = new BigNumber(15000e6);
    await fundActor(actor, donation, redeemShares);

    // what the redemption would be worth without the donation, at the pre-donation rate
    const preview = await vault.previewRedeemInKind(redeemShares.toFixed());
    const baseline = new BigNumber((await pool.previewRedeem(preview.poolSharesOut.toString())).toString())
      .plus(new BigNumber(preview.assetsOut.toString()));

    await underlying.transfer(poolAddress, donation.toFixed(), { from: actor });
    await vault.redeemInKind(redeemShares.toFixed(), actor, actor, { from: actor });
    const received = await valueOf(actor); // USDC left (0) + redeemed value at post-donation rate

    const extra = received.minus(baseline); // marginal benefit of having donated (+ 2 blocks drift)
    const netPnl = extra.minus(donation);
    console.log("donation:", donation.toFixed(), "| value recaptured:", extra.toFixed(), "| net P&L:", netPnl.toFixed());
    assert.isTrue(netPnl.lt(0), "donation attack must lose money overall");
    assert.isTrue(
      extra.lte(donation.times(30).dividedToIntegerBy(100)),
      "recaptured value must stay below 30% of the donation"
    );
  });

  it("sandwiching another user's redemption earns at most fair yield", async function() {
    const actor = accounts[13];
    const dep = new BigNumber(80000e6);
    await fundActor(actor, dep, null);
    await underlying.approve(vault.address, dep.toFixed(), { from: actor });

    const valueBefore = await valueOf(actor);
    const sharesBefore = new BigNumber((await vault.balanceOf(actor)).toString());
    await vault.methods["deposit(uint256)"](dep.toFixed(), { from: actor });
    const snapHeld = await snapshot();
    // victim redeems in between
    await vault.redeemInKind(new BigNumber(30000e6).toFixed(), fusdcWhale, fusdcWhale, { from: fusdcWhale });
    const minted = new BigNumber((await vault.balanceOf(actor)).toString()).minus(sharesBefore);
    await vault.redeemInKind(minted.toFixed(), actor, actor, { from: actor });
    const snapDone = await snapshot();

    const pnl = (await valueOf(actor)).minus(valueBefore);
    const fair = fairYield(minted, snapHeld, snapDone);
    console.log("sandwich: pnl=", pnl.toFixed(), " fair=", fair.toFixed());
    assert.isTrue(pnl.minus(fair).lte(2), "sandwich must not beat fair yield");
  });

  it("holding through drift earns exactly pro-rata yield, no more", async function() {
    const actor = accounts[14];
    const dep = new BigNumber(100000e6);
    await fundActor(actor, dep, null);
    await underlying.approve(vault.address, dep.toFixed(), { from: actor });

    const valueBefore = await valueOf(actor);
    const sharesBefore = new BigNumber((await vault.balanceOf(actor)).toString());
    await vault.methods["deposit(uint256)"](dep.toFixed(), { from: actor });
    const snapHeld = await snapshot();
    const minted = new BigNumber((await vault.balanceOf(actor)).toString()).minus(sharesBefore);

    await Utils.advanceNBlock(43200); // ~half a day of pool yield vesting

    await vault.redeemInKind(minted.toFixed(), actor, actor, { from: actor });
    const snapDone = await snapshot();

    const gain = (await valueOf(actor)).minus(valueBefore);
    const fair = fairYield(minted, snapHeld, snapDone);
    console.log("drift hold: gain=", gain.toFixed(), " fair=", fair.toFixed());
    assert.isTrue(gain.minus(fair).lte(2), "drift holder must not beat fair yield");
    assert.isTrue(gain.gte(fair.times(95).dividedToIntegerBy(100)), "drift holder should receive ~their fair yield");
  });
});
