// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/IERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/utils/ERC721HolderUpgradeable.sol";
import "./interface/IStrategy.sol";
import "./interface/IController.sol";
import "./interface/IUpgradeSource.sol";
import "./interface/IUniversalLiquidator.sol";
import "./interface/ICLRebalanceHelper.sol";
import "./inheritance/ControllableInit.sol";
import "./CLVaultStorage.sol";
import "./interface/concentrated-liquidity/INonfungiblePositionManager.sol";
import "./interface/concentrated-liquidity/IFactory.sol";
import "./interface/concentrated-liquidity/IPool.sol";
import "./interface/concentrated-liquidity/TickMath.sol";
import "./interface/concentrated-liquidity/LiquidityAmounts.sol";

contract CLVault is ERC20Upgradeable, ERC721HolderUpgradeable, IUpgradeSource, ControllableInit, CLVaultStorage {
  using SafeERC20Upgradeable for IERC20Upgradeable;

  uint256 private constant _BPS_DENOMINATOR = 10_000;

  struct WithdrawCache {
    uint256 supplyBefore;
    uint256 idleShare0;
    uint256 idleShare1;
    uint128 liquidityShare;
    uint256 received0;
    uint256 received1;
    uint256 payout0;
    uint256 payout1;
  }

  /**
   * Caller has exchanged assets for shares, and transferred those shares to owner.
   *
   * MUST be emitted when tokens are deposited into the Vault via the mint and deposit methods.
   */
  event Deposit(
      address indexed sender,
      address indexed receiver,
      uint256 amount0,
      uint256 amount1,
      uint256 shares
  );

  /**
   * Caller has exchanged shares, owned by owner, for assets, and transferred those assets to receiver.
   *
   * MUST be emitted when shares are withdrawn from the Vault in ERC4626.redeem or ERC4626.withdraw methods.
   */
  event Withdraw(
      address indexed sender,
      address indexed receiver,
      address indexed owner,
      uint256 amount0,
      uint256 amount1,
      uint256 shares
  );
  event StrategyAnnounced(address newStrategy, uint256 time);
  event StrategyChanged(address newStrategy, address oldStrategy);
  event Rebalanced(
      uint256 oldPosId,
      uint256 newPosId,
      uint256 oldLiquidity,
      uint256 newLiquidity,
      uint256 timestamp
  );
  event LanePauseUpdated(bool pauseDepositWithdraw, bool pauseHarvest, bool pauseRebalance, bool withdrawOnly);
  event RebalanceConfigUpdated(
    uint256 deviation,
    uint256 cooldown,
    address executor
  );
  event RebalanceSafetyConfigUpdated(uint256 maxSwapBps, uint256 maxSlippageBps, uint32 twapWindow, uint256 maxTwapDeviationBps);
  event RebalanceHelperUpdated(address helper);
  event HarvestExecuted(uint256 timestamp, address indexed caller);

  error ErrTargetWidth();
  error ErrStrategyUndefined();
  error ErrNotRebalanceExecutor();
  error ErrDepositWithdrawPaused();
  error ErrHarvestPaused();
  error ErrRebalancePaused();
  error ErrWithdrawOnly();
  error ErrTimelock();
  error ErrVault();
  error ErrZeroAddress();
  error ErrPositionNotInVault();
  error ErrSlippage();
  error ErrTotalSupply();
  error ErrZeroShares();
  error ErrRebalanceCooldown();


  constructor() {
  }

  // the function is name differently to not cause inheritance clash in truffle and allows tests
  function initializeVault(
    address _storage,
    uint256 _posId,
    address _posManager,
    uint256 _targetWidth
  ) public initializer {
    ControllableInit.initialize(_storage);

    IERC721Upgradeable(_posManager).transferFrom(msg.sender, address(this), _posId);
    
    (,,
      address _token0,
      address _token1,
      int24 _tickSpacing,
      int24 _tickLower,
      int24 _tickUpper,
      uint256 _initialLiquidity,
    ,,,) = INonfungiblePositionManager(_posManager).positions(_posId);

    uint256 positionWidth = uint256(int256(_tickUpper) - int256(_tickLower)) / uint256(uint24(_tickSpacing));
    if (!(_targetWidth <= positionWidth)) revert ErrTargetWidth();

    CLVaultStorage.initialize(_posId, _posManager, positionWidth, _targetWidth);

    __ERC20_init(
      string(abi.encodePacked("fCL_", ERC20Upgradeable(_token0).symbol(), "_", ERC20Upgradeable(_token1).symbol())),
      string(abi.encodePacked("fCL_", ERC20Upgradeable(_token0).symbol(), "_", ERC20Upgradeable(_token1).symbol()))
    );

    _setToken0(_token0);
    _setToken1(_token1);
    _setTickSpacing(_tickSpacing);
    _setTickLower(_tickLower);
    _setTickUpper(_tickUpper);

    _mint(msg.sender, _initialLiquidity);
  }

  function strategy() external view returns(address) {
    return _strategy();
  }

  function token0() external view returns(address) {
    return _token0();
  }

  function token1() external view returns(address) {
    return _token1();
  }

  function posManager() external view returns(address) {
    return _posManager();
  }

  function posId() external view returns(uint256) {
    return _posId();
  }

  function targetWidth() external view returns(uint256) {
    return _targetWidth();
  }

  function setTargetWidth(uint256 _target) external onlyGovernance {
    if (!(_target <= _posWidth())) revert ErrTargetWidth();
    _setTargetWidth(_target);
  }

  function tickLower() external view returns(int24) {
    return _tickLower();
  }

  function tickUpper() external view returns(int24) {
    return _tickUpper();
  }

  function tickSpacing() external view returns(int24) {
    return _tickSpacing();
  }

  function underlyingUnit() external view returns(uint256) {
    return _underlyingUnit();
  }

  function nextImplementation() external view returns(address) {
    return _nextImplementation();
  }

  function nextImplementationTimestamp() external view returns(uint256) {
    return _nextImplementationTimestamp();
  }

  function _nextImplementationDelay() internal view returns (uint256) {
    return IController(controller()).nextImplementationDelay();
  }

  modifier whenStrategyDefined() {
    if (!(address(_strategy()) != address(0))) revert ErrStrategyUndefined();
    _;
  }

  modifier onlyRebalanceExecutor() {
    if (
      !(
        msg.sender == governance() ||
        msg.sender == controller() ||
        msg.sender == _rebalanceExecutor()
      )
    ) revert ErrNotRebalanceExecutor();
    _;
  }

  modifier whenDepositWithdrawEnabled() {
    if (_pauseDepositWithdraw()) revert ErrDepositWithdrawPaused();
    _;
  }

  modifier whenHarvestEnabled() {
    if (_pauseHarvest()) revert ErrHarvestPaused();
    _;
  }

  modifier whenRebalanceEnabled() {
    if (_pauseRebalance()) revert ErrRebalancePaused();
    _;
  }

  /**
  * Chooses the best strategy and re-invests. If the strategy did not change, it just calls
  * doHardWork on the current strategy. Call this through controller to claim hard rewards.
  */
  function doHardWork() nonReentrant whenStrategyDefined whenHarvestEnabled onlyControllerOrGovernance external {
    if (_withdrawOnly()) revert ErrWithdrawOnly();
    if (_positionOwnedByVault()) {
      IERC721Upgradeable(_posManager()).transferFrom(address(this), _strategy(), _posId());
    }
    IStrategy(_strategy()).doHardWork();
    emit HarvestExecuted(block.timestamp, msg.sender);
  }

  /* Returns the current underlying (e.g., DAI's) balance together with
   * the invested amount (if DAI is invested elsewhere by the strategy).
  */
  function underlyingBalanceWithInvestment() view public returns (uint256) {
    (,,,,,,, uint128 liquidity,,,,) = INonfungiblePositionManager(_posManager()).positions(_posId());
    uint256 liquidityU = uint256(liquidity);
    if (liquidityU == 0) {
      return 0;
    }

    (uint256 amount0InLiquidity, uint256 amount1InLiquidity) = LiquidityAmounts.getAmountsForLiquidity(
      getSqrtPriceX96(),
      TickMath.getSqrtRatioAtTick(_tickLower()),
      TickMath.getSqrtRatioAtTick(_tickUpper()),
      liquidity
    );

    uint256 totalIn1Liquidity = _toToken1Value(amount0InLiquidity, amount1InLiquidity);
    if (totalIn1Liquidity == 0) {
      return liquidityU;
    }

    uint256 idleIn1 = _toToken1Value(
      IERC20Upgradeable(_token0()).balanceOf(address(this)),
      IERC20Upgradeable(_token1()).balanceOf(address(this))
    );
    if (idleIn1 == 0) {
      return liquidityU;
    }

    uint256 extraLiquidityEquivalent = (liquidityU * idleIn1) / totalIn1Liquidity;
    return liquidityU + extraLiquidityEquivalent;
  }

  function getPricePerFullShare() external view returns (uint256) {
    return totalSupply() == 0
      ? _underlyingUnit()
      : (_underlyingUnit() * underlyingBalanceWithInvestment()) / totalSupply();
  }

  function _canUpdateStrategy(address __strategy) internal view returns (bool) {
    bool isStrategyNotSetYet = _strategy() == address(0);
    bool hasTimelockPassed = block.timestamp > _nextStrategyTimestamp() && _nextStrategyTimestamp() != 0;
    return isStrategyNotSetYet || (__strategy == _nextStrategy() && hasTimelockPassed);
  }

  /**
  * Indicates that the strategy update will happen in the future
  */
  function announceStrategyUpdate(address _strategy) external onlyControllerOrGovernance {
    // records a new timestamp
    uint256 when = block.timestamp + _nextImplementationDelay();
    _setNextStrategyTimestamp(when);
    _setNextStrategy(_strategy);
    emit StrategyAnnounced(_strategy, when);
  }

  /**
  * Finalizes (or cancels) the strategy update by resetting the data
  */
  function _finalizeStrategyUpdate() internal {
    _setNextStrategyTimestamp(0);
    _setNextStrategy(address(0));
  }

  function setStrategy(address __strategy) external onlyControllerOrGovernance {
    if (!_canUpdateStrategy(__strategy)) revert ErrTimelock();
    if (!(__strategy != address(0))) revert ErrZeroAddress();
    if (!(IStrategy(__strategy).vault() == address(this))) revert ErrVault();

    emit StrategyChanged(__strategy, _strategy());
    if (address(__strategy) != address(_strategy())) {
      if (address(_strategy()) != address(0)) { // if the original strategy (no underscore) is defined
        IStrategy(_strategy()).withdrawAllToVault(true);
      }
      _setStrategy(__strategy);
    }
    _finalizeStrategyUpdate();
  }

  function setLanePause(
    bool _pauseDepositWithdrawValue,
    bool _pauseHarvestValue,
    bool _pauseRebalanceValue,
    bool _withdrawOnlyValue
  ) external onlyGovernance {
    _setPauseDepositWithdraw(_pauseDepositWithdrawValue);
    _setPauseHarvest(_pauseHarvestValue);
    _setPauseRebalance(_pauseRebalanceValue);
    _setWithdrawOnly(_withdrawOnlyValue);
    emit LanePauseUpdated(_pauseDepositWithdrawValue, _pauseHarvestValue, _pauseRebalanceValue, _withdrawOnlyValue);
  }

  function setRebalanceConfig(
    uint256 _deviation,
    uint256 _cooldown,
    address _executor
  ) external onlyGovernance {
    _setRebalanceDeviation(_deviation);
    _setRebalanceCooldown(_cooldown);
    _setRebalanceExecutor(_executor);
    emit RebalanceConfigUpdated(_deviation, _cooldown, _executor);
  }

  function setRebalanceSafetyConfig(
    uint256 _maxSwapBpsValue,
    uint256 _maxSlippageBpsValue,
    uint32 _twapWindowValue,
    uint256 _maxTwapDeviationBpsValue
  ) external onlyGovernance {
    if (_maxSwapBpsValue > _BPS_DENOMINATOR) revert ErrSlippage();
    if (_maxSlippageBpsValue > _BPS_DENOMINATOR) revert ErrSlippage();
    if (_maxTwapDeviationBpsValue > _BPS_DENOMINATOR) revert ErrSlippage();
    _setMaxSwapBps(_maxSwapBpsValue);
    _setMaxSlippageBps(_maxSlippageBpsValue);
    _setTwapWindow(_twapWindowValue);
    _setMaxTwapDeviationBps(_maxTwapDeviationBpsValue);
    emit RebalanceSafetyConfigUpdated(_maxSwapBpsValue, _maxSlippageBpsValue, _twapWindowValue, _maxTwapDeviationBpsValue);
  }

  function setRebalanceHelper(address helper) external onlyGovernance {
    _setRebalanceHelper(helper);
    emit RebalanceHelperUpdated(helper);
  }

  function rebalanceHelper() external view returns (address) {
    return _rebalanceHelper();
  }

  /*
  * Allows for depositing the underlying asset in exchange for shares.
  * Approval is assumed.
  */
  function deposit(uint256 amount0, uint256 amount1, uint256 amountOutMin, address receiver) external nonReentrant whenDepositWithdrawEnabled returns (uint256 minted) {
    if (_withdrawOnly()) revert ErrWithdrawOnly();
    minted = _deposit(amount0, amount1, amountOutMin, msg.sender, receiver);
  }

  function withdraw(uint256 shares, uint256 amount0OutMin, uint256 amount1OutMin) external nonReentrant whenDepositWithdrawEnabled returns (uint256 amount0, uint256 amount1) {
    (amount0, amount1) = _withdraw(shares, amount0OutMin, amount1OutMin, msg.sender);
  }

  function withdrawAll(bool compound) public onlyControllerOrGovernance whenStrategyDefined {
    IStrategy(_strategy()).withdrawAllToVault(compound);
  }

  function _deposit(uint256 amount0, uint256 amount1, uint256 amountOutMin, address sender, address beneficiary) internal returns (uint256) {
    if (!(beneficiary != address(0))) revert ErrZeroAddress();
    _ensurePositionInVault();

    address _token0 = _token0();
    address _token1 = _token1();
    uint256 balance0Before = IERC20Upgradeable(_token0).balanceOf(address(this));
    uint256 balance1Before = IERC20Upgradeable(_token1).balanceOf(address(this));
    IERC20Upgradeable(_token0).safeTransferFrom(sender, address(this), amount0);
    IERC20Upgradeable(_token1).safeTransferFrom(sender, address(this), amount1);
    
    uint256 liquidityBefore = underlyingBalanceWithInvestment();
    uint128 _liquidity = _increasePositionLiquidity(amount0, amount1);

    uint256 toMint = totalSupply() == 0
      ? uint256(_liquidity)
      : (uint256(_liquidity) * totalSupply()) / liquidityBefore;
    
    if (!(toMint >= amountOutMin)) revert ErrSlippage();
    
    _mint(beneficiary, toMint);
    emit Deposit(sender, beneficiary, amount0, amount1, toMint);

    _transferUnusedDepositTo(beneficiary, balance0Before, balance1Before);
    return toMint;
  }

  function _increasePositionLiquidity(uint256 amount0, uint256 amount1) internal returns (uint128 liquidityAdded) {
    address token0Address = _token0();
    address token1Address = _token1();
    address positionManager = _posManager();
    _setApproval(token0Address, positionManager, amount0);
    _setApproval(token1Address, positionManager, amount1);

    (liquidityAdded,,) = INonfungiblePositionManager(positionManager).increaseLiquidity(
      INonfungiblePositionManager.IncreaseLiquidityParams({
        tokenId: _posId(),
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0,
        amount1Min: 0,
        deadline: block.timestamp
      })
    );
  }

  function _withdraw(uint256 numberOfShares, uint256 amount0OutMin, uint256 amount1OutMin, address receiver) internal returns (uint256, uint256) {
    if (!(totalSupply() > 0)) revert ErrTotalSupply();
    if (!(numberOfShares > 0)) revert ErrZeroShares();
    _ensurePositionInVault();

    WithdrawCache memory vars;
    vars.supplyBefore = totalSupply();
    vars.idleShare0 = (IERC20Upgradeable(_token0()).balanceOf(address(this)) * numberOfShares) / vars.supplyBefore;
    vars.idleShare1 = (IERC20Upgradeable(_token1()).balanceOf(address(this)) * numberOfShares) / vars.supplyBefore;
    vars.liquidityShare = uint128((_positionLiquidity() * numberOfShares) / vars.supplyBefore);
    _burn(msg.sender, numberOfShares);

    (vars.received0, vars.received1) = _removeFromPosition(vars.liquidityShare, amount0OutMin, amount1OutMin);
    vars.payout0 = vars.received0 + vars.idleShare0;
    vars.payout1 = vars.received1 + vars.idleShare1;
    _safeTransferIfPositive(_token0(), receiver, vars.payout0);
    _safeTransferIfPositive(_token1(), receiver, vars.payout1);
    emit Withdraw(msg.sender, receiver, msg.sender, vars.payout0, vars.payout1, numberOfShares);

    return (vars.payout0, vars.payout1);
  }

  function _removeFromPosition(uint128 liquidityAmount, uint256 amount0Min, uint256 amount1Min) internal returns (uint256, uint256) {
    address _posManager = _posManager();
    uint256 _posId = _posId();
    bool withdrawAllLiquidity = false;
    if (uint256(liquidityAmount) == _positionLiquidity()) {
      withdrawAllLiquidity = true;
    }

    // withdraw liquidity from the NFT
    (uint256 _receivedToken0, uint256 _receivedToken1) = INonfungiblePositionManager(_posManager).decreaseLiquidity(
      INonfungiblePositionManager.DecreaseLiquidityParams({
        tokenId: _posId,
        liquidity: liquidityAmount,
        amount0Min: amount0Min,
        amount1Min: amount1Min,
        deadline: block.timestamp
      })
    );
    uint128 collectAmount0;
    uint128 collectAmount1;
    if (withdrawAllLiquidity) {
      collectAmount0 = type(uint128).max;
      collectAmount1 = type(uint128).max;
    } else {
      collectAmount0 = uint128(_receivedToken0);
      collectAmount1 = uint128(_receivedToken1);
    }
    // collect the amount fetched above
    INonfungiblePositionManager(_posManager).collect(
      INonfungiblePositionManager.CollectParams({
        tokenId: _posId,
        recipient: address(this),
        amount0Max: collectAmount0, // collect all token0 accounted for the liquidity
        amount1Max: collectAmount1 // collect all token1 accounted for the liquidity
      })
    );
    return(_receivedToken0, _receivedToken1);
  }

  /**
     * @dev Handles transferring the leftovers
     */
  function _transferLeftOverTo(address _to) internal {
    address _token0 = _token0();
    address _token1 = _token1();
    uint256 balance0 = IERC20Upgradeable(_token0).balanceOf(address(this));
    uint256 balance1 = IERC20Upgradeable(_token1).balanceOf(address(this));
    _safeTransferIfPositive(_token0, _to, balance0);
    _safeTransferIfPositive(_token1, _to, balance1);
  }

  function _transferUnusedDepositTo(address _to, uint256 balance0Before, uint256 balance1Before) internal {
    address _token0 = _token0();
    address _token1 = _token1();
    uint256 balance0 = IERC20Upgradeable(_token0).balanceOf(address(this));
    uint256 balance1 = IERC20Upgradeable(_token1).balanceOf(address(this));
    if (balance0 > balance0Before) {
      _safeTransferIfPositive(_token0, _to, balance0 - balance0Before);
    }
    if (balance1 > balance1Before) {
      _safeTransferIfPositive(_token1, _to, balance1 - balance1Before);
    }
  }

  function _safeTransferIfPositive(address token, address receiver, uint256 amount) internal {
    if (amount > 0) {
      IERC20Upgradeable(token).safeTransfer(receiver, amount);
    }
  }

  function _positionLiquidity() internal view returns (uint256) {
    (,,,,,,, uint128 liquidity,,,,) = INonfungiblePositionManager(_posManager()).positions(_posId());
    return uint256(liquidity);
  }

  function _positionOwnedByVault() internal view returns (bool) {
    return INonfungiblePositionManager(_posManager()).ownerOf(_posId()) == address(this);
  }

  function _ensurePositionInVault() internal {
    if (_positionOwnedByVault()) {
      return;
    }
    address currentStrategy = _strategy();
    if (currentStrategy == address(0)) revert ErrPositionNotInVault();
    IStrategy(currentStrategy).withdrawAllToVault(false);
    if (!_positionOwnedByVault()) revert ErrPositionNotInVault();
  }

  function _toToken1Value(uint256 amount0, uint256 amount1) internal view returns (uint256) {
    if (amount0 == 0) {
      return amount1;
    }
    uint256 sqrtPrice = uint256(getSqrtPriceX96());
    uint256 price0In1 = (sqrtPrice * sqrtPrice * 1e18) / uint256(2 ** (96 * 2));
    return (amount0 * price0In1) / 1e18 + amount1;
  }

  function sweepDust() external onlyControllerOrGovernance {
    _transferLeftOverTo(governance());
  }

  /**
  * @dev Convenience getter for the current sqrtPriceX96 of the Uniswap pool.
  */
  function getSqrtPriceX96() public view returns (uint160 sqrtPriceX96) {
    (sqrtPriceX96,,,,,) = IPool(_poolAddress()).slot0();
  }

  function _getCurrentTick() internal view returns (int24 currenTick) {
    (,currenTick,,,,) = IPool(_poolAddress()).slot0();
  }

  function checker() external view returns (bool canExec, bytes memory execPayload) {
    address helper = _rebalanceHelper();
    if (helper == address(0)) {
      canExec = false;
    } else {
      canExec = ICLRebalanceHelper(helper).shouldRebalance(
        _poolAddress(),
        _tickLower(),
        _tickUpper(),
        _tickSpacing(),
        _posWidth(),
        _targetWidth(),
        _lastRebalance(),
        _rebalanceCooldown(),
        _rebalanceDeviation(),
        block.timestamp
      );
    }
    execPayload = abi.encodeWithSelector(this.rebalanceCurrentTick.selector, _targetWidth());
  }

  function rebalanceCurrentTick(uint256 _newPosWidth) public onlyRebalanceExecutor whenRebalanceEnabled {
    uint256 deadline = block.timestamp + 900;
    if (_withdrawOnly()) revert ErrWithdrawOnly();
    if (!(block.timestamp >= _lastRebalance() + _rebalanceCooldown())) revert ErrRebalanceCooldown();
    if (!(_newPosWidth <= _posWidth())) revert ErrTargetWidth();
    _ensurePositionInVault();
    uint256 oldLiquidity = underlyingBalanceWithInvestment();
    uint256 oldPosId = _posId();
    int24 currentTick = _getCurrentTick();

    (int24 tickLowerNew, int24 tickUpperNew) = _getNewTickLimits(currentTick, int24(int256(_newPosWidth)));
    if (tickLowerNew == _tickLower() && tickUpperNew == _tickUpper()) {
      return;
    }
    
    _removeFromPosition(uint128(_positionLiquidity()), 0, 0);
    INonfungiblePositionManager(_posManager()).burn(oldPosId);
    _rebalanceIdleBalancesWithGuards();

    uint256 tokenId = _createNewPosition(tickLowerNew, tickUpperNew, 0, 0, deadline);

    _setPosId(tokenId);
    _setTickLower(tickLowerNew);
    _setTickUpper(tickUpperNew);
    _setPosWidth(_newPosWidth);
    if (_newPosWidth < _targetWidth()) {
      _setTargetWidth(_newPosWidth);
    }
    _setLastRebalance(block.timestamp);

    if (_strategy() != address(0)) {
      _transferLeftOverTo(_strategy());
    } else {
      _transferLeftOverTo(governance());
    }

    emit Rebalanced(oldPosId, tokenId, oldLiquidity, underlyingBalanceWithInvestment(), block.timestamp);
  }

  function _createNewPosition(
    int24 _tickLower,
    int24 _tickUpper,
    uint256 amount0Min,
    uint256 amount1Min,
    uint256 deadline
  ) internal returns (uint256 tokenId) {
    address _token0 = _token0();
    address _token1 = _token1();
    uint256 amount0 = IERC20Upgradeable(_token0).balanceOf(address(this));
    uint256 amount1 = IERC20Upgradeable(_token1).balanceOf(address(this));
    address _posManager = _posManager();
    _setApproval(_token0, _posManager, amount0);
    _setApproval(_token1, _posManager, amount1);

    (tokenId,,,) = INonfungiblePositionManager(_posManager).mint(
      INonfungiblePositionManager.MintParams({
        token0: _token0,
        token1: _token1,
        tickSpacing: _tickSpacing(),
        tickLower: _tickLower,
        tickUpper: _tickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: amount0Min,
        amount1Min: amount1Min,
        recipient: address(this),
        deadline: deadline,
        sqrtPriceX96: 0
      })
    );
  }

  function _setApproval(address token, address spender, uint256 amount) internal {
    IERC20Upgradeable(token).safeApprove(spender, 0);
    IERC20Upgradeable(token).safeApprove(spender, amount);
  }

  function _getNewTickLimits(int24 middle, int24 _posWidth) internal view returns (int24 tickLowerNew, int24 tickUpperNew) {
    int24 _tickSpacing = _tickSpacing();
    
    int24 middleTickTrunc;
    uint160 currentSqrtPrice = getSqrtPriceX96();
    uint160 tickSqrtPrice = TickMath.getSqrtRatioAtTick(middle / _tickSpacing * _tickSpacing);
    if (currentSqrtPrice > tickSqrtPrice) {
      middleTickTrunc = middle / _tickSpacing;
    } else {
      middleTickTrunc = middle / _tickSpacing - 1;
    }

    int24 tickLowerNewTrunc;
    if (_posWidth == 1) {
      tickLowerNewTrunc = middleTickTrunc;
    } else {
      tickLowerNewTrunc = middleTickTrunc - _posWidth / 2;
    }
    int24 tickUpperNewTrunc = tickLowerNewTrunc + _posWidth;

    tickLowerNew = tickLowerNewTrunc * _tickSpacing;
    tickUpperNew = tickUpperNewTrunc * _tickSpacing;
  }

  function _poolAddress() internal view returns (address) {
    address factory = INonfungiblePositionManager(_posManager()).factory();
    return IFactory(factory).getPool(_token0(), _token1(), _tickSpacing());
  }

  function _rebalanceIdleBalancesWithGuards() internal {
    address helper = _rebalanceHelper();
    if (helper == address(0)) {
      return;
    }
    uint256 balance0 = IERC20Upgradeable(_token0()).balanceOf(address(this));
    uint256 balance1 = IERC20Upgradeable(_token1()).balanceOf(address(this));
    if (balance0 == 0 || balance1 == 0) {
      return;
    }
    ICLRebalanceHelper.RebalanceSwapPlan memory plan = ICLRebalanceHelper(helper).planSwap(
      _poolAddress(),
      balance0,
      balance1,
      _maxSwapBps(),
      _maxSlippageBps(),
      _twapWindow(),
      _maxTwapDeviationBps()
    );
    if (!plan.shouldSwap) {
      return;
    }
    if (plan.zeroForOne) {
      _swapForRebalance(_token0(), _token1(), plan.amountIn, plan.minOut);
    } else {
      _swapForRebalance(_token1(), _token0(), plan.amountIn, plan.minOut);
    }
  }

  function _swapForRebalance(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut) internal {
    if (amountIn == 0 || minOut == 0) {
      return;
    }
    address liquidator = IController(controller()).universalLiquidator();
    _setApproval(tokenIn, liquidator, amountIn);
    IUniversalLiquidator(liquidator).swap(tokenIn, tokenOut, amountIn, minOut, address(this));
  }


  /**
  * Schedules an upgrade for this vault's proxy.
  */
  function scheduleUpgrade(address impl) public onlyGovernance {
    _setNextImplementation(impl);
    _setNextImplementationTimestamp(block.timestamp + _nextImplementationDelay());
  }

  function shouldUpgrade() external view override returns (bool, address) {
    return (
      _nextImplementationTimestamp() != 0
        && block.timestamp > _nextImplementationTimestamp()
        && _nextImplementation() != address(0),
      _nextImplementation()
    );
  }

  function finalizeUpgrade() external override onlyGovernance {
    _setNextImplementation(address(0));
    _setNextImplementationTimestamp(0);
  }
}
