// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockUniversalLiquidator {
  using SafeERC20 for IERC20;

  mapping(bytes32 => uint256) internal rates;

  function setRate(address sellToken, address buyToken, uint256 rate) external {
    rates[keccak256(abi.encode(sellToken, buyToken))] = rate;
  }

  function swap(
    address sellToken,
    address buyToken,
    uint256 sellAmount,
    uint256 minBuyAmount,
    address receiver
  ) external returns (uint256 boughtAmount) {
    uint256 rate = rates[keccak256(abi.encode(sellToken, buyToken))];
    require(rate > 0, "rate");

    IERC20(sellToken).safeTransferFrom(msg.sender, address(this), sellAmount);
    boughtAmount = (sellAmount * rate) / 1e18;
    require(boughtAmount >= minBuyAmount, "minOut");
    IERC20(buyToken).safeTransfer(receiver, boughtAmount);
  }
}
