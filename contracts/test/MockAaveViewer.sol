// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

contract MockAaveViewer {
  mapping(bytes32 => uint256) internal prices;
  uint256 internal health;

  function setPrice(address base, address quote, uint256 price) external {
    prices[keccak256(abi.encode(base, quote))] = price;
  }

  function setHealth(uint256 value) external {
    health = value;
  }

  function getPrice(address base, address quote) external view returns (uint256) {
    return prices[keccak256(abi.encode(base, quote))];
  }

  function getPositionHealth() external view returns (uint256) {
    return health;
  }
}
