// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "../base/interface/aave/IPool.sol";
import "../strategies/aave/fold/AaveReserveLib.sol";

/**
 * @notice Test-only thin wrapper around AaveReserveLib that exposes both
 *         entry points with plain `address` types so the truffle JS ABI
 *         encoder accepts them. Off-chain ABI tooling cannot currently
 *         consume the `IPool` interface type the library declares.
 */
contract AaveReserveLibTester {
  function borrowFlags(address pool, address asset, address debtToken) external view returns (uint8) {
    return AaveReserveLib.borrowFlags(IPool(pool), asset, debtToken);
  }
  function supplyFlags(address pool, address asset, address aToken) external view returns (uint8) {
    return AaveReserveLib.supplyFlags(IPool(pool), asset, aToken);
  }
  function borrowCapHeadroom(address pool, address asset, address debtToken) external view returns (uint256) {
    return AaveReserveLib.borrowCapHeadroom(IPool(pool), asset, debtToken);
  }
  function supplyCapHeadroom(address pool, address asset, address aToken) external view returns (uint256) {
    return AaveReserveLib.supplyCapHeadroom(IPool(pool), asset, aToken);
  }
  function capClampedDebtIncrease(
    address pool, address borrowAsset, address debtToken, address supplyAsset, address aToken,
    uint256 desired, uint256 priceSupplyInBorrow, uint256 bufferBps
  ) external view returns (uint256) {
    return AaveReserveLib.capClampedDebtIncrease(
      IPool(pool), borrowAsset, debtToken, supplyAsset, aToken, desired, priceSupplyInBorrow, bufferBps);
  }
}
