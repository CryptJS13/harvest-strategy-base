// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

interface IPool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, bool);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}
