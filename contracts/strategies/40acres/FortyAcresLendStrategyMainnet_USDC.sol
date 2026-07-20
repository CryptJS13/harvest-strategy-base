//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./FortyAcresLendStrategy.sol";

contract FortyAcresLendStrategyMainnet_USDC is FortyAcresLendStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address favault = address(0xB99B6dF96d4d5448cC0a5B3e0ef7896df9507Cf5);
    address weth = address(0x4200000000000000000000000000000000000006);
    EulerLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      favault,
      weth
    );
  }
}