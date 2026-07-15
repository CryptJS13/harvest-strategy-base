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

  /// @notice Emitted on every successful two-token deposit. `shares` is the amount minted to
  /// `receiver`; `amount0`/`amount1` are the caller-supplied desired amounts (leftover beyond
  /// what the position consumed is returned to the receiver in the same transaction).
  event Deposit(
      address indexed sender,
      address indexed receiver,
      uint256 amount0,
      uint256 amount1,
      uint256 shares
  );

  /// @notice Emitted on every successful withdraw. `amount0`/`amount1` are the actual payouts
  /// (proportional position liquidity plus the withdrawer's share of any idle balances).
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
  error ErrProtectedToken();


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

  function tickLower() external view returns(int24) {
    return _tickLower();
  }

  function tickUpper() external view returns(int24) {
    return _tickUpper();
  }

  function tickSpacing() external view returns(int24) {
    return _tickSpacing();
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

  /// @notice Liquidity-equivalent value of the active position plus any idle balances. "Idle"
  /// covers BOTH the vault's own token0/token1 balance AND the strategy's, because the strategy
  /// may temporarily hold dust between compound cycles (e.g. token0 left over after an AERO swap
  /// that couldn't yet value-balance into token1). That dust ultimately belongs to vault
  /// shareholders, so it must contribute to NAV / PPS — and `preInteract` will physically sweep
  /// it into the vault on the next user deposit/withdraw, keeping the actual payout consistent
  /// with this read. Quoting math lives in CLRebalanceHelper to keep CLVault under the deploy
  /// limit.
  function underlyingBalanceWithInvestment() public view returns (uint256) {
    (,,,,,,, uint128 liquidity,,,,) = INonfungiblePositionManager(_posManager()).positions(_posId());
    address t0 = _token0();
    address t1 = _token1();
    uint256 idle0 = IERC20Upgradeable(t0).balanceOf(address(this));
    uint256 idle1 = IERC20Upgradeable(t1).balanceOf(address(this));
    address strat = _strategy();
    if (strat != address(0)) {
      idle0 += IERC20Upgradeable(t0).balanceOf(strat);
      idle1 += IERC20Upgradeable(t1).balanceOf(strat);
    }
    return ICLRebalanceHelper(_rebalanceHelper()).quoteUnderlyingBalanceWithInvestment(
      getSqrtPriceX96(),
      _tickLower(),
      _tickUpper(),
      liquidity,
      idle0,
      idle1
    );
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

  function setStrategy(address __strategy) external onlyControllerOrGovernance {
    if (!_canUpdateStrategy(__strategy)) revert ErrTimelock();
    if (!(__strategy != address(0))) revert ErrZeroAddress();
    if (!(IStrategy(__strategy).vault() == address(this))) revert ErrVault();

    emit StrategyChanged(__strategy, _strategy());
    if (address(__strategy) != address(_strategy())) {
      if (address(_strategy()) != address(0)) {
        IStrategy(_strategy()).withdrawAllToVault(true);
      }
      _setStrategy(__strategy);
    }
    _setNextStrategyTimestamp(0);
    _setNextStrategy(address(0));
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

  /// @dev Helper is required by deposit/withdraw/PPS reads and rebalance. Setting it to address(0)
  /// would brick deposits and PPS, so we reject zero outright. Governance can always swap to a
  /// new non-zero helper instead.
  function setRebalanceHelper(address helper) external onlyGovernance {
    if (helper == address(0)) revert ErrZeroAddress();
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
    minted = _deposit(amount0, amount1, amountOutMin, receiver);
  }

  function withdraw(uint256 shares, uint256 amount0OutMin, uint256 amount1OutMin) external nonReentrant whenDepositWithdrawEnabled returns (uint256 amount0, uint256 amount1) {
    (amount0, amount1) = _withdraw(shares, amount0OutMin, amount1OutMin);
  }

  function _deposit(uint256 amount0, uint256 amount1, uint256 amountOutMin, address beneficiary) internal returns (uint256) {
    if (!(beneficiary != address(0))) revert ErrZeroAddress();
    _ensurePositionInVault();
    _sweepStrategyDust();

    address t0 = _token0();
    address t1 = _token1();
    address pm = _posManager();
    // NAV must be measured BEFORE the user's tokens land in the vault. If we read it after the
    // safeTransferFrom calls, the user's own contribution shows up as idle in NAV and dilutes
    // their share-mint ratio (toMint = liq * supply / liquidityBefore), transferring value to
    // every other shareholder. Round-trip benchmark showed ~5%-of-deposit loss from this.
    uint256 liquidityBefore = underlyingBalanceWithInvestment();
    uint256 balance0Before = IERC20Upgradeable(t0).balanceOf(address(this));
    uint256 balance1Before = IERC20Upgradeable(t1).balanceOf(address(this));
    IERC20Upgradeable(t0).safeTransferFrom(msg.sender, address(this), amount0);
    IERC20Upgradeable(t1).safeTransferFrom(msg.sender, address(this), amount1);

    _setApproval(t0, pm, amount0);
    _setApproval(t1, pm, amount1);
    (uint128 _liquidity,,) = INonfungiblePositionManager(pm).increaseLiquidity(
      INonfungiblePositionManager.IncreaseLiquidityParams({
        tokenId: _posId(),
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0,
        amount1Min: 0,
        deadline: block.timestamp
      })
    );

    uint256 toMint = totalSupply() == 0
      ? uint256(_liquidity)
      : (uint256(_liquidity) * totalSupply()) / liquidityBefore;

    if (toMint == 0) revert ErrZeroShares();
    if (!(toMint >= amountOutMin)) revert ErrSlippage();

    _mint(beneficiary, toMint);
    emit Deposit(msg.sender, beneficiary, amount0, amount1, toMint);

    _transferUnusedDepositTo(beneficiary, balance0Before, balance1Before);
    _restakePosition();
    return toMint;
  }

  function _withdraw(uint256 numberOfShares, uint256 amount0OutMin, uint256 amount1OutMin) internal returns (uint256, uint256) {
    uint256 supply = totalSupply();
    if (!(supply > 0)) revert ErrTotalSupply();
    if (!(numberOfShares > 0)) revert ErrZeroShares();
    _ensurePositionInVault();
    _sweepStrategyDust();

    address t0 = _token0();
    address t1 = _token1();
    uint256 totalLiquidity = _positionLiquidity();
    WithdrawCache memory vars;
    vars.supplyBefore = supply;
    vars.idleShare0 = (IERC20Upgradeable(t0).balanceOf(address(this)) * numberOfShares) / vars.supplyBefore;
    vars.idleShare1 = (IERC20Upgradeable(t1).balanceOf(address(this)) * numberOfShares) / vars.supplyBefore;
    vars.liquidityShare = uint128((totalLiquidity * numberOfShares) / vars.supplyBefore);
    _burn(msg.sender, numberOfShares);

    (vars.received0, vars.received1) = _removeFromPosition(vars.liquidityShare, totalLiquidity, amount0OutMin, amount1OutMin);
    vars.payout0 = vars.received0 + vars.idleShare0;
    vars.payout1 = vars.received1 + vars.idleShare1;
    _safeTransferIfPositive(t0, msg.sender, vars.payout0);
    _safeTransferIfPositive(t1, msg.sender, vars.payout1);
    emit Withdraw(msg.sender, msg.sender, msg.sender, vars.payout0, vars.payout1, numberOfShares);

    _restakePosition();
    return (vars.payout0, vars.payout1);
  }

  function _removeFromPosition(uint128 liquidityAmount, uint256 totalLiquidity, uint256 amount0Min, uint256 amount1Min) internal returns (uint256, uint256) {
    address _posManager = _posManager();
    uint256 _posId = _posId();
    bool withdrawAllLiquidity = uint256(liquidityAmount) == totalLiquidity;

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

  /// @dev Transfers the vault's ENTIRE token0/token1 balance to `_to`. Equivalent to
  /// `_transferUnusedDepositTo(_to, 0, 0)` — kept as a named wrapper for call-site readability.
  function _transferLeftOverTo(address _to) internal {
    _transferUnusedDepositTo(_to, 0, 0);
  }

  /// @dev Transfers only the DELTA above the supplied baselines to `_to`. Pre-existing vault
  /// balances (the part backing NAV for existing shareholders) are mathematically untouchable
  /// through this path.
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

  /// @dev Asks the strategy to flush its token0/token1 idle into the vault. Called at the start
  /// of every user deposit and withdraw so dust accumulated by the strategy (e.g. residual from a
  /// failed compound) becomes part of the vault's idle balance — and therefore part of NAV /
  /// payout for the current interaction. View-only `underlyingBalanceWithInvestment` already
  /// counts strategy idle, so PPS stays consistent between interactions; this physical sweep
  /// makes payouts match the PPS read.
  function _sweepStrategyDust() internal {
    address currentStrategy = _strategy();
    if (currentStrategy == address(0)) return;
    IStrategy(currentStrategy).preInteract();
  }

  /// @dev Re-stake the position NFT back into the gauge at the end of a user interaction.
  /// `_ensurePositionInVault` pulls the NFT into the vault at the start of every deposit/withdraw
  /// (so `increaseLiquidity` / `decreaseLiquidity` work). Without this counterpart, the NFT
  /// would sit unstaked in the vault until the next `doHardWork`, missing gauge emissions for
  /// the entire window. We push the NFT back to the strategy and ask it to stake; the strategy
  /// silently skips if investing is paused or in withdraw-only mode.
  ///
  /// The stake call is wrapped in a try/catch so a temporarily-paused or otherwise reverting
  /// gauge cannot brick user deposits/withdraws. On failure, the NFT remains in the strategy
  /// (still in the custody chain) until the next interaction or `doHardWork` succeeds in
  /// staking it.
  function _restakePosition() internal {
    _restakePosition(false);
  }

  /// @dev `absorbIdle = true` performs a full `doHardWork` cycle on the strategy instead of
  /// just staking. Used at the end of a rebalance so any token0/token1 idle the strategy has
  /// accumulated (rebalance leftovers, prior failed compound, etc.) gets folded into the new
  /// position via `increaseLiquidity` before the NFT goes back into the gauge. User deposits
  /// and withdraws use `absorbIdle=false` to keep their gas cost low — absorb happens on the
  /// next rebalance or doHardWork.
  function _restakePosition(bool absorbIdle) internal {
    address currentStrategy = _strategy();
    if (currentStrategy == address(0)) return;
    address pm = _posManager();
    uint256 pid = _posId();
    if (INonfungiblePositionManager(pm).ownerOf(pid) == address(this)) {
      IERC721Upgradeable(pm).safeTransferFrom(address(this), currentStrategy, pid);
    }
    if (absorbIdle) {
      // doHardWork = _withdraw + _liquidateReward + _absorbIdleIntoPosition + _investAllUnderlying.
      // Falls through to stakePosition on revert (e.g. investing paused, harvest paused) so the
      // NFT still gets staked when possible even if absorb is blocked.
      try IStrategy(currentStrategy).doHardWork() {
        return;
      } catch {}
    }
    try IStrategy(currentStrategy).stakePosition() {} catch {}
  }

  /// @notice Rescue an ERC20 that isn't part of the vault's accounting (e.g. an airdrop or
  /// an accidental transfer of an unrelated token). token0 and token1 are blocked because they
  /// back PPS — vault idle of those is counted in `underlyingBalanceWithInvestment` and belongs
  /// to share holders, not governance. Use for stray tokens only.
  function sweepStrayToken(address token, address to) external onlyControllerOrGovernance {
    if (token == _token0() || token == _token1()) revert ErrProtectedToken();
    if (to == address(0)) revert ErrZeroAddress();
    uint256 bal = IERC20Upgradeable(token).balanceOf(address(this));
    if (bal > 0) IERC20Upgradeable(token).safeTransfer(to, bal);
  }

  /// @notice Current pool sqrtPriceX96. Read goes through the helper so CLVault doesn't have to
  /// import IPool just for slot0.
  function getSqrtPriceX96() public view returns (uint160) {
    return ICLRebalanceHelper(_rebalanceHelper()).spotSqrtPriceX96(_poolAddress());
  }

  /// @notice Current (amount0, amount1) the position's liquidity represents at spot price.
  /// Used by ERC4626-style wrappers to decide a single-asset zap-in split.
  function getCurrentTokenAmounts() external view returns (uint256, uint256) {
    return ICLRebalanceHelper(_rebalanceHelper()).getCurrentTokenAmounts(
      _poolAddress(), _posManager(), _posId(), _tickLower(), _tickUpper()
    );
  }

  /// @notice Per-token spot value-weights (sum == 1e18). Used by ERC4626-style wrappers.
  function getCurrentTokenWeights() external view returns (uint256, uint256) {
    return ICLRebalanceHelper(_rebalanceHelper()).getCurrentTokenWeights(
      _poolAddress(), _posManager(), _posId(), _tickLower(), _tickUpper()
    );
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

  /// @dev Anchors burn/mint mins to the TWAP price so a sandwicher who shifts spot within
  /// _maxTwapDeviationBps still can't extract more than _maxSlippageBps per side. Quoting,
  /// tick-limit math and TWAP validation are folded into helper calls so CLVault stays under
  /// the 24,576-byte deploy limit.
  function rebalanceCurrentTick(uint256 _newPosWidth) public onlyRebalanceExecutor whenRebalanceEnabled {
    if (_withdrawOnly()) revert ErrWithdrawOnly();
    if (!(block.timestamp >= _lastRebalance() + _rebalanceCooldown())) revert ErrRebalanceCooldown();
    if (!(_newPosWidth <= _posWidth())) revert ErrTargetWidth();
    _ensurePositionInVault();
    // Helper required: a zero helper makes prepareRebalance call address(0), which returns
    // empty data and reverts in the abi-decode below — louder than a custom error but saves
    // bytecode toward the 24,576-byte deploy limit.
    ICLRebalanceHelper rh = ICLRebalanceHelper(_rebalanceHelper());

    uint256 oldLiquidity = underlyingBalanceWithInvestment();
    uint256 oldPosId = _posId();
    uint128 oldLiq = uint128(_positionLiquidity());
    address pool = _poolAddress();
    uint32 window = _twapWindow();
    uint256 slip = _maxSlippageBps();

    (int24 tickLowerNew, int24 tickUpperNew, uint256 burnMin0, uint256 burnMin1) = rh.prepareRebalance(
      pool,
      window,
      _maxTwapDeviationBps(),
      slip,
      int24(int256(_newPosWidth)),
      _tickSpacing(),
      _tickLower(),
      _tickUpper(),
      oldLiq
    );
    if (tickLowerNew == _tickLower() && tickUpperNew == _tickUpper()) {
      return;
    }
    // liquidityAmount == totalLiquidity here: a rebalance always burns the whole position.
    _removeFromPosition(oldLiq, uint256(oldLiq), burnMin0, burnMin1);
    INonfungiblePositionManager(_posManager()).burn(oldPosId);
    _rebalanceIdleBalancesWithGuards(tickLowerNew, tickUpperNew);

    (uint256 mintMin0, uint256 mintMin1) = rh.quoteMintMins(
      pool,
      window,
      tickLowerNew,
      tickUpperNew,
      IERC20Upgradeable(_token0()).balanceOf(address(this)),
      IERC20Upgradeable(_token1()).balanceOf(address(this)),
      slip
    );
    uint256 tokenId = _createNewPosition(tickLowerNew, tickUpperNew, mintMin0, mintMin1, block.timestamp + 900);

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

    // Rebalance path: absorb any strategy-held idle into the new position before staking.
    // Without this, idle from prior rebalances (and the leftover ERC20s we just transferred to
    // the strategy) keeps accumulating instead of growing the active position.
    _restakePosition(true);
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


  function _poolAddress() internal view returns (address) {
    return ICLRebalanceHelper(_rebalanceHelper()).poolAddressFor(_posManager(), _token0(), _token1(), _tickSpacing());
  }

  /// @dev Range-aware idle rebalance: uses `planSwapForMint` (which knows the new tick range)
  /// instead of the legacy 50/50 `planSwap`. Mint at the new range generally needs a non-50/50
  /// (a0, a1) ratio (depending on where sqrt sits within `[sqrtLower, sqrtUpper]`); aiming for
  /// 50/50 left up to 50% of value as dust after mint. Now we aim for the exact ratio mint
  /// will consume.
  function _rebalanceIdleBalancesWithGuards(int24 newTickLower, int24 newTickUpper) internal {
    address helper = _rebalanceHelper();
    if (helper == address(0)) return;
    address t0 = _token0();
    address t1 = _token1();
    uint256 b0 = IERC20Upgradeable(t0).balanceOf(address(this));
    uint256 b1 = IERC20Upgradeable(t1).balanceOf(address(this));
    if (b0 == 0 && b1 == 0) return;
    ICLRebalanceHelper.RebalanceSwapPlan memory plan = ICLRebalanceHelper(helper).planSwapForMint(
      _poolAddress(),
      newTickLower,
      newTickUpper,
      b0,
      b1,
      _maxSwapBps(),
      _maxSlippageBps(),
      _twapWindow(),
      _maxTwapDeviationBps()
    );
    if (!plan.shouldSwap || plan.amountIn == 0 || plan.minOut == 0) return;
    (address tokenIn, address tokenOut) = plan.zeroForOne ? (t0, t1) : (t1, t0);
    address liquidator = IController(controller()).universalLiquidator();
    _setApproval(tokenIn, liquidator, plan.amountIn);
    IUniversalLiquidator(liquidator).swap(tokenIn, tokenOut, plan.amountIn, plan.minOut, address(this));
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
