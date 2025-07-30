//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./AerodromeCLStrategy.sol";

contract AerodromeCLStrategyMainnet_tBTC_cbBTC1 is AerodromeCLStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address gauge = address(0xB57eC27f68Bd356e300D57079B6cdbe57d50830d);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    AerodromeCLStrategy.initializeBaseStrategy(
      _storage,
      _vault,
      gauge,
      aero
    );
    rewardTokens = [aero];
  }

  function finalizeUpgrade() external override onlyGovernance {
    _finalizeUpgrade();
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    rewardTokens = [aero];
  }
}