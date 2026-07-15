//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/utils/ERC721HolderUpgradeable.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/upgradability/BaseUpgradeableStrategyCL.sol";
import "../../base/interface/aerodrome/ICLGauge.sol";
import "../../base/interface/concentrated-liquidity/INonfungiblePositionManager.sol";
import "../../base/interface/ICLRebalanceHelper.sol";

contract AerodromeCLStrategy is BaseUpgradeableStrategyCL, ERC721HolderUpgradeable {

  using SafeERC20 for IERC20;

  address public constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);

  // this would be reset on each upgrade
  address[] public rewardTokens;
  mapping(address => bool) public rewardTokenAllowed;
  bool public harvestPaused;
  bool public withdrawOnlyMode;
  // DEPRECATED: never read by any code path (reward swaps use _boundedMinOutFromIn's fixed
  // minOut). Retained solely to preserve the sequential storage layout across proxy upgrades —
  // removing it would shift minRewardToCompound and the telemetry counters below.
  uint256 public maxSlippageBps;
  mapping(address => uint256) public minRewardToCompound;

  // Telemetry for skipped reward swaps. Appended at end for upgrade safety.
  uint256 public swapSkippedCount;
  uint256 public lastSwapSkippedAt;

  enum SwapSkipReason {
    NotAllowed,
    BelowThreshold,
    CallReverted,
    ShortReturn,
    AmountOutZero,
    AmountOutBelowMin
  }

  event EmergencyStateUpdated(bool pauseInvesting, bool pauseHarvesting, bool withdrawOnly);
  event StrategySwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 minOut);
  event StrategySwapSkipped(address indexed tokenIn, address indexed tokenOut, SwapSkipReason indexed reason, uint256 amountIn, uint256 minOut);
  event MinRewardToCompoundUpdated(address indexed token, uint256 threshold);

  constructor() BaseUpgradeableStrategyCL() {
  }

  function initializeBaseStrategy(
    address _storage,
    address _vault,
    address _gauge,
    address _rewardToken
  ) public initializer {

    BaseUpgradeableStrategyCL.initialize(
      _storage,
      _vault,
      _gauge,
      _rewardToken,
      harvestMSIG
    );
    rewardTokenAllowed[_rewardToken] = true;
    // Default reward-compounding threshold: 0.01 reward token (1e16 raw assuming 18 decimals).
    // Tuned so that a single cycle of accrued rewards is meaningful enough to: (a) cover the
    // protocol fee leg, (b) survive the AERO -> token0 UL swap with reasonable routing
    // friction, and (c) leave enough principal to value-balance into token1. Below this
    // threshold the cycle is skipped pre-fees so rewards accumulate for the next claim.
    // Governance can re-tune per asset via setMinRewardToCompound.
    minRewardToCompound[_rewardToken] = 1e16;
  }

  function _nftStaked() internal view returns (bool staked) {
    staked = INonfungiblePositionManager(posManager()).ownerOf(posId()) == rewardPool();
  }

  function _nftInStrategy() internal view returns (bool inStrategy) {
    inStrategy = INonfungiblePositionManager(posManager()).ownerOf(posId()) == address(this);
  }

  function _withdraw() internal {
    if (_nftStaked()) {
      ICLGauge(rewardPool()).withdraw(posId());
    }
  }

  function _stake() internal {
    address _rewardPool = rewardPool();
    uint256 _posId = posId();
    IERC721(posManager()).approve(_rewardPool, _posId);
    ICLGauge(_rewardPool).deposit(_posId);
  }

  function _investAllUnderlying() internal onlyNotPausedInvesting {
    if(_nftInStrategy()) {
      _stake();
    }
  }

  /*
  *   In case there are some issues discovered about the pool or underlying asset
  *   Governance can exit the pool properly
  *   The function is only used for emergency to exit the pool
  */
  function emergencyExit() public onlyGovernance {
    _withdraw();
    _setPausedInvesting(true);
    harvestPaused = true;
    withdrawOnlyMode = true;
    emit EmergencyStateUpdated(true, true, true);
  }

  /*
  *   Resumes the ability to invest into the underlying reward pools
  */
  function continueInvesting() public onlyGovernance {
    _setPausedInvesting(false);
    harvestPaused = false;
    withdrawOnlyMode = false;
    emit EmergencyStateUpdated(false, false, false);
  }

  function unsalvagableTokens(address token) public view returns (bool) {
    return (token == rewardToken() || token == token0() || token == token1() || rewardTokenAllowed[token]);
  }

  function addRewardToken(address _token) public onlyGovernance {
    require(_token != address(0), "token");
    require(!rewardTokenAllowed[_token], "already allowed");
    rewardTokenAllowed[_token] = true;
    rewardTokens.push(_token);
  }

  function removeRewardToken(address _token) external onlyGovernance {
    require(_token != rewardToken(), "base reward");
    rewardTokenAllowed[_token] = false;

    // Pop from the iteration array as well so harvests stop paying gas to inspect a token
    // that's no longer compoundable. Swap-with-last + pop keeps order-irrelevant.
    uint256 length = rewardTokens.length;
    for (uint256 i = 0; i < length; i++) {
      if (rewardTokens[i] == _token) {
        if (i != length - 1) {
          rewardTokens[i] = rewardTokens[length - 1];
        }
        rewardTokens.pop();
        break;
      }
    }
  }

  function setEmergencyState(bool _pauseInvesting, bool _pauseHarvesting, bool _withdrawOnly) external onlyGovernance {
    _setPausedInvesting(_pauseInvesting);
    harvestPaused = _pauseHarvesting;
    withdrawOnlyMode = _withdrawOnly;
    emit EmergencyStateUpdated(_pauseInvesting, _pauseHarvesting, _withdrawOnly);
  }

  function setMinRewardToCompound(address _token, uint256 _threshold) external onlyGovernance {
    require(_token != address(0), "token");
    minRewardToCompound[_token] = _threshold;
    emit MinRewardToCompoundUpdated(_token, _threshold);
  }

  function _liquidateReward() internal {
    require(!withdrawOnlyMode, "Withdraw only");
    if (!sell()) {
      // Profits can be disabled for possible simplified and rapid exit
      emit ProfitsNotCollected(sell(), false);
      return;
    }

    address _rewardToken = rewardToken();

    // First pass: convert any non-reward-token rewards into the reward token. The reward token
    // itself is handled below — including its threshold gate — so it's skipped here to avoid
    // a redundant iteration and a misleading "BelowThreshold" skip event for a token that was
    // never going to be swapped anyway.
    uint256 rewardTokensLength = rewardTokens.length;
    for (uint256 i = 0; i < rewardTokensLength; i++) {
      address token = rewardTokens[i];
      if (token == _rewardToken) {
        continue;
      }
      uint256 balance = IERC20(token).balanceOf(address(this));
      if (!rewardTokenAllowed[token]) {
        _recordSkip(token, _rewardToken, balance, 0, SwapSkipReason.NotAllowed);
        continue;
      }
      if (balance < minRewardToCompound[token]) {
        _recordSkip(token, _rewardToken, balance, _boundedMinOutFromIn(balance), SwapSkipReason.BelowThreshold);
        continue;
      }
      _swapWithBound(token, _rewardToken, balance, _boundedMinOutFromIn(balance));
    }

    // Single threshold gate, BEFORE fees. If accrued reward token is below the threshold we
    // bail out without skimming fees, so the next cycle isn't double-charged on a residual
    // that was already taxed on this one. Above threshold, fees come out and the remainder is
    // swapped to token0 — leaving the actual idle-absorption step to `_absorbIdleIntoPosition`
    // called by doHardWork after this. Critically, this function NO LONGER short-circuits the
    // increaseLiquidity path: any residual token0/token1 dust (from a prior failed compound, a
    // capped rebalance leftover, or just non-AERO income) gets picked up by the absorber even
    // when the reward token is below threshold.
    uint256 rewardBalance = IERC20(_rewardToken).balanceOf(address(this));
    if (rewardBalance < minRewardToCompound[_rewardToken]) {
      _recordSkip(_rewardToken, _rewardToken, rewardBalance, _boundedMinOutFromIn(rewardBalance), SwapSkipReason.BelowThreshold);
      return;
    }
    _notifyProfitInRewardToken(_rewardToken, rewardBalance);
    uint256 remainingRewardBalance = IERC20(_rewardToken).balanceOf(address(this));

    address _token0 = token0();
    if (_token0 != _rewardToken) {
      // best-effort: if reward swap fails, leftover stays as reward token; the absorber below
      // will still process any t0/t1 idle the strategy already holds.
      _swapWithBound(_rewardToken, _token0, remainingRewardBalance, _boundedMinOutFromIn(remainingRewardBalance));
    }
  }

  /// @notice Take any token0/token1 dust currently sitting in this strategy and deposit it into
  /// the vault's existing position. Uses the same range-aware planner the rebalance uses to size
  /// the swap so the resulting (a0, a1) ratio matches what `pool.mint` will consume at the
  /// current spot — minimising leftover dust. Called from `doHardWork` (after `_liquidateReward`)
  /// AND would be called from a paused-reward state, so the orphaned-dust case the user hit (a
  /// rebalance leaves a one-sided residual + no AERO above threshold) gets cleaned up on the
  /// next doHardWork instead of waiting for the next rebalance.
  ///
  /// Silent skip pattern: when the helper plan errors (e.g. pool out of TWAP cardinality), the
  /// swap is skipped and we attempt increaseLiquidity with whatever we already have. When the
  /// V3 NPM `increaseLiquidity` would mint 0 liquidity (one-sided idle into an in-range
  /// position), we skip the call entirely rather than reverting doHardWork.
  function _absorbIdleIntoPosition() internal {
    address _token0 = token0();
    address _token1 = token1();
    uint256 b0 = IERC20(_token0).balanceOf(address(this));
    uint256 b1 = IERC20(_token1).balanceOf(address(this));
    if (b0 == 0 && b1 == 0) return;

    address _vault = vault();
    address helper = ICLVault(_vault).rebalanceHelper();
    if (helper != address(0)) {
      int24 tickLower_ = ICLVault(_vault).tickLower();
      int24 tickUpper_ = ICLVault(_vault).tickUpper();
      int24 tickSpacing_ = ICLVault(_vault).tickSpacing();
      address pool = ICLRebalanceHelper(helper).poolAddressFor(posManager(), _token0, _token1, tickSpacing_);
      try ICLRebalanceHelper(helper).planSwapForMint(
        pool, tickLower_, tickUpper_, b0, b1, 10000, 100, 0, 0
      ) returns (ICLRebalanceHelper.RebalanceSwapPlan memory plan) {
        if (plan.shouldSwap && plan.amountIn > 0) {
          if (plan.zeroForOne) {
            _swapWithBound(_token0, _token1, plan.amountIn, plan.minOut);
          } else {
            _swapWithBound(_token1, _token0, plan.amountIn, plan.minOut);
          }
        }
      } catch {}
    }

    b0 = IERC20(_token0).balanceOf(address(this));
    b1 = IERC20(_token1).balanceOf(address(this));
    if (b0 == 0 && b1 == 0) return;

    address _posManager = posManager();
    IERC20(_token0).safeApprove(_posManager, 0);
    IERC20(_token0).safeApprove(_posManager, b0);
    IERC20(_token1).safeApprove(_posManager, 0);
    IERC20(_token1).safeApprove(_posManager, b1);

    // try/catch — if increaseLiquidity would mint zero L (one-sided idle into an in-range
    // position, or any unforeseen NPM revert), skip rather than abort the whole doHardWork.
    // Idle stays in the strategy and gets another chance next cycle.
    try INonfungiblePositionManager(_posManager).increaseLiquidity(
      INonfungiblePositionManager.IncreaseLiquidityParams({
        tokenId: posId(),
        amount0Desired: b0,
        amount1Desired: b1,
        amount0Min: 0,
        amount1Min: 0,
        deadline: block.timestamp
      })
    ) returns (uint128, uint256, uint256) {} catch {}
  }

  /// @notice Vault calls this before each user deposit/withdraw to flush any token0/token1 dust
  /// the strategy may have accumulated (e.g. residual leftovers from a previous compound cycle
  /// that didn't fully balance into the position). Without this, that dust would be invisible to
  /// `underlyingBalanceWithInvestment` from the vault's local read AND would never be claimable
  /// by withdrawers — it would only enter the position on the next successful compound, at which
  /// point its value would silently accrue to whoever happens to be a shareholder at that moment.
  /// Sweeping pre-interaction makes the dust part of the vault's idle balance and therefore part
  /// of NAV / per-share value for the current interaction.
  function preInteract() external restricted {
    address _vault = vault();
    address t0 = ICLVault(_vault).token0();
    address t1 = ICLVault(_vault).token1();
    uint256 b0 = IERC20(t0).balanceOf(address(this));
    if (b0 > 0) IERC20(t0).safeTransfer(_vault, b0);
    uint256 b1 = IERC20(t1).balanceOf(address(this));
    if (b1 > 0) IERC20(t1).safeTransfer(_vault, b1);
  }

  /// @notice Re-stakes the position NFT into the gauge after a user interaction. The vault
  /// pushes the NFT to this strategy (transferFrom vault → strategy) and then calls this; we
  /// just stake it. Skips silently if investing is paused or the strategy is in withdraw-only
  /// mode — in those cases the NFT remains in the strategy (still in custody, just not earning
  /// gauge rewards) until governance unpauses or the next doHardWork.
  ///
  /// Without this, the NFT pulled into the vault by `_ensurePositionInVault` at the start of
  /// every deposit/withdraw would sit unstaked in the vault until the next `doHardWork`,
  /// missing the gauge emissions during that window.
  function stakePosition() external restricted {
    if (pausedInvesting() || withdrawOnlyMode) return;
    if (_nftInStrategy()) _stake();
  }

  /*
  *   Withdraws all the asset to the vault
  */
  function withdrawAllToVault(bool compound) public restricted {
    _withdraw();
    if (compound) {
      _liquidateReward();
    }
    if (_nftInStrategy()) {
      IERC721(posManager()).transferFrom(address(this), vault(), posId());
    }
  }

  /*
  *   Governance or Controller can claim coins that are somehow transferred into the contract
  *   Note that they cannot come in take away coins that are used and defined in the strategy itself
  */
  function salvage(address recipient, address token, uint256 amount) external onlyControllerOrGovernance {
     // To make sure that governance cannot come in and take away the coins
    require(!unsalvagableTokens(token), "token is defined as not salvagable");
    IERC20(token).safeTransfer(recipient, amount);
  }

  /*
  *   Get the reward, sell it in exchange for underlying, invest what you got.
  *   It's not much, but it's honest work.
  *
  *   Note that although `onlyNotPausedInvesting` is not added here,
  *   calling `investAllUnderlying()` affectively blocks the usage of `doHardWork`
  *   when the investing is being paused by governance.
  */
  function doHardWork() external onlyNotPausedInvesting restricted {
    require(!harvestPaused, "Harvest paused");
    require(!withdrawOnlyMode, "Withdraw only");
    _withdraw();
    _liquidateReward();          // claim + fee + reward→token0; may early-return if AERO below threshold
    _absorbIdleIntoPosition();    // always: take whatever t0/t1 idle is here and grow the position
    _investAllUnderlying();
  }

  function setGauge(address _newGauge) external onlyGovernance {
    _withdraw();
    _liquidateReward();

    _setRewardPool(_newGauge);
    _investAllUnderlying();
  }

  /**
  * Disables/enables the reward-compounding path (`_liquidateReward` early-returns when sell is
  * off). Useful for the simplest possible emergency exit: rewards stay claimable in-place.
  */
  function setSell(bool s) public onlyGovernance {
    _setSell(s);
  }

  function finalizeUpgrade() external virtual onlyGovernance {
    _finalizeUpgrade();
  }

  /// @dev Shared post-upgrade reward-token reseed used by the mainnet variants' finalizeUpgrade.
  /// Clears stale allowlist entries for any reward tokens being dropped from the iteration
  /// array, then reseeds so the mapping and array stay in sync. Without this, a previously-added
  /// reward token would remain salvage-blocked and treated as "allowed" by future codepaths even
  /// after it disappears from rewardTokens.
  function _reseedRewardTokens(address _base) internal {
    uint256 length = rewardTokens.length;
    for (uint256 i = 0; i < length; i++) {
      address stale = rewardTokens[i];
      if (stale != _base) {
        rewardTokenAllowed[stale] = false;
      }
    }
    rewardTokens = [_base];
    rewardTokenAllowed[_base] = true;
  }

  function _boundedMinOutFromIn(uint256 amountIn) internal pure returns (uint256) {
    amountIn;
    return 1;
  }

  function _swapWithBound(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut) internal returns (bool) {
    address _universalLiquidator = universalLiquidator();
    IERC20(tokenIn).safeApprove(_universalLiquidator, 0);
    IERC20(tokenIn).safeApprove(_universalLiquidator, amountIn);
    (bool success, bytes memory returnData) = _universalLiquidator.call(
      abi.encodeWithSelector(
        IUniversalLiquidator.swap.selector,
        tokenIn,
        tokenOut,
        amountIn,
        minOut,
        address(this)
      )
    );
    if (!success) {
      _recordSkip(tokenIn, tokenOut, amountIn, minOut, SwapSkipReason.CallReverted);
      return false;
    }
    if (returnData.length < 32) {
      _recordSkip(tokenIn, tokenOut, amountIn, minOut, SwapSkipReason.ShortReturn);
      return false;
    }
    uint256 amountOut = abi.decode(returnData, (uint256));
    if (amountOut == 0) {
      _recordSkip(tokenIn, tokenOut, amountIn, minOut, SwapSkipReason.AmountOutZero);
      return false;
    }
    if (amountOut < minOut) {
      _recordSkip(tokenIn, tokenOut, amountIn, minOut, SwapSkipReason.AmountOutBelowMin);
      return false;
    }
    emit StrategySwapExecuted(tokenIn, tokenOut, amountIn, amountOut, minOut);
    return true;
  }

  /// @dev Bumps skip counter, stamps timestamp, and emits the diagnostic event so governance can
  /// monitor failed/skipped reward swaps off-chain.
  function _recordSkip(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    uint256 minOut,
    SwapSkipReason reason
  ) internal {
    swapSkippedCount += 1;
    lastSwapSkippedAt = block.timestamp;
    emit StrategySwapSkipped(tokenIn, tokenOut, reason, amountIn, minOut);
  }
}
