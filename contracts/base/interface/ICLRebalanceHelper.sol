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
