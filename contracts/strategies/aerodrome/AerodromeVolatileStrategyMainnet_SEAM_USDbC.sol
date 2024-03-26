//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;

import "./AerodromeVolatileStrategy.sol";

contract AerodromeVolatileStrategyMainnet_SEAM_USDbC is AerodromeVolatileStrategy {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x42e8dC1b1891C103291Ec01D903451E729DaAACc);
    address gauge = address(0xf2669b18Eb18052A6fa7aA87294C629e3B158c1D);
    address aero = address(0x940181a94A35A4569E4529A3CDfB74e38FD98631);
    address seam = address(0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85);
    address usdbc = address(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA);
    AerodromeVolatileStrategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      usdbc
    );
    rewardTokens = [aero, seam, usdbc];
  }
}
