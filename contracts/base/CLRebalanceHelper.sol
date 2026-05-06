// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interface/concentrated-liquidity/IPool.sol";
import "./interface/concentrated-liquidity/TickMath.sol";

contract CLRebalanceHelper {
  using Math for uint256;

  uint256 private constant _BPS_DENOMINATOR = 10_000;
  uint256 private constant _Q96 = 2 ** 96;

  error ErrTwapUnavailable();
  error ErrTwapDeviation();

  struct RebalanceSwapPlan {
    bool shouldSwap;
    bool zeroForOne;
    uint256 amountIn;
    uint256 minOut;
  }

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
  ) external view returns (bool) {
    if (currentTimestamp < lastRebalance + cooldown) {
      return false;
    }
    if (posWidth == targetWidth) {
      return !_inRange(pool, tickLower, tickUpper);
    }

    int24 currentTick = _getCurrentTick(pool);
    int256 middleTick = (int256(tickLower) + int256(tickUpper)) / 2;
    int256 currentTickI = int256(currentTick);
    uint256 diff = middleTick > currentTickI ? uint256(middleTick - currentTickI) : uint256(currentTickI - middleTick);
    uint256 maxDiff = deviation;
    if (maxDiff == 0) {
      maxDiff = (targetWidth * uint256(uint24(tickSpacing))) / 2;
    }
    return diff > maxDiff;
  }

  function planSwap(
    address pool,
    uint256 balance0,
    uint256 balance1,
    uint256 maxSwapBps,
    uint256 maxSlippageBps,
    uint32 twapWindow,
    uint256 maxTwapDeviationBps
  ) external view returns (RebalanceSwapPlan memory plan) {
    if (balance0 == 0 || balance1 == 0) {
      return plan;
    }

    uint160 twapSqrtPriceX96 = _getTwapSqrtPriceX96(pool, twapWindow);
    uint160 spotSqrtPriceX96 = _getSpotSqrtPriceX96(pool);
    _validateSpotVsTwap(spotSqrtPriceX96, twapSqrtPriceX96, maxTwapDeviationBps);

    uint256 value0In1 = _quote0To1(balance0, twapSqrtPriceX96);
    uint256 totalIn1 = balance1 + value0In1;
    uint256 targetIn1 = totalIn1 / 2;

    if (value0In1 > targetIn1) {
      uint256 excessValueIn1 = value0In1 - targetIn1;
      uint256 amount0ToSwap = _quote1To0(excessValueIn1, twapSqrtPriceX96);
      uint256 maxSwap0 = (balance0 * maxSwapBps) / _BPS_DENOMINATOR;
      amount0ToSwap = amount0ToSwap.min(maxSwap0);
      if (amount0ToSwap == 0) {
        return plan;
      }
      uint256 expectedOut1 = _quote0To1(amount0ToSwap, twapSqrtPriceX96);
      uint256 minOut1 = _applySlippage(expectedOut1, maxSlippageBps);
      plan.shouldSwap = minOut1 > 0;
      plan.zeroForOne = true;
      plan.amountIn = amount0ToSwap;
      plan.minOut = minOut1;
      return plan;
    }

    uint256 value1Excess = targetIn1 - value0In1;
    uint256 amount1ToSwap = value1Excess;
    uint256 maxSwap1 = (balance1 * maxSwapBps) / _BPS_DENOMINATOR;
    amount1ToSwap = amount1ToSwap.min(maxSwap1);
    if (amount1ToSwap == 0) {
      return plan;
    }
    uint256 expectedOut0 = _quote1To0(amount1ToSwap, twapSqrtPriceX96);
    uint256 minOut0 = _applySlippage(expectedOut0, maxSlippageBps);
    plan.shouldSwap = minOut0 > 0;
    plan.zeroForOne = false;
    plan.amountIn = amount1ToSwap;
    plan.minOut = minOut0;
  }

  function _getSpotSqrtPriceX96(address pool) internal view returns (uint160 sqrtPriceX96) {
    (sqrtPriceX96,,,,,) = IPool(pool).slot0();
  }

  function _getCurrentTick(address pool) internal view returns (int24 currentTick) {
    (,currentTick,,,,) = IPool(pool).slot0();
  }

  function _inRange(address pool, int24 tickLower, int24 tickUpper) internal view returns (bool inRange_) {
    uint160 currentSqrtPrice = _getSpotSqrtPriceX96(pool);
    uint160 lowerSqrtPrice = TickMath.getSqrtRatioAtTick(tickLower);
    uint160 upperSqrtPrice = TickMath.getSqrtRatioAtTick(tickUpper);
    inRange_ = lowerSqrtPrice < currentSqrtPrice && currentSqrtPrice < upperSqrtPrice;
  }

  function _getTwapSqrtPriceX96(address pool, uint32 twapWindow) internal view returns (uint160 twapSqrtPriceX96) {
    if (twapWindow == 0) {
      return _getSpotSqrtPriceX96(pool);
    }
    uint32[] memory secondsAgos = new uint32[](2);
    secondsAgos[0] = twapWindow;
    secondsAgos[1] = 0;
    (int56[] memory tickCumulatives,) = IPool(pool).observe(secondsAgos);
    int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
    int24 twapTick = int24(tickDelta / int56(uint56(twapWindow)));
    if (tickDelta < 0 && (tickDelta % int56(uint56(twapWindow)) != 0)) {
      twapTick--;
    }
    twapSqrtPriceX96 = TickMath.getSqrtRatioAtTick(twapTick);
  }

  function _validateSpotVsTwap(uint160 spotSqrtPriceX96, uint160 twapSqrtPriceX96, uint256 maxDeviationBps) internal pure {
    if (maxDeviationBps == 0) {
      return;
    }
    uint256 unit = 1e18;
    uint256 spot0In1 = _quote0To1(unit, spotSqrtPriceX96);
    uint256 twap0In1 = _quote0To1(unit, twapSqrtPriceX96);
    if (twap0In1 == 0) revert ErrTwapUnavailable();
    uint256 diff = _absDiff(spot0In1, twap0In1);
    if (diff * _BPS_DENOMINATOR > twap0In1 * maxDeviationBps) revert ErrTwapDeviation();
  }

  function _quote0To1(uint256 amount0In, uint160 sqrtPriceX96) internal pure returns (uint256 amount1Out) {
    uint256 step = amount0In.mulDiv(uint256(sqrtPriceX96), _Q96);
    amount1Out = step.mulDiv(uint256(sqrtPriceX96), _Q96);
  }

  function _quote1To0(uint256 amount1In, uint160 sqrtPriceX96) internal pure returns (uint256 amount0Out) {
    uint256 step = amount1In.mulDiv(_Q96, uint256(sqrtPriceX96));
    amount0Out = step.mulDiv(_Q96, uint256(sqrtPriceX96));
  }

  function _applySlippage(uint256 amount, uint256 slippageBps) internal pure returns (uint256) {
    return (amount * (_BPS_DENOMINATOR - slippageBps)) / _BPS_DENOMINATOR;
  }

  function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
    return a > b ? a - b : b - a;
  }
}
