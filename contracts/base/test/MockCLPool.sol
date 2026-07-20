// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

contract MockCLPool {
  uint160 private _sqrtPriceX96;
  int24 private _tick;
  int56 private _tickCumulativePast;
  int56 private _tickCumulativeNow;

  function setSlot0(uint160 sqrtPriceX96_, int24 tick_) external {
    _sqrtPriceX96 = sqrtPriceX96_;
    _tick = tick_;
  }

  function setObserve(int56 tickCumulativePast_, int56 tickCumulativeNow_) external {
    _tickCumulativePast = tickCumulativePast_;
    _tickCumulativeNow = tickCumulativeNow_;
  }

  function slot0() external view returns (uint160, int24, uint16, uint16, uint16, bool) {
    return (_sqrtPriceX96, _tick, 0, 0, 0, true);
  }

  function observe(uint32[] calldata)
    external
    view
    returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
  {
    tickCumulatives = new int56[](2);
    tickCumulatives[0] = _tickCumulativePast;
    tickCumulatives[1] = _tickCumulativeNow;
    secondsPerLiquidityCumulativeX128s = new uint160[](2);
  }
}
