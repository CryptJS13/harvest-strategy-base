// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

interface ICLVault {

    function initializeVault(
        address _storage,
        uint256 _posId,
        address _posManager,
        uint256 _targetWidth
    ) external;

    function balanceOf(address _holder) external view returns (uint256);

    function underlyingBalanceWithInvestment() external view returns (uint256);

    function governance() external view returns (address);

    function controller() external view returns (address);

    function posId() external view returns (uint256);

    function posManager() external view returns (address);

    function token0() external view returns (address);

    function token1() external view returns (address);

    function tickSpacing() external view returns (int24);

    function tickLower() external view returns (int24);

    function tickUpper() external view returns (int24);

    function underlyingUnit() external view returns (uint);

    function strategy() external view returns (address);

    function setStrategy(address _strategy) external;

    function announceStrategyUpdate(address _strategy) external;

    function deposit(uint256 _amount0, uint256 _amount1, uint256 _amountOutMin, address _receiver) external returns(uint256);

    function withdrawAll(bool compound) external;

    function withdraw(uint256 _numberOfShares, uint256 _amount0OutMin, uint256 _amount1OutMin) external returns(uint256, uint256);

    function getPricePerFullShare() external view returns (uint256);

    function underlyingBalanceWithInvestmentForHolder(address _holder) view external returns (uint256);

    function totalSupply() external view returns (uint256);

    /**
     * This should be callable only by the controller (by the hard worker) or by governance
     */
    function doHardWork() external;
    function rebalanceCurrentTick(uint256 _newPosWidth) external;
    function setRebalanceSafetyConfig(uint256 _maxSwapBpsValue, uint256 _maxSlippageBpsValue, uint32 _twapWindowValue, uint256 _maxTwapDeviationBpsValue) external;
    function setRebalanceHelper(address helper) external;
    
    function getSqrtPriceX96() external view returns (uint160);
    function getCurrentTokenAmounts() external view returns (uint256, uint256);
    function getCurrentTokenWeights() external view returns (uint256, uint256);
    function targetWidth() external view returns (uint256);
    function rebalanceHelper() external view returns (address);

    function checker() external view returns (bool, bytes memory);
}
