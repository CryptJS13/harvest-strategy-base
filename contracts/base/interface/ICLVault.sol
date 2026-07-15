// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

/// @notice Consumer-facing surface of CLVault. Deliberately trimmed to the members that are
/// actually called through this interface (by the strategy, the wrapper, and the checkers) —
/// the vault's full external ABI is larger, but declaring unused members here only invites
/// drift between interface and implementation (a previously-declared member was never even
/// implemented, so calls through it reverted).
interface ICLVault {

    function balanceOf(address _holder) external view returns (uint256);

    function underlyingBalanceWithInvestment() external view returns (uint256);

    function underlyingUnit() external view returns (uint);

    function posId() external view returns (uint256);

    function posManager() external view returns (address);

    function token0() external view returns (address);

    function token1() external view returns (address);

    function tickSpacing() external view returns (int24);

    function tickLower() external view returns (int24);

    function tickUpper() external view returns (int24);

    function deposit(uint256 _amount0, uint256 _amount1, uint256 _amountOutMin, address _receiver) external returns(uint256);

    function withdraw(uint256 _numberOfShares, uint256 _amount0OutMin, uint256 _amount1OutMin) external returns(uint256, uint256);

    function totalSupply() external view returns (uint256);

    function rebalanceCurrentTick(uint256 _newPosWidth) external;

    function getSqrtPriceX96() external view returns (uint160);
    function getCurrentTokenAmounts() external view returns (uint256, uint256);
    function getCurrentTokenWeights() external view returns (uint256, uint256);
    function rebalanceHelper() external view returns (address);

    function checker() external view returns (bool, bytes memory);
}
