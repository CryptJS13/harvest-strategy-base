//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./FluidLendStrategy.sol";

contract FluidLendStrategyMainnet_USDC is FluidLendStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address fToken = address(0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169);
    address weth = address(0x4200000000000000000000000000000000000006);
    FluidLendStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      fToken,
      weth
    );
  }

  function finalizeUpgrade() override external onlyGovernance {
    address fluid = address(0x61E030A56D33e8260FdD81f03B162A79Fe3449Cd);
    _setRewardToken(fluid);
    rewardTokens = [fluid];
    _finalizeUpgrade();
  }
}