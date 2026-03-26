//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./Aave2AssetFoldStrategy_debtDenom.sol";

contract Aave2AssetFoldStrategyMainnet_ETH_cbETH is Aave2AssetFoldStrategy_debtDenom {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address cbETH = address(0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22);
    address aToken = address(0xcf3D55c10DB69f28fD1A75Bd73f3D8A2d9c595ad);
    address weth = address(0x4200000000000000000000000000000000000006);
    address wethVarDebtToken = address(0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E);
    address aavePool = address(0xA238Dd80C259a72e81d7e4664a9801593F98d1c5);
    Aave2AssetFoldStrategy_debtDenom.initializeBaseStrategy(
      _storage,
      weth,
      _vault,
      aToken,
      cbETH,
      wethVarDebtToken,
      aavePool,
      9200,
      9299,
      50,
      9,
      true
    );
  }
}