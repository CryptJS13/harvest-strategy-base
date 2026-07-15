//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "./BaseUpgradeableStrategyCLStorage.sol";
import "../inheritance/ControllableInit.sol";
import "../interface/IController.sol";
import "../interface/IRewardForwarder.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract BaseUpgradeableStrategyCL is Initializable, ControllableInit, BaseUpgradeableStrategyCLStorage {
  using SafeERC20 for IERC20;

  event ProfitsNotCollected(bool sell, bool floor);

  modifier restricted() {
    require(msg.sender == vault() || msg.sender == controller()
      || msg.sender == governance(),
      "The sender has to be the controller, governance, or vault");
    _;
  }

  // This is only used in `investAllUnderlying()`
  // The user can still freely withdraw from the strategy
  modifier onlyNotPausedInvesting() {
    require(!pausedInvesting(), "Action blocked as the strategy is in emergency state");
    _;
  }

  constructor() BaseUpgradeableStrategyCLStorage() {
  }

  function initialize(
    address _storage,
    address _vault,
    address _rewardPool,
    address _rewardToken,
    address _strategist
  ) public initializer {
    ControllableInit.initialize(
      _storage
    );
    _setVault(_vault);
    _setRewardPool(_rewardPool);
    _setRewardToken(_rewardToken);
    _setStrategist(_strategist);
    _setSell(true);
  }

  /**
  * Schedules an upgrade for this strategy's proxy (executed by StrategyProxy.upgrade after the
  * timelock elapses).
  */
  function scheduleUpgrade(address impl) public onlyGovernance {
    _setNextImplementation(impl);
    _setNextImplementationTimestamp(block.timestamp + nextImplementationDelay());
  }

  function _finalizeUpgrade() internal {
    _setNextImplementation(address(0));
    _setNextImplementationTimestamp(0);
  }

  function shouldUpgrade() external view returns (bool, address) {
    return (
      nextImplementationTimestamp() != 0
        && block.timestamp > nextImplementationTimestamp()
        && nextImplementation() != address(0),
      nextImplementation()
    );
  }

  // ========================= Internal & Private Functions =========================

  // ==================== Functionality ====================

  /**
    * @dev Skims protocol/strategist/profit-sharing fees from `_rewardBalance` and pushes them to
    * the RewardForwarder. Balances of 10 wei or less only emit zero-fee telemetry events.
    */
  function _notifyProfitInRewardToken(
      address _rewardToken,
      uint256 _rewardBalance
  ) internal {
      if (_rewardBalance > 10) {
          uint _feeDenominator = feeDenominator();
          uint256 strategistFee = (_rewardBalance * strategistFeeNumerator()) / _feeDenominator;
          uint256 platformFee = (_rewardBalance * platformFeeNumerator()) / _feeDenominator;
          uint256 profitSharingFee = (_rewardBalance * profitSharingNumerator()) / _feeDenominator;

          address strategyFeeRecipient = strategist();
          address platformFeeRecipient = IController(controller()).governance();

          emit ProfitLogInReward(
              _rewardToken,
              _rewardBalance,
              profitSharingFee,
              block.timestamp
          );
          emit PlatformFeeLogInReward(
              platformFeeRecipient,
              _rewardToken,
              _rewardBalance,
              platformFee,
              block.timestamp
          );
          emit StrategistFeeLogInReward(
              strategyFeeRecipient,
              _rewardToken,
              _rewardBalance,
              strategistFee,
              block.timestamp
          );

          address rewardForwarder = IController(controller()).rewardForwarder();
          IERC20(_rewardToken).safeApprove(rewardForwarder, 0);
          IERC20(_rewardToken).safeApprove(rewardForwarder, _rewardBalance);

          // Distribute/send the fees
          IRewardForwarder(rewardForwarder).notifyFee(
              _rewardToken,
              profitSharingFee,
              strategistFee,
              platformFee
          );
      } else {
          emit ProfitLogInReward(_rewardToken, 0, 0, block.timestamp);
          emit PlatformFeeLogInReward(IController(controller()).governance(), _rewardToken, 0, 0, block.timestamp);
          emit StrategistFeeLogInReward(strategist(), _rewardToken, 0, 0, block.timestamp);
      }
  }

  // Reserved storage gap. Concrete strategies (e.g. AerodromeCLStrategy) declare
  // their state below this base via Solidity-managed slots; reserving space here
  // prevents future additions to this base from shifting child state on upgrade.
  uint256[50] private ______gap;
}