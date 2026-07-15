// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "../base/interface/aave/DataTypes.sol";

/**
 * @notice Tiny test-only stand-in for IPool that lets a unit test forge any
 *         ReserveConfigurationMap.data value for any asset. Used to exercise
 *         the bit-decoding inside AaveReserveLib in isolation, including
 *         flag combinations (frozen / paused / borrowing-disabled) that the
 *         on-chain Base PoolConfigurator is unwilling to set from a
 *         POOL_ADMIN address in the test fork.
 */
contract MockAavePool {
  mapping(address => uint256) public configs;

  function setConfig(address asset, uint256 data) external {
    configs[asset] = data;
  }

  function getConfiguration(address asset) external view returns (DataTypes.ReserveConfigurationMap memory cfg) {
    cfg.data = configs[asset];
  }
}
