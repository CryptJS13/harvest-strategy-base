// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interface/IRewardForwarder.sol";

/**
 * @dev Test-only liquidity dex for the universal liquidator. It keeps the input, ignores the venue, and pays
 * the last path token from its own balance: `_minBuyAmount - shortBy`. With `reenterForwarder` set it first
 * calls that forwarder's notifyFee with `reentryAmount` of the output token, to probe reentrancy guards.
 */
contract MockLiquidityDex {
    uint256 public shortBy;
    address public reenterForwarder;
    uint256 public reentryAmount;

    function configure(uint256 _shortBy, address _reenterForwarder, uint256 _reentryAmount) external {
        shortBy = _shortBy;
        reenterForwarder = _reenterForwarder;
        reentryAmount = _reentryAmount;
    }

    function doSwap(uint256, uint256 _minBuyAmount, address _receiver, address[] memory _path)
        external
        returns (uint256 amount)
    {
        address buyToken = _path[_path.length - 1];
        if (reenterForwarder != address(0)) {
            IERC20(buyToken).approve(reenterForwarder, reentryAmount);
            IRewardForwarder(reenterForwarder).notifyFee(buyToken, reentryAmount, 0, 0);
        }
        amount = _minBuyAmount - shortBy;
        IERC20(buyToken).transfer(_receiver, amount);
    }
}
