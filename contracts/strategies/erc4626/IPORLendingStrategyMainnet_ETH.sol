//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./GeneralERC4626Strategy.sol";

contract IPORLendingStrategyMainnet_ETH is GeneralERC4626Strategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4200000000000000000000000000000000000006);
    address fToken = address(0x17d0f109EE895bAD0b68AA104AA72bd0b003AD8E);
    address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address farm = address(0xD08a2917653d4E460893203471f0000826fb4034);
    GeneralERC4626Strategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      fToken,
      farm
    );
    rewardTokens = [usdc];
    _setDistributionTime(usdc, 86_400); // 24 hours
  }

    function finalizeUpgrade() external override onlyGovernance {
    address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address farm = address(0xD08a2917653d4E460893203471f0000826fb4034);
    rewardTokens = [usdc];
    _setDistributionTime(usdc, 86_400); // 24 hours
    _setRewardToken(farm);
    _finalizeUpgrade();
  }
}