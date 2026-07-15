// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

/**
 * @notice Tiny test-only token exposing a settable totalSupply(), so a unit
 *         test can drive AaveReserveLib's cap-headroom maths (which reads
 *         aToken/variableDebtToken totalSupply) without a full ERC20 fork.
 */
contract MockToken {
  uint256 private _ts;
  function setTotalSupply(uint256 v) external { _ts = v; }
  function totalSupply() external view returns (uint256) { return _ts; }
}
