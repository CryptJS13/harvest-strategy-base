// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./inheritance/Governable.sol";
import "./interface/IController.sol";
import "./interface/IRewardForwarder.sol";
import "./interface/IProfitSharingReceiver.sol";
import "./interface/IStrategy.sol";
import "./interface/IUniversalLiquidator.sol";
import "./inheritance/Controllable.sol";

/**
 * @title RewardForwarder
 * @dev This contract receives rewards from strategies, handles reward liquidation, and distributes fees to specified
 * parties. It converts rewards into target tokens or profit tokens for the DAO.
 * Inherits from `Controllable` to ensure governance and controller-controlled access.
 */
contract RewardForwarder is Controllable {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    /// @notice Address of the iFARM token used for profit-sharing
    address public constant iFARM = address(0xE7798f023fC62146e8Aa1b36Da45fb70855a77Ea);
    address[] public pendingRewardTokens;
    mapping(address => uint256) private idxPlusOne;
    mapping(address => uint256) public pendingProfitShare;
    mapping(address => uint256) public pendingPlatformFee;

    modifier onlyHardWorkerOrGovernance() {
        require(
            IController(controller()).hardWorkers(msg.sender) || (msg.sender == governance()),
            "only hard worker can call this"
        );
        _;
    }

    /**
     * @notice Initializes the RewardForwarder contract.
     * @param _storage Address of the storage contract.
     */
    constructor(address _storage) Controllable(_storage) {}

    /**
     * @notice Routes fees collected from a strategy to designated recipients.
     * @param _token Address of the token being used for the fee payment.
     * @param _profitSharingFee Amount allocated for profit sharing.
     * @param _platformFee Amount allocated as the platform fee.
     */
    function notifyFee(
        address _token,
        uint256 _profitSharingFee,
        uint256,
        uint256 _platformFee
    ) external {
        _notifyFee(_token, _profitSharingFee, _platformFee);
    }

    function _notifyFee(
        address _token,
        uint256 _profitSharingFee,
        uint256 _platformFee
    ) internal {
        require(_token != address(0), "token=0");
        uint totalTransferAmount = _profitSharingFee.add(_platformFee);
        require(totalTransferAmount > 0, "totalTransferAmount should not be 0");
        IERC20(_token).safeTransferFrom(msg.sender, address(this), totalTransferAmount);

        pendingProfitShare[_token] = pendingProfitShare[_token].add(_profitSharingFee);
        pendingPlatformFee[_token] = pendingPlatformFee[_token].add(_platformFee);

        if (idxPlusOne[_token] == 0) {
            pendingRewardTokens.push(_token);
            idxPlusOne[_token] = pendingRewardTokens.length;
        }
    }

    function distributeFee(address token) external onlyHardWorkerOrGovernance {
        uint256 profitSharingFee = pendingProfitShare[token];
        uint256 platformFee = pendingPlatformFee[token];

        require(
            profitSharingFee > 0 || platformFee > 0,
            "No pending fees for this token"
        );

        // Reset pending fees before distribution to prevent re-entrancy issues
        pendingProfitShare[token] = 0;
        pendingPlatformFee[token] = 0;

        // Remove token from pendingRewardTokens array
        uint256 idx = idxPlusOne[token];
        if (idx != 0) {
            uint256 last = pendingRewardTokens.length - 1;
            uint256 i = idx - 1;
            if (i != last) {
                address moved = pendingRewardTokens[last];
                pendingRewardTokens[i] = moved;
                idxPlusOne[moved] = i + 1; // update moved index
            }
            pendingRewardTokens.pop();
            idxPlusOne[token] = 0; // clear
        }
        _distributeFee(token, profitSharingFee, platformFee);
    }

    function distributeAllFees() external onlyHardWorkerOrGovernance {
        for (uint i = 0; i < pendingRewardTokens.length; i++) {
            address token = pendingRewardTokens[i];
            uint256 profitSharingFee = pendingProfitShare[token];
            uint256 platformFee = pendingPlatformFee[token];

            if (
                profitSharingFee > 0 || platformFee > 0
            ) {
                // Reset pending fees before distribution to prevent re-entrancy issues
                pendingProfitShare[token] = 0;
                pendingPlatformFee[token] = 0;

                _distributeFee(token, profitSharingFee, platformFee);
            }
        }
        for (uint256 i = 0; i < pendingRewardTokens.length; ) {
            idxPlusOne[pendingRewardTokens[i]] = 0;
            unchecked { ++i; }
        }
        delete pendingRewardTokens;
    }

    /**
     * @dev Internal function to handle fee distribution and token conversion if necessary.
     * @param _token Address of the fee token.
     * @param _profitSharingFee Amount allocated for profit sharing.
     * @param _platformFee Amount allocated as the platform fee.
     * Transfers the specified amounts to the designated recipients, converting tokens if necessary.
     */
    function _distributeFee(
        address _token,
        uint256 _profitSharingFee,
        uint256 _platformFee
    ) internal {
        address _controller = controller();
        address liquidator = IController(_controller).universalLiquidator();
        address _targetToken = IController(_controller).targetToken();
        address _protocolFeeReceiver = IController(_controller).protocolFeeReceiver();
        address _profitSharingReceiver = IController(_controller).profitSharingReceiver();

        if (_token == _targetToken && _platformFee > 0) {
            IERC20(_targetToken).safeTransfer(_protocolFeeReceiver, _platformFee);
        }

        if (_token == iFARM && _profitSharingFee > 0) {
            IERC20(iFARM).safeTransfer(_profitSharingReceiver, _profitSharingFee);
        }

        uint256 toSwap = 0;
        if (_token != _targetToken) toSwap += _platformFee;
        if (_token != iFARM) toSwap += _profitSharingFee;

        if (toSwap > 0) {
            IERC20(_token).safeApprove(liquidator, 0);
            IERC20(_token).safeApprove(liquidator, toSwap);

            if (_platformFee > 0 && _token != _targetToken) {
                IUniversalLiquidator(liquidator).swap(_token, _targetToken, _platformFee, 1, _protocolFeeReceiver);
            }
            if (_profitSharingFee > 0 && _token != iFARM) {
                IUniversalLiquidator(liquidator).swap(_token, iFARM, _profitSharingFee, 1,  _profitSharingReceiver);
            }
        }
    }
}
