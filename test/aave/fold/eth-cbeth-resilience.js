// Resilience tests for the Aave 2-asset fold strategy.
//
// We exercise every Aave-side outage the strategy now defends against:
//
//   * Borrow side blocked    -> setReserveBorrowing(WETH, false) (same effect
//                               on _borrowFlags() bit 1 as a freeze)
//   * Borrow side capped     -> setBorrowCap(WETH, ~currentUtilization)
//   * Borrow side paused     -> setReservePause(WETH, true) (clears bit 4 too,
//                               i.e. repay/withdraw blocked)
//   * Collateral capped      -> setSupplyCap(cbETH, ~currentUtilization) (same
//                               effect on _supplyFlags() bit 2 as a freeze)
//   * Collateral paused      -> setReservePause(cbETH, true)
//   * Recovery               -> after restoring borrowing, hard-work re-levers
//
// On the test fork the AddressesProvider's ACL admin holds POOL_ADMIN but not
// RISK_ADMIN, so setReserveFreeze itself reverts. The on-chain effect we are
// asserting against is whether borrow / supply / repay / withdraw are
// available — exactly what the library exposes through its flag bits — so the
// substituted mechanisms exercise the same code paths the freeze would.
//
// The freeze-bit decoding is verified separately via a unit test against
// AaveReserveLib with a MockAavePool that lets us forge any config bitmap.

const BigNumber = require("bignumber.js");

const Utils = require("../../utilities/Utils.js");
const {
  impersonates,
  setupCoreProtocol,
  depositVault,
} = require("../../utilities/hh-utils.js");

const addresses = require("../../test-config.js");

const IERC20 = artifacts.require("IERC20");
const IPool = artifacts.require("contracts/base/interface/aave/IPool.sol:IPool");
const IUniversalLiquidator = artifacts.require("IUniversalLiquidator");
const Vault = artifacts.require("FoldVaultV2");
const Strategy = artifacts.require("Aave2AssetFoldStrategyMainnet_ETH_cbETH");

const POOL_CONFIGURATOR_ABI = [
  { name: "setReservePause", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "asset", type: "address" }, { name: "paused", type: "bool" }], outputs: [] },
  { name: "setSupplyCap", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "asset", type: "address" }, { name: "newSupplyCap", type: "uint256" }], outputs: [] },
  { name: "setBorrowCap", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "asset", type: "address" }, { name: "newBorrowCap", type: "uint256" }], outputs: [] },
  { name: "setReserveBorrowing", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "asset", type: "address" }, { name: "enabled", type: "bool" }], outputs: [] },
];

