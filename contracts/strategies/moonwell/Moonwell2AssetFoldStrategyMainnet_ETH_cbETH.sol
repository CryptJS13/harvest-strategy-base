//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./Moonwell2AssetFoldStrategy_debtDenom.sol";

contract Moonwell2AssetFoldStrategyMainnet_ETH_cbETH is Moonwell2AssetFoldStrategy_debtDenom {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address cbETH = address(0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22);
    address mToken = address(0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5);
    address weth = address(0x4200000000000000000000000000000000000006);
    address wethMToken = address(0x628ff693426583D9a7FB391E54366292F509D457);
    address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
    address well = address(0xA88594D404727625A9437C3f886C7643872296AE);
    Moonwell2AssetFoldStrategy_debtDenom.initializeBaseStrategy(
      _storage,
      weth,
      _vault,
      mToken,
      cbETH,
      wethMToken,
      comptroller,
      well,
      8000,
      8099,
      50,
      true
    );
    rewardTokens = [well];
  }
}