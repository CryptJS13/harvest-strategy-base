//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/utils/ERC721HolderUpgradeable.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/upgradability/BaseUpgradeableStrategyCL.sol";
import "../../base/interface/aerodrome/ICLGauge.sol";
import "../../base/interface/concentrated-liquidity/INonfungiblePositionManager.sol";

contract AerodromeCLStrategy is BaseUpgradeableStrategyCL, ERC721HolderUpgradeable {

  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  address public constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);

  // this would be reset on each upgrade
  address[] public rewardTokens;
  mapping(address => bool) public rewardTokenAllowed;
  bool public harvestPaused;
  bool public withdrawOnlyMode;
  uint256 public maxSlippageBps;
  mapping(address => uint256) public minRewardToCompound;
  uint256 private constant _BPS_DENOMINATOR = 10_000;
  event EmergencyStateUpdated(bool pauseInvesting, bool pauseHarvesting, bool withdrawOnly);
  event StrategySwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 minOut);
  event StrategySwapSkipped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 minOut);
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
    maxSlippageBps = 100;
    rewardTokenAllowed[_rewardToken] = true;
    minRewardToCompound[_rewardToken] = 1;
  }

  function _nftStaked() internal view returns (bool staked) {
    staked = INonfungiblePositionManager(posManager()).ownerOf(posId()) == rewardPool();
  }

  function _nftInStrategy() internal view returns (bool inStrategy) {
    inStrategy = INonfungiblePositionManager(posManager()).ownerOf(posId()) == address(this);
  }

  function _emergencyExitRewardPool() internal {
    _withdraw();
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
    _emergencyExitRewardPool();
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
  }

  function setMaxSlippageBps(uint256 _maxSlippageBps) external onlyGovernance {
    require(_maxSlippageBps <= _BPS_DENOMINATOR, "slippage");
    maxSlippageBps = _maxSlippageBps;
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
    for(uint256 i = 0; i < rewardTokens.length; i++){
      address token = rewardTokens[i];
      uint256 balance = IERC20(token).balanceOf(address(this));
      if (balance == 0) {
        continue;
      }
      if (!rewardTokenAllowed[token]) {
        emit StrategySwapSkipped(token, _rewardToken, balance, 0);
        continue;
      }
      if (balance < minRewardToCompound[token]) {
        emit StrategySwapSkipped(token, _rewardToken, balance, _boundedMinOutFromIn(balance));
        continue;
      }
      if (token != _rewardToken){
        _swapWithBound(token, _rewardToken, balance, _boundedMinOutFromIn(balance));
      }
    }

    uint256 rewardBalance = IERC20(_rewardToken).balanceOf(address(this));
    _notifyProfitInRewardToken(_rewardToken, rewardBalance);
    uint256 remainingRewardBalance = IERC20(_rewardToken).balanceOf(address(this));

    if (remainingRewardBalance < 1e12) {
      return;
    }
    if (remainingRewardBalance < minRewardToCompound[_rewardToken]) {
      return;
    }

    address _token0 = token0();
    address _token1 = token1();

    if (_token0 != _rewardToken) {
      bool rewardSwapOk = _swapWithBound(_rewardToken, _token0, remainingRewardBalance, _boundedMinOutFromIn(remainingRewardBalance));
      if (!rewardSwapOk) {
        // Keep rewards in strategy and retry compounding once enough value accrues.
        return;
      }
    }

    uint256 token0Balance = IERC20(token0()).balanceOf(address(this));
    uint256 token1Balance = IERC20(token1()).balanceOf(address(this));
    if (token0Balance > token1Balance) {
      uint256 toToken1 = token0Balance.sub(token1Balance).div(2);
      if (toToken1 > 0) {
        if (toToken1 < minRewardToCompound[_token0]) {
          return;
        }
        bool rebalanceOk = _swapWithBound(_token0, _token1, toToken1, _boundedMinOutFromIn(toToken1));
        if (!rebalanceOk) {
          return;
        }
      }
    } else if (token1Balance > token0Balance) {
      uint256 toToken0 = token1Balance.sub(token0Balance).div(2);
      if (toToken0 > 0) {
        if (toToken0 < minRewardToCompound[_token1]) {
          return;
        }
        bool rebalanceOk = _swapWithBound(_token1, _token0, toToken0, _boundedMinOutFromIn(toToken0));
        if (!rebalanceOk) {
          return;
        }
      }
    }

    token0Balance = IERC20(_token0).balanceOf(address(this));
    token1Balance = IERC20(_token1).balanceOf(address(this));
    
    address _posManager = posManager();
    // provide token1 and token2 to BaseSwap
    IERC20(_token0).safeApprove(_posManager, 0);
    IERC20(_token0).safeApprove(_posManager, token0Balance);

    IERC20(_token1).safeApprove(_posManager, 0);
    IERC20(_token1).safeApprove(_posManager, token1Balance);

    INonfungiblePositionManager(_posManager).increaseLiquidity(
      INonfungiblePositionManager.IncreaseLiquidityParams({
        tokenId: posId(),
        amount0Desired: token0Balance,
        amount1Desired: token1Balance,
        amount0Min: 0,
        amount1Min: 0,
        deadline: block.timestamp
      })
    );
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
    _liquidateReward();
    _investAllUnderlying();
  }

  function setGauge(address _newGauge) external onlyGovernance {
    _withdraw();
    _liquidateReward();

    _setRewardPool(_newGauge);
    _investAllUnderlying();
  }

  /**
  * Can completely disable claiming UNI rewards and selling. Good for emergency withdraw in the
  * simplest possible way.
  */
  function setSell(bool s) public onlyGovernance {
    _setSell(s);
  }

  function finalizeUpgrade() external virtual onlyGovernance {
    _finalizeUpgrade();
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
    if (!success || returnData.length < 32) {
      emit StrategySwapSkipped(tokenIn, tokenOut, amountIn, minOut);
      return false;
    }
    uint256 amountOut = abi.decode(returnData, (uint256));
    if (amountOut == 0 || amountOut < minOut) {
      emit StrategySwapSkipped(tokenIn, tokenOut, amountIn, minOut);
      return false;
    }
    emit StrategySwapExecuted(tokenIn, tokenOut, amountIn, amountOut, minOut);
    return true;
  }
}
