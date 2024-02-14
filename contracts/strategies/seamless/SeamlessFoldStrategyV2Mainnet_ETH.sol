//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./SeamlessFoldStrategyV2.sol";

contract SeamlessFoldStrategyV2Mainnet_ETH is SeamlessFoldStrategyV2 {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4200000000000000000000000000000000000006);
    address aToken = address(0x48bf8fCd44e2977c8a9A744658431A8e6C0d866c);
    address debtToken = address(0x4cebC6688faa595537444068996ad9A207A19f13);
    address seam = address(0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85);
    SeamlessFoldStrategyV2.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      aToken,
      debtToken,
      seam,
      730,
      750,
      1000,
      true
    );
    rewardTokens = [seam];
  }
}