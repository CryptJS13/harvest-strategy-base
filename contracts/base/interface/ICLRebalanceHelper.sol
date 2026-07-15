// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

interface ICLRebalanceHelper {
  struct RebalanceSwapPlan {
    bool shouldSwap;
    bool zeroForOne;
    uint256 amountIn;
    uint256 minOut;
  }

  function planSwap(
    address pool,
    uint256 balance0,
    uint256 balance1,
    uint256 maxSwapBps,
    uint256 maxSlippageBps,
    uint32 twapWindow,
    uint256 maxTwapDeviationBps
  ) external view returns (RebalanceSwapPlan memory plan);

  function planSwapForMint(
    address pool,
    int24 newTickLower,
    int24 newTickUpper,
    uint256 balance0,
    uint256 balance1,
    uint256 maxSwapBps,
    uint256 maxSlippageBps,
    uint32 twapWindow,
    uint256 maxTwapDeviationBps
  ) external view returns (RebalanceSwapPlan memory plan);

  function spotSqrtPriceX96(address pool) external view returns (uint160);

  function poolFee(address pool) external view returns (uint24);

  function quoteDepositShares(
    address pool,
    int24 tickLower,
    int24 tickUpper,
    uint256 supply,
    uint256 liquidityBefore,
    uint256 amount0,
    uint256 amount1
  ) external view returns (uint256);

  function poolAddressFor(address posManager, address token0_, address token1_, int24 tickSpacing) external view returns (address);

  function quoteUnderlyingBalanceWithInvestment(
    uint160 sqrt,
    int24 tickLower,
    int24 tickUpper,
    uint128 liquidity,
    uint256 idle0,
    uint256 idle1
  ) external pure returns (uint256);

  function prepareRebalance(
    address pool,
    uint32 twapWindow,
    uint256 maxTwapDeviationBps,
    uint256 maxSlippageBps,
    int24 posWidth,
    int24 tickSpacing,
    int24 oldTickLower,
    int24 oldTickUpper,
    uint128 oldLiquidity
  ) external view returns (
    int24 tickLowerNew,
    int24 tickUpperNew,
    uint256 burnMin0,
    uint256 burnMin1
  );

  function quoteMintMins(
    address pool,
    uint32 twapWindow,
    int24 tickLower,
    int24 tickUpper,
    uint256 amount0Desired,
    uint256 amount1Desired,
    uint256 maxSlippageBps
  ) external view returns (uint256 min0, uint256 min1);

  function getCurrentTokenAmounts(
    address pool,
    address posMgr,
    uint256 positionId,
    int24 tickLower,
    int24 tickUpper
  ) external view returns (uint256 amount0, uint256 amount1);

  function getCurrentTokenWeights(
    address pool,
    address posMgr,
    uint256 positionId,
    int24 tickLower,
    int24 tickUpper
  ) external view returns (uint256 w0, uint256 w1);

  function shouldRebalance(
    address pool,
    int24 tickLower,
    int24 tickUpper,
    int24 tickSpacing,
    uint256 posWidth,
    uint256 targetWidth,
    uint256 lastRebalance,
    uint256 cooldown,
    uint256 deviation,
    uint256 currentTimestamp
  ) external view returns (bool);
}
