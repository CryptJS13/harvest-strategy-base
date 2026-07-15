// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "../interface/concentrated-liquidity/TickMath.sol";

/// @notice Thin wrapper exposing TickMath for JS tests so they can call the SAME math the
/// production contracts use. JS Math.exp produces a slightly different sqrtRatio than Solidity
/// TickMath, which breaks edge-case rebalance simulations (twap appears out-of-range to Solidity
/// but in-range to JS). Tests should fetch sqrt values from here.
contract MockTickMath {
  function getSqrtRatioAtTick(int24 tick) external pure returns (uint160) {
    return TickMath.getSqrtRatioAtTick(tick);
  }
}
