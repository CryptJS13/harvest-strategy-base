// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

interface IPool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, bool);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    /// @notice Pool fee in hundredths of a basis point (e.g. 100 = 0.01% = 1 bp, 3000 = 0.3% = 30 bps).
    function fee() external view returns (uint24);
    // NOTE: pool.liquidity() is intentionally NOT declared here. CLRebalanceHelper reads it via
    // a raw staticcall (see _tryReadPoolLiquidity) so pools/mocks that don't implement it degrade
    // gracefully instead of reverting the whole rebalance plan.
}
