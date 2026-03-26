// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../../base/interface/IUniversalLiquidator.sol";
import "../../../base/upgradability/BaseUpgradeableStrategy.sol";
import "../../../base/interface/aave/IAToken.sol";
import "../../../base/interface/aave/IPool.sol";
import "./AaveViewer.sol";

contract Aave2AssetFoldStrategy_debtDenom is BaseUpgradeableStrategy {

  using SafeERC20 for IERC20;

  enum FlashMode { Deposit, Withdraw }

  struct FlashParams {
    FlashMode mode;
    uint256 redeemAmount;
    uint256 priceSupplyInBorrow;
    uint256 priceBorrowInSupply;
  }

  struct PositionSnap {
    uint256 borrowedDebt;
    uint256 suppliedInDebt;
    uint256 priceSupplyInBorrow;
    uint256 priceBorrowInSupply;
    uint256 health;
  }

  address public constant viewer = address(0x1e51654aB193bA165b7F7715C734dAF454f08148);
  address public constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);
  uint256 public constant BPS = 10_000;

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
    require(_slippageBps < 500, "slip");
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
    uint256 collateralLimit = _effectiveCollateralFactorNumerator();
    canExec = (
      fold() &&
      s.borrowedDebt > 0 &&
      collateralLimit <= borrowTargetFactorNumerator()
    ) || s.health < (targetHealth() * 99) / 100;
    execPayload = abi.encodeWithSelector(IController.doHardWork.selector, vault());
  }

  function _snapPosition() internal view returns (PositionSnap memory s) {
    address _supplyToken = supplyAsset();
    address _borrowToken = underlying();

    s.priceSupplyInBorrow = AaveViewer(viewer).getPrice(_supplyToken, _borrowToken);
    s.priceBorrowInSupply = AaveViewer(viewer).getPrice(_borrowToken, _supplyToken);
    
    s.borrowedDebt = IERC20(borrowAToken()).balanceOf(address(this));
    s.suppliedInDebt = (IERC20(supplyAToken()).balanceOf(address(this)) * s.priceSupplyInBorrow) / 1e18;

    s.health = AaveViewer(viewer).getPositionHealth();
  }

  function _currentBalance(PositionSnap memory s) internal pure returns (uint256) {
    return s.suppliedInDebt - s.borrowedDebt;
  }

  function targetHealth() public view returns (uint256) {
    if (!fold() || borrowTargetFactorNumerator() == 0) {
      return type(uint256).max;
    }
    uint256 collateralLimit = _effectiveCollateralFactorNumerator();
    if (collateralLimit <= borrowTargetFactorNumerator()) {
      return 1e18;
    }
    return (collateralLimit * 1e18) / borrowTargetFactorNumerator();
  }

  // function checker() external view returns (bool canExec, bytes memory execPayload) {
  //   uint256 health = MoonwellViewer(viewer).getPositionHealth(supplyMToken(), borrowMToken(), collateralFactorNumerator());
  //   canExec = health < (targetHealth() * 99) / 100;
  //   execPayload = abi.encodeWithSelector(IController.doHardWork.selector, vault());
  // }

  function storedBalance() public view returns (uint256) {
    return getUint256(_STORED_BALANCE_SLOT);
  }

  function _updateStoredBalance() internal {
    uint256 balance = _currentBalance(_snapPosition());
    setUint256(_STORED_BALANCE_SLOT, balance);
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

  function _handleFee() internal {
    PositionSnap memory s = _accrueFee();
    uint256 fee = pendingFee();
    if (fee <= 0) return;
    address _underlying = underlying();
    if (fold()) {
      if (_effectiveCollateralFactorNumerator() > borrowTargetFactorNumerator() && s.health > targetHealth()){
        _borrow(fee);
        fee = Math.min(fee, IERC20(_underlying).balanceOf(address(this)));
        uint256 balanceIncrease = (fee * feeDenominator()) / totalFeeNumerator();
        _notifyProfitInRewardToken(_underlying, balanceIncrease);
        setUint256(_PENDING_FEE_SLOT, pendingFee() - fee);
        return;
      }
    } else {
      address _supplyAsset = supplyAsset();
      uint256 toRedeem = fee * s.priceBorrowInSupply / 1e18;
      toRedeem = (toRedeem * (BPS + slippageBps())) / BPS;
      _redeem(toRedeem);
      uint256 collBalance = IERC20(_supplyAsset).balanceOf(address(this));
      if (collBalance > 0) {
        _swap(_supplyAsset, _underlying, collBalance, s.priceSupplyInBorrow, s.priceBorrowInSupply);
      }
      fee = Math.min(fee, IERC20(_underlying).balanceOf(address(this)));
      uint256 balanceIncrease = (fee * feeDenominator()) / totalFeeNumerator();
      _notifyProfitInRewardToken(_underlying, balanceIncrease);
      setUint256(_PENDING_FEE_SLOT, pendingFee() - fee);
    }
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
  */
  function _investAllUnderlying() internal onlyNotPausedInvesting {
    address _underlying = underlying();
    uint256 underlyingBalance = IERC20(_underlying).balanceOf(address(this));

    if (underlyingBalance > 0) {
      PositionSnap memory s = _snapPosition();
      address _supplyAsset = supplyAsset();
      _swap(_underlying, _supplyAsset, underlyingBalance, s.priceSupplyInBorrow, s.priceBorrowInSupply);
      _supply(IERC20(_supplyAsset).balanceOf(address(this)));
    }
    if (fold()) {
      PositionSnap memory s2 = _snapPosition();
      _depositWithFlashloan(s2);
    }
  }

  /**
  * Exits Moonwell and transfers everything to the vault.
  */
  function withdrawAllToVault() public restricted {
    address _underlying = underlying();
    _withdrawMaximum(true);
    if (IERC20(_underlying).balanceOf(address(this)) > 0) {
      IERC20(_underlying).safeTransfer(vault(), IERC20(_underlying).balanceOf(address(this)) - pendingFee());
    }
    _updateStoredBalance();
  }

  function emergencyExit() external onlyGovernance {
    _withdrawMaximum(false);
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
    _redeemPartial(toRedeem, s);

    // transfer the amount requested (or the amount we have) back to vault()
    IERC20(_underlying).safeTransfer(vault(), IERC20(_underlying).balanceOf(address(this)));
    _updateStoredBalance();
  }

  function doHardWork() public restricted {
    _handleFee();
    _investAllUnderlying();
    _updateStoredBalance();
  }

  /**
  * Redeems maximum that can be redeemed from Venus.
  * Redeem the minimum of the underlying we own, and the underlying that the vToken can
  * immediately retrieve. Ensures that `redeemMaximum` doesn't fail silently.
  *
  * DOES NOT ensure that the strategy vUnderlying balance becomes 0.
  */
  function _redeemMaximum() internal {
    _redeemMaximumWithFlashloan();
  }

  /**
  * Redeems `amountUnderlying` or fails.
  */
  function _redeemPartial(uint256 amountUnderlying, PositionSnap memory s) internal {
    // address _underlying = underlying();
    // uint256 balanceBefore = IERC20(_underlying).balanceOf(address(this));
    _redeemWithFlashloan(
      amountUnderlying,
      fold()? borrowTargetFactorNumerator():0,
      s
    );
    // uint256 balanceAfter = IERC20(_underlying).balanceOf(address(this));
    // require(balanceAfter - balanceBefore >= amountUnderlying, "with amt");
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
    address _borrowAsset = underlying();
    uint256 balance = IERC20(_borrowAsset).balanceOf(address(this));
    uint256 supplyBalance = IERC20(_supplyAsset).balanceOf(address(this));
    if (supplyBalance > 0) {
      supplyBalance = supplyBalance * AaveViewer(viewer).getPrice(_supplyAsset, _borrowAsset) / 1e18;
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
    
    uint256 availableColl = IERC20(_supplyAsset).balanceOf(_supplyAToken);
    uint256 availableDebt = availableColl * s.priceSupplyInBorrow / 1e18;

    uint256 balDebt = _currentBalance(s) - pendingFee();
    uint256 maxDebtOut = Math.min(availableDebt, balDebt);

    _redeemWithFlashloan(maxDebtOut, 0, s);
    uint256 supplied = IERC20(_supplyAToken).balanceOf(address(this));
    availableColl = IERC20(_supplyAsset).balanceOf(_supplyAToken);
    uint256 maxOut = Math.min(supplied, availableColl);
    if (maxOut > 0) {
      _redeem(maxOut);
      _swap(
        _supplyAsset,
        underlying(),
        IERC20(_supplyAsset).balanceOf(address(this)),
        s.priceSupplyInBorrow,
        s.priceBorrowInSupply
      );
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

    uint256 _targetHealth = targetHealth();
    if (s.health < (_targetHealth * 99) / 100) {
      _redeemPartial(0, s);
      return;
    }
    if (s.health < (_targetHealth * 101) / 100) {
      _handleDust(s);
      return;
    }

    uint256 balance = _currentBalance(s);
    uint256 borrowTarget = (balance * _borrowNum) / (BPS - _borrowNum);
    
    uint256 borrowDiff = 0;
    if (borrowTarget > s.borrowedDebt) {
      uint256 desiredDebtIncrease = borrowTarget - s.borrowedDebt;
      uint256 premiumBps = IPool(rewardPool()).FLASHLOAN_PREMIUM_TOTAL();
      borrowDiff = premiumBps == 0
        ? desiredDebtIncrease
        : (desiredDebtIncrease * BPS) / (BPS + premiumBps);
    }

    if (borrowDiff > 0) {
      bytes memory params = abi.encode(FlashParams({
        mode: FlashMode.Deposit,
        redeemAmount: 0,
        priceSupplyInBorrow: s.priceSupplyInBorrow,
        priceBorrowInSupply: s.priceBorrowInSupply
      }));
      IPool(rewardPool()).flashLoanSimple(
        address(this),
        underlying(),
        borrowDiff,
        params,
        0
      );
    }
    _handleDust(s);
  }

  function _redeemWithFlashloan(uint256 amount, uint256 _borrowTargetFactorNumerator, PositionSnap memory s) internal {    
    uint256 oldBalance = _currentBalance(s);
    uint256 newBalance = oldBalance - amount;

    uint256 newBorrowTarget = (newBalance * _borrowTargetFactorNumerator) / (BPS - _borrowTargetFactorNumerator);
    
    uint256 borrowDiff = 0;
    if (s.borrowedDebt > newBorrowTarget) {
      borrowDiff = s.borrowedDebt - newBorrowTarget;
    }
    
    if (borrowDiff > 0) {
      bytes memory params = abi.encode(FlashParams({
        mode: FlashMode.Withdraw,
        redeemAmount: amount,
        priceSupplyInBorrow: s.priceSupplyInBorrow,
        priceBorrowInSupply: s.priceBorrowInSupply
      }));
      IPool(rewardPool()).flashLoanSimple(
        address(this),
        underlying(),
        borrowDiff,
        params,
        0
      );
    } else {
      uint256 collToRedeem = (amount * s.priceBorrowInSupply) / 1e18;
      if (collToRedeem > 0) {
        _redeem(collToRedeem);
      }

      address coll = supplyAsset();
      uint256 collBal = IERC20(coll).balanceOf(address(this));
      if (collBal > 0) {
        _swap(coll, underlying(), collBal, s.priceSupplyInBorrow, s.priceBorrowInSupply);
      }
    }
  }

  function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes memory params) external nonReentrant() returns (bool) {
    address _aavePool = rewardPool();
    require(msg.sender == _aavePool, "!pool");
    require(initiator == address(this), "!sender");
    FlashParams memory flashParams = abi.decode(params, (FlashParams));
    uint256 toRepay = amount + premium;
    
    if (flashParams.mode == FlashMode.Deposit){
      _onFlashDeposit(asset, amount, toRepay, flashParams.priceSupplyInBorrow, flashParams.priceBorrowInSupply);
    } else {
      _onFlashWithdraw(asset, amount, toRepay, flashParams.redeemAmount, flashParams.priceSupplyInBorrow, flashParams.priceBorrowInSupply);
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

  function _onFlashWithdraw(address asset, uint256 amount, uint256 toRepay, uint256 redeemAmount, uint256 priceSupplyInBorrow, uint256 priceBorrowInSupply) internal {
    address _borrowAToken = borrowAToken();
    uint256 borrowed = IERC20(_borrowAToken).balanceOf(address(this));
    uint256 repaying = Math.min(amount, borrowed);
    _repay(repaying);
    uint256 toRedeem = (toRepay + redeemAmount) * priceBorrowInSupply / 1e18;
    toRedeem = (toRedeem * (BPS + slippageBps())) / BPS;
    uint256 supplied = IERC20(supplyAToken()).balanceOf(address(this));
    toRedeem = Math.min(toRedeem, supplied);
    _redeem(toRedeem);
    address _supplyAsset = supplyAsset();
    uint256 supplyAssetBalance = IERC20(_supplyAsset).balanceOf(address(this));
    _swap(_supplyAsset, asset, supplyAssetBalance, priceSupplyInBorrow, priceBorrowInSupply);
  }

  function _minOut(
    address from,
    address to,
    uint256 amount,
    uint256 priceSupplyInBorrow,
    uint256 priceBorrowInSupply
  ) internal view returns (uint256) {
    uint256 bps = BPS - slippageBps();
    address _underlying = underlying();
    address _supplyAsset = supplyAsset();
    if (from == _supplyAsset && to == _underlying) {
      uint256 oracleOut = (amount * priceSupplyInBorrow) / 1e18;
      return (oracleOut * bps) / BPS;
    }
    if (from == _underlying && to == _supplyAsset) {
      uint256 oracleOut = (amount * priceBorrowInSupply) / 1e18;
      return (oracleOut * bps) / BPS;
    }
    revert("pair");
  }

  function _swap(address from, address to, uint256 amount, uint256 priceSupplyInBorrow, uint256 priceBorrowInSupply) internal {
    address _universalLiquidator = universalLiquidator();
    IERC20(from).safeApprove(_universalLiquidator, 0);
    IERC20(from).safeApprove(_universalLiquidator, amount);
    uint256 minOut = _minOut(from, to, amount, priceSupplyInBorrow, priceBorrowInSupply);
    IUniversalLiquidator(_universalLiquidator).swap(from, to, amount, minOut, address(this));
  }

  function _handleDust(PositionSnap memory s) internal {
    uint256 baBalance = IERC20(underlying()).balanceOf(address(this));
    uint256 borrowed = IERC20(borrowAToken()).balanceOf(address(this));
    if (baBalance > 0) {
      if (borrowed > 0) _repay(Math.min(baBalance, borrowed));
      uint256 rest = IERC20(underlying()).balanceOf(address(this));
      if (rest > 1e10) {
        _swap(underlying(), supplyAsset(), rest, s.priceSupplyInBorrow, s.priceBorrowInSupply);
      }
    }
    uint256 collatBalance = IERC20(supplyAsset()).balanceOf(address(this));
    if (collatBalance > 0) {
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

  function _effectiveCollateralFactorNumerator() internal view returns (uint256) {
    (,,,uint256 liquidationThreshold,,) = IPool(rewardPool()).getUserAccountData(address(this));
    return Math.min(collateralFactorNumerator(), liquidationThreshold);
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
    require(_slippageBps <= 500, "slip");
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
