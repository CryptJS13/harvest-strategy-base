//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./MorphoVaultV2Strategy.sol";

contract MorphoVaultStrategyMainnet_MW_EURC_V2 is MorphoVaultV2Strategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42);
    address morphoVault = address(0x5083b1387Ec3d4Ee6467B83890D98f1AF93F7c48);
    address weth = address(0x4200000000000000000000000000000000000006);
    address well = address(0xA88594D404727625A9437C3f886C7643872296AE);
    address morpho = address(0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842);
    MorphoVaultV2Strategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      morphoVault,
      weth
    );
    rewardTokens = [morpho, well];
    _setDistributionTime(morpho, 172_800); // 48 hours
    _setDistributionTime(well, 172_800); // 48 hours
  }
}
