// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../../base/upgradability/BaseUpgradeableStrategy.sol";
import "../../../base/interface/aave/IAToken.sol";
import "../../../base/interface/aave/IPool.sol";
import "./AaveReserveLib.sol";

contract Aave2AssetFoldStrategy_debtDenom is BaseUpgradeableStrategy {

  using SafeERC20 for IERC20;

  enum FlashMode { Deposit, Withdraw }

  // Prices are intentionally NOT carried here: the flashloan callback runs in
  // the same transaction as the initiator, so the oracle returns identical
  // prices when re-read there — passing them would only bloat the encoded
  // params (and the contract) for no behavioural difference.
  struct FlashParams {
    FlashMode mode;
    uint256 redeemAmount;
    uint256 collateralToRedeem;
  }

  // A single fresh read of the position: both oracle prices (one getPrice read +
  // its reciprocal), debt, collateral-in-debt-units, and the health factor.
  // Callers reuse it instead of re-reading; the liquidation threshold is read
  // separately, only by the two lever paths that need it.
  struct PositionSnap {
    uint256 borrowedDebt;
    uint256 suppliedInDebt;
    uint256 priceSupplyInBorrow;
    uint256 priceBorrowInSupply;
    uint256 health;
  }

  address internal constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);
  uint256 internal constant BPS = 10_000;
  uint256 internal constant MAX_SLIPPAGE_BPS = 100;
  // Safety margin subtracted from a reserve's reported cap headroom before we
  // size a lever-up against it. Covers reserve.accruedToTreasury (excluded from
  // the aToken/debtToken totalSupply the headroom is derived from) plus a tick
  // of per-block interest accrual, so a clamped borrow/supply stays under the
  // cap rather than reverting at the exact boundary.
  uint256 internal constant CAP_BUFFER_BPS = 100;

  // additional storage slots (on top of BaseUpgradeableStrategy ones) are defined here
  bytes32 internal constant _SUPPLY_ATOKEN_SLOT = 0x245f4d52f8837fdd7cb38b8b771b10e0c2c4eb20f8e39aec533f7dff93021e31;
  bytes32 internal constant _SUPPLY_ASSET_SLOT = 0xbbde6fefcbc73f647e3922d059c732eaa1d49b0805ba57644418e1845ceba5c5;
  bytes32 internal constant _BORROW_ATOKEN_SLOT = 0x7a779a15b70eeebb99374942f526b279a26022a49d0a6f2d84060f15a77861a9;
  bytes32 internal constant _STORED_BALANCE_SLOT = 0x36be27dce5926377a73445ec8b6a6c16c485af64395bbacfbf8aac4c71f8043b;
  bytes32 internal constant _PENDING_FEE_SLOT = 0x0af7af9f5ccfa82c3497f40c7c382677637aee27293a6243a22216b51481bd97;
  bytes32 internal constant _COLLATERALFACTORNUMERATOR_SLOT = 0x129eccdfbcf3761d8e2f66393221fa8277b7623ad13ed7693a0025435931c64a;
  bytes32 internal constant _BORROWTARGETFACTORNUMERATOR_SLOT = 0xa65533f4b41f3786d877c8fdd4ae6d27ada84e1d9c62ea3aca309e9aa03af1cd;
  bytes32 internal constant _FOLD_SLOT = 0x1841be4c16015a744c9fbf595f7c6b32d40278c16c1fc7cf2de88c6348de44ba;
  bytes32 internal constant _SLIPPAGE_BPS_SLOT = 0x9739c2fea70b5edd7eea812db3dffa2fb7638aaecdd2d30770ef5020cd8b9208;

  constructor() BaseUpgradeableStrategy() {
    assert(_SUPPLY_ATOKEN_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.supplyAToken")) - 1));
    assert(_SUPPLY_ASSET_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.supplyAsset")) - 1));
    assert(_BORROW_ATOKEN_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.borrowAToken")) - 1));
    assert(_STORED_BALANCE_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.storedBalance")) - 1));
    assert(_PENDING_FEE_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.pendingFee")) - 1));
    assert(_COLLATERALFACTORNUMERATOR_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.collateralFactorNumerator")) - 1));
    assert(_BORROWTARGETFACTORNUMERATOR_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.borrowTargetFactorNumerator")) - 1));
    assert(_FOLD_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.fold")) - 1));
    assert(_SLIPPAGE_BPS_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.slippageBps")) - 1));
  }

  function initializeBaseStrategy(
    address _storage,
    address _underlying,
    address _vault,
    address _supplyAToken,
    address _supplyAsset,
    address _borrowAToken,
    address _aavePool,
    uint256 _borrowTargetFactorNumerator,
    uint256 _collateralFactorNumerator,
    uint256 _slippageBps,
    uint8 _eMode,
    bool _fold
  ) public initializer {
    BaseUpgradeableStrategy.initialize(
      _storage,
      _underlying,
      _vault,
      _aavePool,
      address(0),
      harvestMSIG
    );

    require(IAToken(_supplyAToken).UNDERLYING_ASSET_ADDRESS() == _supplyAsset, "supAss");
    require(IAToken(_borrowAToken).UNDERLYING_ASSET_ADDRESS() == _underlying, "und");

    _setSupplyAToken(_supplyAToken);
    _setSupplyAsset(_supplyAsset);
    _setBorrowAToken(_borrowAToken);

    require(_collateralFactorNumerator < BPS, "col");
    require(_borrowTargetFactorNumerator < _collateralFactorNumerator, "bor");
    setUint256(_COLLATERALFACTORNUMERATOR_SLOT, _collateralFactorNumerator);
    setUint256(_BORROWTARGETFACTORNUMERATOR_SLOT, _borrowTargetFactorNumerator);
    setBoolean(_FOLD_SLOT, _fold);
    require(_slippageBps <= MAX_SLIPPAGE_BPS, "slip");
    setUint256(_SLIPPAGE_BPS_SLOT, _slippageBps);
    if (_eMode > 0){
      IPool(rewardPool()).setUserEMode(_eMode);
    }
  }

  function preInteract() external restricted {
    _accrueFee();
  }

  function checker() external view returns (bool canExec, bytes memory execPayload) {
    PositionSnap memory s = _snapPosition();
    uint256 cl = _effectiveCollateralFactorNumerator();
    // Only fire when the next hard-work has work to do that can actually
    // succeed; both branches here are deleverage / repay paths and only need
    // repay availability (paused borrow side blocks even repay).
    canExec = (_borrowFlags() & 4 != 0) && (
      (fold() && s.borrowedDebt > 0 && cl <= borrowTargetFactorNumerator()) ||
      s.health < (_targetHealthFrom(cl) * 99) / 100
    );
    execPayload = abi.encodeWithSelector(IController.doHardWork.selector, vault());
  }

  // ---------------------------------------------------------------------------
  // Aave reserve status guards (bit decoding lives in AaveReserveLib, inlined).
  //   bit 1 -> borrow available    (borrow side only)
  //   bit 2 -> supply available    (supply side only)
  //   bit 4 -> repay/withdraw available (both sides)
  // Frozen blocks new supply/borrow but allows repay/withdraw. Paused blocks
  // everything. The strategy reads these on-chain so it auto-recovers without a
  // tx when Aave reopens the market.
  // ---------------------------------------------------------------------------
  function _borrowFlags() internal view returns (uint8) {
    return AaveReserveLib.borrowFlags(IPool(rewardPool()), underlying(), borrowAToken());
  }

  function _supplyFlags() internal view returns (uint8) {
    return AaveReserveLib.supplyFlags(IPool(rewardPool()), supplyAsset(), supplyAToken());
  }

  // Caps a desired new-debt increase to what both reserves can still absorb
  // under their supply/borrow caps (minus a safety buffer), so the strategy
  // levers partway and finishes on a later hard-work instead of reverting the
  // flashloan at a near-full cap.
  function _capClampedDebtIncrease(uint256 desired, uint256 priceSupplyInBorrow) internal view returns (uint256) {
    return AaveReserveLib.capClampedDebtIncrease(
      IPool(rewardPool()), underlying(), borrowAToken(), supplyAsset(), supplyAToken(),
      desired, priceSupplyInBorrow, CAP_BUFFER_BPS
    );
  }

  // Both oracle prices from a single oracle resolution (reciprocals). Logic in
  // AaveReserveLib; the delegatecall is warm after the first library touch.
  function _prices() internal view returns (uint256 priceSupplyInBorrow, uint256 priceBorrowInSupply) {
    return AaveReserveLib.prices(supplyAsset(), underlying());
  }

  function _snapPosition() internal view returns (PositionSnap memory s) {
    (s.priceSupplyInBorrow, s.priceBorrowInSupply, s.borrowedDebt, s.suppliedInDebt, s.health) =
      AaveReserveLib.snap(supplyAsset(), underlying(), supplyAToken(), borrowAToken());
  }

  function _currentBalance(PositionSnap memory s) internal pure returns (uint256) {
    return s.suppliedInDebt - s.borrowedDebt;
  }

  // min(configured collateral factor, live Aave liquidation threshold). A
  // getUserAccountData read; the lever paths call it ONCE and reuse the value
  // via _targetHealthFrom, so they never read it twice in one operation.
  function _effectiveCollateralFactorNumerator() internal view returns (uint256) {
    (,,, uint256 liquidationThreshold,,) = IPool(rewardPool()).getUserAccountData(address(this));
    return Math.min(collateralFactorNumerator(), liquidationThreshold);
  }

  function targetHealth() public view returns (uint256) {
    return _targetHealthFrom(_effectiveCollateralFactorNumerator());
  }

  // targetHealth derived from an already-read effective collateral factor.
  function _targetHealthFrom(uint256 collateralLimit) internal view returns (uint256) {
    if (!fold() || borrowTargetFactorNumerator() == 0) {
      return type(uint256).max;
    }
    if (collateralLimit <= borrowTargetFactorNumerator()) {
      return 1e18;
    }
    return (collateralLimit * 1e18) / borrowTargetFactorNumerator();
  }

  function storedBalance() public view returns (uint256) {
    return getUint256(_STORED_BALANCE_SLOT);
  }

  // Recompute the cached net position value. Only needs prices + balances, so
  // it skips the getUserAccountData a full snap would do.
  function _updateStoredBalance() internal {
    (uint256 priceSupplyInBorrow,) = _prices();
    uint256 supplied = (IERC20(supplyAToken()).balanceOf(address(this)) * priceSupplyInBorrow) / 1e18;
    setUint256(_STORED_BALANCE_SLOT, supplied - IERC20(borrowAToken()).balanceOf(address(this)));
  }

  function totalFeeNumerator() public view returns (uint256) {
    return strategistFeeNumerator() + platformFeeNumerator() + profitSharingNumerator();
  }

  function pendingFee() public view returns (uint256) {
    return getUint256(_PENDING_FEE_SLOT);
  }

  function _accrueFee() internal returns (PositionSnap memory) {
    PositionSnap memory s = _snapPosition();
    uint256 cur = _currentBalance(s);
    uint256 prev = storedBalance();
    uint256 fee = 0;
    if (cur > prev) {
      uint256 balanceIncrease = cur - prev;
      fee = (balanceIncrease * totalFeeNumerator()) / feeDenominator();
    }
    setUint256(_PENDING_FEE_SLOT, pendingFee() + fee);
    setUint256(_STORED_BALANCE_SLOT, cur);

    return s;
  }

  // While folded the preferred path is to pay the fee out of fresh borrow so
  // the leveraged position is not perturbed. If the borrow market cannot accept
  // new debt (frozen / paused / capped / no headroom) or there is no
  // collateral-factor headroom, fall through and pull the fee from collateral
  // instead. If even withdraw is blocked (paused / inactive collateral) or
  // there is no collateral to redeem, defer — pendingFee accumulates and
  // investedUnderlyingBalance() already nets it out of share price.
  function _handleFee() internal {
    PositionSnap memory s = _accrueFee();
    uint256 fee = pendingFee();
    if (fee == 0) return;
    uint256 cl = _effectiveCollateralFactorNumerator();
    if (fold() && (_borrowFlags() & 1) != 0
        && AaveReserveLib.borrowCapHeadroom(IPool(rewardPool()), underlying(), borrowAToken()) >= fee
        && cl > borrowTargetFactorNumerator()
        && s.health > _targetHealthFrom(cl)) {
      // Preferred: pay the fee from fresh borrow so the leveraged position is
      // not perturbed. Guarded so a partially-filled borrow cap (bit 1 can be
      // set with < fee of headroom) falls through instead of reverting.
      _borrow(fee);
    } else {
      // Fallback: pull the fee from collateral, but ONLY when the collateral
      // side can service a withdraw AND there is collateral to redeem. If not
      // (e.g. after emergencyExit the aToken balance is ~0, or the reserve is
      // paused/inactive), defer: pendingFee stays booked and
      // investedUnderlyingBalance() already nets it out of share price, so no
      // value is lost or mis-accounted.
      address a = supplyAsset();
      uint256 want = (fee * s.priceBorrowInSupply / 1e18) * (BPS + slippageBps()) / BPS;
      uint256 redeemable = Math.min(want, IERC20(supplyAToken()).balanceOf(address(this)));
      if (redeemable > 0 && (_supplyFlags() & 4) != 0) {
        _redeem(redeemable);
        uint256 cb = IERC20(a).balanceOf(address(this));
        if (cb > 0) _swap(a, underlying(), cb, s.priceSupplyInBorrow, s.priceBorrowInSupply);
      }
    }
    address u = underlying();
    fee = Math.min(fee, IERC20(u).balanceOf(address(this)));
    if (fee == 0) return;
    _notifyProfitInRewardToken(u, fee * feeDenominator() / totalFeeNumerator());
    setUint256(_PENDING_FEE_SLOT, pendingFee() - fee);
  }

  function depositArbCheck() public pure returns (bool) {
    // there's no arb here.
    return true;
  }

  function unsalvagableTokens(address token) public view returns (bool) {
    return (
      token == underlying() ||
      token == supplyAToken() ||
      token == supplyAsset() ||
      token == borrowAToken()
    );
  }

  /**
  * The strategy invests by supplying the underlying as a collateral.
  *
  * If the collateral side cannot accept new supply (frozen / paused / cap full)
  * the fresh underlying stays in the strategy contract; investedUnderlyingBalance()
  * already counts strategy-held underlying, so vault accounting is unaffected and
  * the funds get re-attempted on the next hard work.
  */
  function _investAllUnderlying() internal onlyNotPausedInvesting {
    address _underlying = underlying();
    uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));

    if (underlyingBalance > 0 && (_supplyFlags() & 2 != 0)) {
      PositionSnap memory s = _snapPosition();
      address _supplyAsset = supplyAsset();
      _swap(_underlying, _supplyAsset, underlyingBalance, s.priceSupplyInBorrow, s.priceBorrowInSupply);
      _supply(IERC20(_supplyAsset).balanceOf(address(this)));
    }
    if (fold()) {
      _depositWithFlashloan(_snapPosition());
    }
  }

  function _investUserUnderlying() internal onlyNotPausedInvesting {
    address _underlying = underlying();
    uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));
    // If we cannot supply collateral, leave the deposit as idle underlying
    // in the strategy; investedUnderlyingBalance() counts it and the next
    // hard-work picks it up once the collateral side reopens.
    if (underlyingBalance == 0 || (_supplyFlags() & 2 == 0)) return;

    PositionSnap memory beforeSnap = _snapPosition();
    uint256 balanceBefore = _currentBalance(beforeSnap);
    address _supplyAsset = supplyAsset();
    _swap(_underlying, _supplyAsset, underlyingBalance, beforeSnap.priceSupplyInBorrow, beforeSnap.priceBorrowInSupply);
    _supply(IERC20(_supplyAsset).balanceOf(address(this)));

    if (fold()) {
      // Only lever the newly added equity so existing vault capital is not retargeted
      // during a user deposit.
      _depositWithFlashloanMarginal(_snapPosition(), balanceBefore);
    }
  }

  /**
  * Exits the leveraged position and returns everything to the vault.
  */
  function withdrawAllToVault() public restricted {
    address _underlying = underlying();
    _withdrawMaximum(true);
    uint256 bal = IERC20(_underlying).balanceOf(address(this));
    // Keep any still-pending fee behind; clamp so a residual pendingFee larger
    // than the realized balance can never underflow-revert the transfer.
    uint256 reserved = Math.min(bal, pendingFee());
    if (bal > reserved) {
      IERC20(_underlying).safeTransfer(vault(), bal - reserved);
    }
    _updateStoredBalance();
  }

  function emergencyExit() external onlyGovernance {
    _withdrawMaximum(false);
    _updateStoredBalance();
  }

  /**
  * Manual non-flashloan deleverage step. Withdraws `collateralAmount` of
  * supplyAsset from Aave, swaps it for the underlying through the universal
  * liquidator, and repays the proceeds against the strategy's debt. Does
  * not use a flashloan, so it is the recovery path when the borrow pool's
  * liquidity is exhausted (a flashloan can't pull the underlying out of an
  * over-utilised pool). Does NOT work when either reserve is paused — pause
  * blocks repay/withdraw and there is no on-chain workaround for that.
  *
  * Aave rejects withdrawals that would push the position below HF=1, so
  * the call reverts cleanly when the chunk is too large; governance
  * retries with a smaller value. Repeat until debt is zero or the position
  * is at target. storedBalance is resynced at the end so any leftover idle
  * underlying is not double-counted by investedUnderlyingBalance() before the
  * next hard-work.
  */
  function manualDeleverStep(uint256 collateralAmount) external onlyGovernance {
    AaveReserveLib.manualDeleverStep(
      rewardPool(), universalLiquidator(),
      supplyAsset(), underlying(), borrowAToken(),
      slippageBps(), collateralAmount
    );
    // Resync the cached position value so NAV/pricePerShare reflects the
    // shrunken position immediately (the step lowers it, so no fee accrues).
    _updateStoredBalance();
  }

  function _withdrawMaximum(bool claim) internal {
    if (claim) {
      _handleFee();
    } else {
      _accrueFee();
    }
    _redeemMaximum();
  }

  function withdrawToVault(uint256 amountUnderlying) external restricted {
    PositionSnap memory s = _accrueFee();

    address _underlying = underlying();
    uint256 balance = IERC20(_underlying).balanceOf(address(this));
    if (amountUnderlying <= balance) {
      IERC20(_underlying).safeTransfer(vault(), amountUnderlying);
      return;
    }
    uint256 positionBalance = _currentBalance(s);
    if (amountUnderlying >= positionBalance + balance) {
      withdrawAllToVault();
      return;
    }
    uint256 toRedeem = amountUnderlying - balance;
    // get some of the underlying
    if (fold()) {
      _redeemProportionalWithFlashloan(toRedeem, s);
    } else {
      _redeemPartial(toRedeem, s);
    }

    // Transfer the realized underlying back to the vault. The vault-side withdraw
    // accounting decides how much belongs to the exiting user versus remaining holders.
    IERC20(_underlying).safeTransfer(vault(), IERC20(_underlying).balanceOf(address(this)));
    _updateStoredBalance();
  }

  function doHardWork() public restricted {
    _handleFee();
    _investAllUnderlying();
    _updateStoredBalance();
  }

  function doHardWorkOnDeposit() external restricted {
    // Deposit-time path: invest only the newly transferred underlying and leave full-book
    // maintenance for keeper/governance hard work.
    _investUserUnderlying();
    _updateStoredBalance();
  }

  function _redeemMaximum() internal {
    _redeemMaximumWithFlashloan();
  }

  /**
  * Redeems `amountUnderlying` or fails.
  */
  function _redeemPartial(uint256 amountUnderlying, PositionSnap memory s) internal {
    _redeemWithFlashloan(
      amountUnderlying,
      fold()? borrowTargetFactorNumerator():0,
      s
    );
  }

  /**
  * Salvages a token.
  */
  function salvage(address recipient, address token, uint256 amount) external onlyGovernance {
    // To make sure that governance cannot come in and take away the coins
    require(!unsalvagableTokens(token), "!salv");
    IERC20(token).safeTransfer(recipient, amount);
  }

  /**
  * Returns the current balance.
  */
  function investedUnderlyingBalance() public view returns (uint256) {
    address _supplyAsset = supplyAsset();
    uint256 balance = IERC20(underlying()).balanceOf(address(this));
    uint256 supplyBalance = IERC20(_supplyAsset).balanceOf(address(this));
    if (supplyBalance > 0) {
      (uint256 priceSupplyInBorrow,) = _prices();
      supplyBalance = (supplyBalance * priceSupplyInBorrow) / 1e18;
    }
    return balance + supplyBalance + storedBalance() - pendingFee();
  }

  /**
  * Supplies to Aave
  */
  function _supply(uint256 amount) internal {
    if (amount < 1e2){
      return;
    }
    address _supplyAsset = supplyAsset();
    address _aavePool = rewardPool();
    IERC20(_supplyAsset).safeApprove(_aavePool, 0);
    IERC20(_supplyAsset).safeApprove(_aavePool, amount);
    IPool(_aavePool).supply(_supplyAsset, amount, address(this), 0);
  }

  /**
  * Borrows against the collateral
  */
  function _borrow(uint256 amountUnderlying) internal {
    if (amountUnderlying == 0){
      return;
    }
    // Borrow, check the balance for this contract's address
    IPool(rewardPool()).borrow(underlying(), amountUnderlying, 2, 0, address(this));
  }

  function _redeem(uint256 amountUnderlying) internal {
    if (amountUnderlying == 0){
      return;
    }
    IPool(rewardPool()).withdraw(supplyAsset(), amountUnderlying, address(this));
  }

  function _repay(uint256 amountUnderlying) internal {
    if (amountUnderlying == 0){
      return;
    }
    address _underlying = underlying();
    address _aavePool = rewardPool();
    IERC20(_underlying).safeApprove(_aavePool, 0);
    IERC20(_underlying).safeApprove(_aavePool, amountUnderlying);
    IPool(_aavePool).repay(_underlying, amountUnderlying, 2, address(this));
  }

  function _redeemMaximumWithFlashloan() internal {
    PositionSnap memory s = _snapPosition();

    address _supplyAsset = supplyAsset();
    address _supplyAToken = supplyAToken();

    // A full unwind must withdraw the ENTIRE collateral position (value
    // suppliedInDebt). If the reserve does not hold enough liquid collateral
    // for that, unwind only the fraction its liquidity supports — proportionally,
    // so HF stays put — and leave the remainder for a later call or
    // manualDeleverStep. This avoids the all-or-nothing revert the old
    // full-debt flashloan hit when collateral liquidity was short.
    uint256 availableInDebt = IERC20(_supplyAsset).balanceOf(_supplyAToken) * s.priceSupplyInBorrow / 1e18;
    if (s.suppliedInDebt > 0 && availableInDebt < s.suppliedInDebt) {
      // equity * (liquidity / total-collateral), buffered a hair under the
      // liquidity boundary so the collateral withdraw stays serviceable.
      uint256 feasible = (_currentBalance(s) * availableInDebt) / s.suppliedInDebt;
      feasible = (feasible * (BPS - slippageBps())) / BPS;
      if (feasible > 0) {
        _redeemProportionalWithFlashloan(feasible, s);
      }
      // Debt remains, so we must NOT withdraw further unencumbered collateral
      // here (that would lower HF); the mop-up below is only safe post full unwind.
      return;
    }

    uint256 balDebt = _currentBalance(s) - pendingFee();
    _redeemWithFlashloan(balDebt, 0, s);
    // Debt is now fully repaid; mop up any leftover (now unencumbered) collateral.
    uint256 maxOut = Math.min(
      IERC20(_supplyAToken).balanceOf(address(this)),
      IERC20(_supplyAsset).balanceOf(_supplyAToken)
    );
    if (maxOut > 0) {
      _redeem(maxOut);
      _swap(_supplyAsset, underlying(),
        IERC20(_supplyAsset).balanceOf(address(this)),
        s.priceSupplyInBorrow, s.priceBorrowInSupply);
    }
  }

  function _depositWithFlashloan(PositionSnap memory s) internal {
    uint256 _borrowNum = borrowTargetFactorNumerator();
    uint256 collateralLimit = _effectiveCollateralFactorNumerator();

    // If governance reduces the allowed collateral factor below the active borrow target,
    // unwind instead of trying to maintain a potentially unsafe leveraged position.
    if (_borrowNum == 0 || collateralLimit <= _borrowNum) {
      if (s.borrowedDebt > 0) {
        _redeemWithFlashloan(0, 0, s);
      } else {
        _handleDust(s);
      }
      return;
    }

    uint256 th = _targetHealthFrom(collateralLimit);
    if (s.health < (th * 99) / 100) {
      _redeemPartial(0, s);
      return;
    }
    if (s.health < (th * 101) / 100) {
      _handleDust(s);
      return;
    }

    // A lever-up borrows the underlying and supplies collateral, so BOTH legs
    // must be usable. If either is unavailable (frozen / paused / borrow
    // disabled / cap full), we cannot lever further. Clean up dust so collateral
    // that arrived this tx is re-supplied (when possible) and fall through.
    if ((_borrowFlags() & 1) == 0 || (_supplyFlags() & 2) == 0) {
      _handleDust(s);
      return;
    }

    uint256 borrowTarget = (_currentBalance(s) * _borrowNum) / (BPS - _borrowNum);
    if (borrowTarget > s.borrowedDebt) {
      // Clamp to the reserves' remaining cap headroom: lever partway now and
      // finish on a later hard-work rather than reverting at a near-full cap.
      uint256 desiredDebtIncrease = _capClampedDebtIncrease(borrowTarget - s.borrowedDebt, s.priceSupplyInBorrow);
      uint256 premiumBps = IPool(rewardPool()).FLASHLOAN_PREMIUM_TOTAL();
      uint256 borrowDiff = premiumBps == 0
        ? desiredDebtIncrease
        : (desiredDebtIncrease * BPS) / (BPS + premiumBps);
      if (borrowDiff > 0) {
        _flashLoan(FlashParams({mode: FlashMode.Deposit, redeemAmount: 0, collateralToRedeem: 0}), borrowDiff);
      }
    }
    _handleDust(s);
  }

  function _depositWithFlashloanMarginal(PositionSnap memory s, uint256 balanceBefore) internal {
    uint256 _borrowNum = borrowTargetFactorNumerator();
    uint256 collateralLimit = _effectiveCollateralFactorNumerator();

    if (_borrowNum == 0 || collateralLimit <= _borrowNum) return;
    if (s.health < (_targetHealthFrom(collateralLimit) * 101) / 100) return;
    // A lever-up needs both legs: no fresh debt if borrow is unavailable, no
    // fresh collateral if supply is. Either way the new equity sits unlevered
    // until the next hard-work.
    if ((_borrowFlags() & 1) == 0 || (_supplyFlags() & 2) == 0) return;

    uint256 balanceAfter = _currentBalance(s);
    if (balanceAfter <= balanceBefore) return;

    // The marginal deposit should reach the same target leverage as the rest of the book,
    // but only for the user-added equity realized in this interaction. Clamp to the
    // reserves' remaining cap headroom so a near-full cap can't revert the deposit.
    uint256 debtIncrease = _capClampedDebtIncrease(
      ((balanceAfter - balanceBefore) * _borrowNum) / (BPS - _borrowNum),
      s.priceSupplyInBorrow
    );
    uint256 premiumBps = IPool(rewardPool()).FLASHLOAN_PREMIUM_TOTAL();
    uint256 borrowDiff = premiumBps > 0 ? (debtIncrease * BPS) / (BPS + premiumBps) : debtIncrease;
    if (borrowDiff == 0) return;

    _flashLoan(FlashParams({mode: FlashMode.Deposit, redeemAmount: 0, collateralToRedeem: 0}), borrowDiff);
  }

  function _redeemWithFlashloan(uint256 amount, uint256 _borrowTargetFactorNumerator, PositionSnap memory s) internal {
    uint256 newBalance = _currentBalance(s) - amount;
    uint256 newBorrowTarget = (newBalance * _borrowTargetFactorNumerator) / (BPS - _borrowTargetFactorNumerator);

    if (s.borrowedDebt > newBorrowTarget) {
      _flashLoan(FlashParams({mode: FlashMode.Withdraw, redeemAmount: amount, collateralToRedeem: 0}), s.borrowedDebt - newBorrowTarget);
    } else {
      _redeem((amount * s.priceBorrowInSupply) / 1e18);
      address coll = supplyAsset();
      uint256 collBal = IERC20(coll).balanceOf(address(this));
      if (collBal > 0) {
        _swap(coll, underlying(), collBal, s.priceSupplyInBorrow, s.priceBorrowInSupply);
      }
    }
  }

  function _redeemProportionalWithFlashloan(uint256 amountUnderlying, PositionSnap memory s) internal {
    uint256 positionBalance = _currentBalance(s);
    if (positionBalance == 0 || amountUnderlying == 0) {
      return;
    }

    uint256 proportion = (amountUnderlying * 1e18) / positionBalance;
    if (proportion > 1e18) proportion = 1e18;

    uint256 repayAmount = (s.borrowedDebt * proportion) / 1e18;
    uint256 collateralToRedeem = (IERC20(supplyAToken()).balanceOf(address(this)) * proportion) / 1e18;

    if (repayAmount > 0) {
      _flashLoan(FlashParams({mode: FlashMode.Withdraw, redeemAmount: 0, collateralToRedeem: collateralToRedeem}), repayAmount);
    } else if (collateralToRedeem > 0) {
      _redeem(collateralToRedeem);
      address coll = supplyAsset();
      uint256 collBal = IERC20(coll).balanceOf(address(this));
      if (collBal > 0) {
        _swap(coll, underlying(), collBal, s.priceSupplyInBorrow, s.priceBorrowInSupply);
      }
    }
  }

  // Single flashloan entry point shared by every lever/delever path.
  function _flashLoan(FlashParams memory params, uint256 amount) internal {
    IPool(rewardPool()).flashLoanSimple(address(this), underlying(), amount, abi.encode(params), 0);
  }

  function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes memory params) external nonReentrant() returns (bool) {
    address _aavePool = rewardPool();
    require(msg.sender == _aavePool, "!pool");
    require(initiator == address(this), "!sender");
    FlashParams memory flashParams = abi.decode(params, (FlashParams));
    uint256 toRepay = amount + premium;
    // Same tx as the initiator, so the oracle yields the same prices it used.
    (uint256 priceSupplyInBorrow, uint256 priceBorrowInSupply) = _prices();

    if (flashParams.mode == FlashMode.Deposit){
      _onFlashDeposit(asset, amount, toRepay, priceSupplyInBorrow, priceBorrowInSupply);
    } else {
      _onFlashWithdraw(
        asset,
        amount,
        toRepay,
        flashParams.redeemAmount,
        flashParams.collateralToRedeem,
        priceSupplyInBorrow,
        priceBorrowInSupply
      );
    }

    IERC20(asset).safeApprove(_aavePool, 0);
    IERC20(asset).safeApprove(_aavePool, toRepay);

    return true;
  }

  function _onFlashDeposit(address asset, uint256 amount, uint256 toRepay, uint256 priceSupplyInBorrow, uint256 priceBorrowInSupply) internal {
    address _supplyAsset = supplyAsset();
    _swap(asset, _supplyAsset, amount, priceSupplyInBorrow, priceBorrowInSupply);
    _supply(IERC20(_supplyAsset).balanceOf(address(this)));
    _borrow(toRepay);
  }

  function _onFlashWithdraw(
    address asset,
    uint256 amount,
    uint256 toRepay,
    uint256 redeemAmount,
    uint256 collateralToRedeem,
    uint256 priceSupplyInBorrow,
    uint256 priceBorrowInSupply
  ) internal {
    uint256 borrowed = IERC20(borrowAToken()).balanceOf(address(this));
    _repay(Math.min(amount, borrowed));
    uint256 supplied = IERC20(supplyAToken()).balanceOf(address(this));
    uint256 toRedeem;
    if (collateralToRedeem > 0) {
      toRedeem = collateralToRedeem;
    } else {
      toRedeem = (toRepay + redeemAmount) * priceBorrowInSupply / 1e18;
      toRedeem = (toRedeem * (BPS + slippageBps())) / BPS;
    }
    if (toRedeem > supplied) toRedeem = supplied;
    _redeem(toRedeem);
    address _supplyAsset = supplyAsset();
    _swap(_supplyAsset, asset, IERC20(_supplyAsset).balanceOf(address(this)), priceSupplyInBorrow, priceBorrowInSupply);
  }

  // Oracle-priced swap through the universal liquidator with a slippage floor.
  function _swap(address from, address to, uint256 amount, uint256 priceSupplyInBorrow, uint256 priceBorrowInSupply) internal {
    AaveReserveLib.swapWithSlippage(
      universalLiquidator(),
      from, to, amount,
      supplyAsset(), underlying(),
      priceSupplyInBorrow, priceBorrowInSupply,
      slippageBps()
    );
  }

  function _handleDust(PositionSnap memory s) internal {
    address _underlying = underlying();
    address _supplyAsset = supplyAsset();
    bool supplyOk = (_supplyFlags() & 2) != 0;
    uint256 baBalance = IERC20(_underlying).balanceOf(address(this));
    if (baBalance > 0) {
      uint256 borrowed = IERC20(borrowAToken()).balanceOf(address(this));
      // Repay still works under freeze; only paused/inactive blocks it.
      if (borrowed > 0) _repay(Math.min(baBalance, borrowed));
      uint256 rest = IERC20(_underlying).balanceOf(address(this));
      // Only convert leftover underlying into collateral if the collateral
      // side can actually accept it; otherwise leave the underlying idle to
      // avoid an irreversible swap into a stuck reserve.
      if (rest > 1e10 && supplyOk) {
        _swap(_underlying, _supplyAsset, rest, s.priceSupplyInBorrow, s.priceBorrowInSupply);
      }
    }
    uint256 collatBalance = IERC20(_supplyAsset).balanceOf(address(this));
    if (collatBalance > 0 && supplyOk) {
      _supply(collatBalance);
    }
  }

  // updating collateral factor
  // note 1: one should settle the loan first before calling this
  // note 2: collateralFactorDenominator is 10_000, therefore, for 20%, you need 2000
  function _setCollateralFactorNumerator(uint256 _numerator) public onlyGovernance {
    require(_numerator <= BPS, "coll-");
    require(_numerator > borrowTargetFactorNumerator(), "coll+");
    setUint256(_COLLATERALFACTORNUMERATOR_SLOT, _numerator);
  }

  function collateralFactorNumerator() public view returns (uint256) {
    return getUint256(_COLLATERALFACTORNUMERATOR_SLOT);
  }

  function setBorrowTargetFactorNumerator(uint256 _numerator) public onlyGovernance {
    require(_numerator < collateralFactorNumerator(), "Bor");
    setUint256(_BORROWTARGETFACTORNUMERATOR_SLOT, _numerator);
  }

  function borrowTargetFactorNumerator() public view returns (uint256) {
    return getUint256(_BORROWTARGETFACTORNUMERATOR_SLOT);
  }

  function setFold (bool _fold) public onlyGovernance {
    if (!_fold) {
      setBorrowTargetFactorNumerator(0);
      _redeemPartial(0, _snapPosition());
      uint256 borrowed = IERC20(borrowAToken()).balanceOf(address(this));
      require (borrowed == 0, "setFold");
    }
    setBoolean(_FOLD_SLOT, _fold);
  }

  function fold() public view returns (bool) {
    return getBoolean(_FOLD_SLOT);
  }

  function setSlippageBps (uint256 _slippageBps) public onlyGovernance {
    require(_slippageBps <= MAX_SLIPPAGE_BPS, "slip");
    setUint256(_SLIPPAGE_BPS_SLOT, _slippageBps);
  }

  function slippageBps() public view returns (uint256) {
    return getUint256(_SLIPPAGE_BPS_SLOT);
  }

  function _setSupplyAToken (address _target) internal {
    setAddress(_SUPPLY_ATOKEN_SLOT, _target);
  }

  function supplyAToken() public view returns (address) {
    return getAddress(_SUPPLY_ATOKEN_SLOT);
  }

  function _setSupplyAsset (address _target) internal {
    setAddress(_SUPPLY_ASSET_SLOT, _target);
  }

  function supplyAsset() public view returns (address) {
    return getAddress(_SUPPLY_ASSET_SLOT);
  }

  function _setBorrowAToken (address _target) internal {
    setAddress(_BORROW_ATOKEN_SLOT, _target);
  }

  function borrowAToken() public view returns (address) {
    return getAddress(_BORROW_ATOKEN_SLOT);
  }

  function finalizeUpgrade() external onlyGovernance {
    _finalizeUpgrade();
    _updateStoredBalance();
  }

  receive() external payable {}
}