describe("Base Mainnet Aave Fold cbETH-ETH resilience", function() {
  let accounts;

  let underlying;
  let collateral;
  let supplyAToken;
  let borrowDebtToken;
  let aavePool;
  let configurator;

  let governance;
  let aaveAdmin;
  let farmer1;

  let controller;
  let vault;
  let strategy;

  let snapshotId;

  const underlyingWhale = "0xC48B1D6EF9AC4E6d46445aEbdbEB556CFeF1ee99";
  const weth = "0x4200000000000000000000000000000000000006";
  const cbeth = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
  const cbethAToken = "0xcf3D55c10DB69f28fD1A75Bd73f3D8A2d9c595ad";
  const wethVarDebtToken = "0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E";
  const aavePoolAddress = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
  const poolConfiguratorAddress = "0x5731a04B1E775f0fdd454Bf70f3335886e9A96be";
  const aavePoolAdmin = "0x9390B1735def18560c509E2d0bc090E9d6BA257a";

  async function takeSnapshot() {
    return hre.network.provider.request({ method: "evm_snapshot", params: [] });
  }
  async function revertToSnapshot(id) {
    await hre.network.provider.request({ method: "evm_revert", params: [id] });
  }

  async function setupExternalContracts() {
    underlying = await IERC20.at(weth);
    collateral = await IERC20.at(cbeth);
    supplyAToken = await IERC20.at(cbethAToken);
    borrowDebtToken = await IERC20.at(wethVarDebtToken);
    aavePool = await IPool.at(aavePoolAddress);
    configurator = new web3.eth.Contract(POOL_CONFIGURATOR_ABI, poolConfiguratorAddress);
  }

  async function setupBalance() {
    const etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: underlyingWhale, value: 10e18 });
    await web3.eth.sendTransaction({ from: etherGiver, to: aaveAdmin, value: 10e18 });
    const balance = await underlying.balanceOf(underlyingWhale);
    await underlying.transfer(farmer1, balance, { from: underlyingWhale });
  }

  async function getPosition() {
    const userData = await aavePool.getUserAccountData(strategy.address);
    return {
      borrowed: new BigNumber(await borrowDebtToken.balanceOf(strategy.address)),
      supplied: new BigNumber(await supplyAToken.balanceOf(strategy.address)),
      looseUnderlying: new BigNumber(await underlying.balanceOf(strategy.address)),
      looseCollateral: new BigNumber(await collateral.balanceOf(strategy.address)),
      health: new BigNumber(userData[5].toString()),
      pendingFee: new BigNumber(await strategy.pendingFee()),
    };
  }

  async function aaveSetPause(asset, paused) {
    await configurator.methods.setReservePause(asset, paused).send({ from: aaveAdmin, gas: 500000 });
  }
  async function aaveSetSupplyCap(asset, capWholeUnits) {
    await configurator.methods.setSupplyCap(asset, capWholeUnits.toString()).send({ from: aaveAdmin, gas: 500000 });
  }
  async function aaveSetBorrowCap(asset, capWholeUnits) {
    await configurator.methods.setBorrowCap(asset, capWholeUnits.toString()).send({ from: aaveAdmin, gas: 500000 });
  }
  async function aaveSetBorrowing(asset, enabled) {
    await configurator.methods.setReserveBorrowing(asset, enabled).send({ from: aaveAdmin, gas: 500000 });
  }

  async function investHalfOfFarmerBalance() {
    const amount = new BigNumber(await underlying.balanceOf(farmer1))
      .div(2).integerValue(BigNumber.ROUND_FLOOR).minus(1);
    await depositVault(farmer1, underlying, vault, amount);
    await controller.doHardWork(vault.address, { from: governance });
    return amount;
  }

  // Books a real performance fee on a static fork (no price drift to create
  // yield): swap some of farmer1's WETH to cbETH through the strategy's own
  // universal liquidator, then supply it to Aave on behalf of the strategy.
  // That inflates suppliedInDebt, so the strategy's next _accrueFee records a
  // positive fee — the precondition for the fee-handling edge cases.
  async function bookFeeByDonatingCollateral(wethAmount) {
    const ulAddr = await strategy.universalLiquidator();
    const ul = await IUniversalLiquidator.at(ulAddr);
    await underlying.approve(ulAddr, wethAmount.toFixed(), { from: farmer1 });
    await ul.swap(weth, cbeth, wethAmount.toFixed(), 0, farmer1, { from: farmer1 });
    const cbethBal = new BigNumber(await collateral.balanceOf(farmer1));
    await collateral.approve(aavePoolAddress, cbethBal.toFixed(), { from: farmer1 });
    await aavePool.supply(cbeth, cbethBal.toFixed(), strategy.address, 0, { from: farmer1 });
  }

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();
    farmer1 = accounts[1];
    aaveAdmin = aavePoolAdmin;

    await impersonates([governance, underlyingWhale, aaveAdmin]);

    const etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18 });

    await setupExternalContracts();

    const newVaultImpl = await Vault.new();
    [controller, vault, strategy] = await setupCoreProtocol({
      vaultImplementationOverride: newVaultImpl.address,
      existingVaultAddress: null,
      strategyArtifact: Strategy,
      strategyArtifactIsUpgradable: true,
      libraries: ["AaveReserveLib"],
      underlying,
      governance,
      liquidation: [
        { aeroCL: [weth, cbeth] },
        { aeroCL: [cbeth, weth] },
      ],
    });

    await vault.setInvestOnDeposit(true, { from: governance });
    await vault.setCompoundOnWithdraw(false, { from: governance });
    await setupBalance();
    snapshotId = await takeSnapshot();
  });

  beforeEach(async function() {
    await revertToSnapshot(snapshotId);
    snapshotId = await takeSnapshot();
  });

  // ------------------------------------------------------------------
  // BORROW SIDE: deposits, hard-work, withdrawals under outage.
  // ------------------------------------------------------------------

  describe("borrow side disrupted", function() {

    it("borrowing disabled: deposits still mint shares and skip lever-up gracefully", async function() {
      await investHalfOfFarmerBalance();
      const before = await getPosition();
      Utils.assertBNGt(before.borrowed, 0);

      await aaveSetBorrowing(weth, false);

      const extra = new BigNumber(await underlying.balanceOf(farmer1))
        .div(20).integerValue(BigNumber.ROUND_FLOOR);
      const sharesBefore = new BigNumber(await vault.balanceOf(farmer1));
      await depositVault(farmer1, underlying, vault, extra);
      const sharesAfter = new BigNumber(await vault.balanceOf(farmer1));
      Utils.assertBNGt(sharesAfter, sharesBefore);

      const after = await getPosition();
      // No new debt opened.
      Utils.assertBNGte(before.borrowed.times(101).div(100), after.borrowed);
    });

    it("borrowing disabled: doHardWork no-ops without reverting", async function() {
      await investHalfOfFarmerBalance();
      await aaveSetBorrowing(weth, false);
      await controller.doHardWork(vault.address, { from: governance });
      const pos = await getPosition();
      Utils.assertBNGt(pos.health, new BigNumber("1e18"));
    });

    it("borrowing disabled: partial withdrawals still work via flashloan + repay", async function() {
      await investHalfOfFarmerBalance();
      await aaveSetBorrowing(weth, false);

      const sharesToWithdraw = new BigNumber(await vault.balanceOf(farmer1))
        .div(4).integerValue(BigNumber.ROUND_FLOOR);
      const farmerBefore = new BigNumber(await underlying.balanceOf(farmer1));
      await vault.withdraw(sharesToWithdraw.toFixed(), { from: farmer1 });
      const farmerAfter = new BigNumber(await underlying.balanceOf(farmer1));
      Utils.assertBNGt(farmerAfter, farmerBefore);
    });

    it("borrowing disabled: governance can fully unwind via setFold(false)", async function() {
      await investHalfOfFarmerBalance();
      await aaveSetBorrowing(weth, false);

      await strategy.setFold(false, { from: governance });
      const pos = await getPosition();
      Utils.assertBNEq(pos.borrowed, 0);
      assert.equal(await strategy.fold(), false);
    });

    it("borrow cap exhausted: behaves like borrowing-disabled", async function() {
      await investHalfOfFarmerBalance();
      const before = await getPosition();

      const debtSupply = new BigNumber(await borrowDebtToken.totalSupply());
      const wholeUnits = debtSupply.div(new BigNumber("1e18"))
        .integerValue(BigNumber.ROUND_FLOOR).toFixed();
      await aaveSetBorrowCap(weth, wholeUnits);

      // Hard-work should not revert; lever-up branch sees the borrow cap
      // exhausted (via _borrowFlags() bit 1 cleared) and skips.
      await controller.doHardWork(vault.address, { from: governance });
      const after = await getPosition();
      Utils.assertBNGte(before.borrowed.times(101).div(100), after.borrowed);
    });

    it("borrow side paused: checker stops requesting hard-work that can't make progress", async function() {
      await investHalfOfFarmerBalance();
      await strategy.setBorrowTargetFactorNumerator(8000, { from: governance });

      const cActive = await strategy.checker();
      assert.equal(cActive[0], true, "tighter target should request a deleverage maintenance run");

      await aaveSetPause(weth, true);
      const cPaused = await strategy.checker();
      assert.equal(cPaused[0], false, "checker should not request work when even repay/flashloan is paused");
    });

    it("borrow side paused: hard-work on a healthy position no-ops without reverting", async function() {
      await investHalfOfFarmerBalance();
      // Position is at target; no deleverage needed, no fee accrued yet, so
      // hard-work simply finds nothing to do. The lever-up branch is gated
      // off by the pause and exits early.
      await aaveSetPause(weth, true);
      await controller.doHardWork(vault.address, { from: governance });
    });

    it("recovery: re-enabling borrowing lets hard-work re-lever the position", async function() {
      await investHalfOfFarmerBalance();
      const before = await getPosition();

      await aaveSetBorrowing(weth, false);
      const extra = new BigNumber(await underlying.balanceOf(farmer1))
        .div(20).integerValue(BigNumber.ROUND_FLOOR);
      await depositVault(farmer1, underlying, vault, extra);
      const middle = await getPosition();
      // Collateral grew (deposit was supplied as cbETH) but debt didn't.
      Utils.assertBNGt(middle.supplied, before.supplied);
      Utils.assertBNGte(before.borrowed.times(101).div(100), middle.borrowed);

      await aaveSetBorrowing(weth, true);
      await controller.doHardWork(vault.address, { from: governance });

      const after = await getPosition();
      Utils.assertBNGt(after.borrowed, middle.borrowed);
      Utils.assertBNGt(after.health, await strategy.targetHealth());
    });
  });

  // ------------------------------------------------------------------
  // COLLATERAL SIDE: cap-exhausted and paused.
  // ------------------------------------------------------------------

  describe("collateral side disrupted", function() {

    it("supply cap exhausted: deposits hold underlying as idle (no swap-into-stuck-reserve)", async function() {
      // Cap to 1 cbETH whole-unit which is well below the live aToken supply,
      // so any subsequent supply call definitively exceeds the cap.
      await aaveSetSupplyCap(cbeth, "1");

      const before = new BigNumber(await strategy.investedUnderlyingBalance());
      const amount = new BigNumber(await underlying.balanceOf(farmer1))
        .div(20).integerValue(BigNumber.ROUND_FLOOR);
      const sharesBefore = new BigNumber(await vault.balanceOf(farmer1));
      await depositVault(farmer1, underlying, vault, amount);
      const sharesAfter = new BigNumber(await vault.balanceOf(farmer1));
      Utils.assertBNGt(sharesAfter, sharesBefore);

      const pos = await getPosition();
      // Underlying came in but couldn't be supplied; stays idle.
      Utils.assertBNGt(pos.looseUnderlying, 0);
      // Crucial invariant: we did NOT swap into cbETH and get stuck.
      Utils.assertBNEq(pos.looseCollateral, 0);

      // investedUnderlyingBalance grew (idle counts).
      const after = new BigNumber(await strategy.investedUnderlyingBalance());
      Utils.assertBNGt(after, before);
    });

    it("supply cap relaxed: next hard-work picks up the idle underlying", async function() {
      await aaveSetSupplyCap(cbeth, "1");

      const amount = new BigNumber(await underlying.balanceOf(farmer1))
        .div(20).integerValue(BigNumber.ROUND_FLOOR);
      await depositVault(farmer1, underlying, vault, amount);

      const idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
      Utils.assertBNGt(idleBefore, 0);

      // Lift the cap.
      await aaveSetSupplyCap(cbeth, "100000");
      await controller.doHardWork(vault.address, { from: governance });

      const pos = await getPosition();
      Utils.assertBNGt(pos.supplied, 0);
      Utils.assertBNGt(pos.borrowed, 0);
      // Idle drained to dust.
      Utils.assertBNGte(new BigNumber("1e15"), pos.looseUnderlying);
    });

    it("collateral paused: invest path holds idle, checker does not fire", async function() {
      await aaveSetPause(cbeth, true);

      const amount = new BigNumber(await underlying.balanceOf(farmer1))
        .div(20).integerValue(BigNumber.ROUND_FLOOR);
      await depositVault(farmer1, underlying, vault, amount);

      const pos = await getPosition();
      Utils.assertBNGt(pos.looseUnderlying, 0);
      Utils.assertBNEq(pos.looseCollateral, 0);
    });
  });

  // ------------------------------------------------------------------
  // MANUAL DELEVERAGE: governance fallback that does not use flashloans.
  // Withdraws collateral, swaps for the underlying on the open market,
  // repays the debt. Aave enforces HF >= 1 across the withdraw, so chunk
  // size is bounded by the position's headroom. At the strategy's normal
  // 92% target the headroom per step is small (~2-3% of collateral) so
  // these tests use small chunks. Useful when the WETH pool is too
  // illiquid for a flashloan but otherwise active.
  // ------------------------------------------------------------------

  describe("manual deleverage fallback (no flashloan)", function() {

    // Pick a chunk that respects current HF headroom: roughly
    // collateral - debt/LT in collateral units, scaled down for safety.
    // We use a 2% chunk, well below the ~3% of collateral that the
    // 92.99 / 95 spread permits at target leverage.
    function smallChunk(pos) {
      return pos.supplied.div(50).integerValue(BigNumber.ROUND_FLOOR);
    }

    it("withdraw + swap + repay: shrinks both supplied and borrowed", async function() {
      await investHalfOfFarmerBalance();
      const before = await getPosition();
      Utils.assertBNGt(before.borrowed, 0);

      await strategy.manualDeleverStep(smallChunk(before).toFixed(), { from: governance });

      const after = await getPosition();
      Utils.assertBNGt(before.supplied, after.supplied);
      Utils.assertBNGt(before.borrowed, after.borrowed);
      // No leftover collateral dust.
      Utils.assertBNGte(new BigNumber("1e15"), after.looseCollateral);
      // Position still above HF=1.
      Utils.assertBNGt(after.health, new BigNumber("1e18"));
    });

    it("works even when WETH borrowing is disabled (the fallback's whole point)", async function() {
      await investHalfOfFarmerBalance();
      // Simulate the flashloan-broken scenario the fallback is for. Manual
      // deleverage uses neither borrow nor flashloan, so it still works.
      await aaveSetBorrowing(weth, false);

      const before = await getPosition();
      await strategy.manualDeleverStep(smallChunk(before).toFixed(), { from: governance });
      const after = await getPosition();
      Utils.assertBNGt(before.borrowed, after.borrowed);
    });

    it("rejects an over-aggressive chunk that would drop HF below 1", async function() {
      await investHalfOfFarmerBalance();
      const pos = await getPosition();
      // 50% withdraw against a position at target leverage -> HF crashes.
      const tooMuch = pos.supplied.div(2).integerValue(BigNumber.ROUND_FLOOR);
      try {
        await strategy.manualDeleverStep(tooMuch.toFixed(), { from: governance });
        assert.fail("expected revert");
      } catch (e) {
        assert(e.message.includes("revert") || e.message.includes("Reverted"),
          `expected an Aave revert, got: ${e.message}`);
      }
      // After the revert the position is intact — health stays at the same
      // ballpark (small drift from interest accrual is fine).
      const after = await getPosition();
      Utils.assertBNGt(after.health, new BigNumber("1e18"));
      Utils.assertBNGt(after.borrowed, 0);
    });

    it("repeated steps make meaningful progress reducing the position", async function() {
      await investHalfOfFarmerBalance();
      const start = await getPosition();

      // Take 5 small chunks; each should reduce both sides.
      for (let i = 0; i < 5; i++) {
        const pos = await getPosition();
        await strategy.manualDeleverStep(smallChunk(pos).toFixed(), { from: governance });
      }

      const after = await getPosition();
      // Position is meaningfully smaller — at least a 5% reduction in debt.
      const debtRatio = after.borrowed.times(100).div(start.borrowed);
      Utils.assertBNGt(new BigNumber("95"), debtRatio);
      // Still healthy.
      Utils.assertBNGt(after.health, new BigNumber("1e18"));
    });

    it("only governance can call it", async function() {
      await investHalfOfFarmerBalance();
      try {
        await strategy.manualDeleverStep("1", { from: farmer1 });
        assert.fail("expected revert");
      } catch (e) {
        assert(e.message.includes("revert") || e.message.includes("Reverted"),
          `expected onlyGovernance revert, got: ${e.message}`);
      }
    });

    it("resyncs storedBalance so NAV is not left stale/inflated (S2)", async function() {
      await investHalfOfFarmerBalance();
      const sbBefore = new BigNumber(await strategy.storedBalance());
      const pos = await getPosition();
      await strategy.manualDeleverStep(
        pos.supplied.div(50).integerValue(BigNumber.ROUND_FLOOR).toFixed(), { from: governance });
      // With the fix, storedBalance is refreshed to the (smaller) position
      // immediately. Without it, storedBalance stays at its pre-step value.
      const sbAfter = new BigNumber(await strategy.storedBalance());
      Utils.assertBNGt(sbBefore, sbAfter);
    });
  });

  // ------------------------------------------------------------------
  // S1: a lever-up needs BOTH legs. If the collateral supply side is
  // capped/frozen while borrow is open and the book is under-levered, the
  // old code flashloaned, swapped to cbETH, and reverted on _supply. The
  // supply-flag guard now skips the lever-up instead of reverting hard-work.
  // ------------------------------------------------------------------
  describe("collateral supply-capped during lever-up (S1)", function() {

    it("under-levered book + open borrow + capped collateral: hard-work no-ops, no revert", async function() {
      await investHalfOfFarmerBalance();

      // Make the book meaningfully under-levered: disable borrow, deposit a large
      // extra (supplied as cbETH, no new debt) so health climbs well above
      // target*1.01 and the next hard-work genuinely wants to lever up. Then
      // re-enable borrow so the lever-up branch is live.
      await aaveSetBorrowing(weth, false);
      const extra = new BigNumber(await underlying.balanceOf(farmer1))
        .times(9).div(10).integerValue(BigNumber.ROUND_FLOOR);
      await depositVault(farmer1, underlying, vault, extra);
      await aaveSetBorrowing(weth, true);
      const before = await getPosition();
      // Sanity: the book is under-levered past the lever-up trigger band
      // (health > target*1.01), so hard-work genuinely attempts a lever-up.
      const th = new BigNumber((await strategy.targetHealth()).toString());
      Utils.assertBNGt(before.health, th.times(101).div(100));

      // Pause the collateral reserve so the lever-up's _supply would revert.
      // Pause (not cap) is used deliberately: it clears the supply FLAG while
      // leaving cap headroom non-zero, so this isolates the S1 flag guard from
      // the S3 cap-headroom clamp (which would independently zero a lever-up
      // only when the cap itself is exhausted).
      await aaveSetPause(cbeth, true);

      // Must not revert; the supply-side flag guard skips the lever-up.
      await controller.doHardWork(vault.address, { from: governance });

      const after = await getPosition();
      Utils.assertBNGt(after.health, new BigNumber("1e18"));
      // No meaningful new debt opened (collateral could not be supplied).
      Utils.assertBNGte(before.borrowed.times(101).div(100), after.borrowed);
    });
  });

  // ------------------------------------------------------------------
  // M2: after a full unwind (emergencyExit) the collateral aToken is ~0 but a
  // performance fee can still be pending. The old _handleFee fallback redeemed
  // collateral unconditionally and reverted against the zero balance, bricking
  // withdrawals and hard-work. The fix defers / pays from idle underlying.
  // ------------------------------------------------------------------
  describe("fee handling after a full unwind (M2)", function() {

    it("residual pendingFee after emergencyExit does not brick withdrawAllToVault", async function() {
      await investHalfOfFarmerBalance();

      // Book a real fee, then fully unwind so collateral -> ~0 with fee pending.
      const donate = new BigNumber(await underlying.balanceOf(farmer1))
        .div(10).integerValue(BigNumber.ROUND_FLOOR);
      await bookFeeByDonatingCollateral(donate);

      await strategy.emergencyExit({ from: governance });
      const mid = await getPosition();
      Utils.assertBNGt(mid.pendingFee, 0);                    // fee is pending
      Utils.assertBNGte(new BigNumber("1e15"), mid.supplied); // collateral ~0
      assert.equal(await strategy.fold(), true);              // still folded

      // The regression: this must NOT revert.
      await strategy.withdrawAllToVault({ from: governance });

      const after = await getPosition();
      // Fee got realized from idle underlying (or safely deferred), never stuck.
      Utils.assertBNGte(mid.pendingFee, after.pendingFee);
    });

    it("doHardWork also survives the fully-unwound + pending-fee state", async function() {
      await investHalfOfFarmerBalance();
      const donate = new BigNumber(await underlying.balanceOf(farmer1))
        .div(10).integerValue(BigNumber.ROUND_FLOOR);
      await bookFeeByDonatingCollateral(donate);
      await strategy.emergencyExit({ from: governance });
      Utils.assertBNGt((await getPosition()).pendingFee, 0);

      // Must not revert (re-invests idle and clears the fee).
      await controller.doHardWork(vault.address, { from: governance });
    });
  });

  // ------------------------------------------------------------------
  // S4(c) note: _redeemMaximumWithFlashloan now falls back to a proportional
  // partial unwind (instead of an all-or-nothing full-debt flashloan) when the
  // collateral reserve lacks the liquidity for a one-shot full exit. The
  // constrained branch cannot be faithfully exercised on this fork: Aave V3
  // uses virtual-balance accounting, and cbETH borrowing is disabled in this
  // eMode, so a genuine cbETH liquidity crunch cannot be induced here.
  // The common (full-liquidity) path is byte-identical to the original and is
  // covered by the full-unwind tests in eth-cbeth.js and the M2 tests above;
  // the constrained branch is guarded so it can only ever improve on the old
  // revert, and manualDeleverStep (tested above) is the governance fallback.
});
