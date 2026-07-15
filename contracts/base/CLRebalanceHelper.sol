// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interface/concentrated-liquidity/IPool.sol";
import "./interface/concentrated-liquidity/IFactory.sol";
import "./interface/concentrated-liquidity/INonfungiblePositionManager.sol";
import "./interface/concentrated-liquidity/TickMath.sol";
import "./interface/concentrated-liquidity/LiquidityAmounts.sol";

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


  /// @notice One-shot pre-burn rebalance prep: validates spot vs TWAP, computes the new tick
  /// range, and TWAP-anchors burn mins. Combined into a single helper call so CLVault stays
  /// under the 24,576-byte deploy limit. Inputs are positional to keep the calldata encoder
  /// small on the caller side.
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
  ) {
    uint160 twapSqrt = _getTwapSqrtPriceX96(pool, twapWindow);
    // Single slot0 read serves both the spot sqrt and the current tick below.
    (uint160 spotSqrt, int24 currentTick,,,,) = IPool(pool).slot0();
    if (maxTwapDeviationBps > 0) {
      _validateSpotVsTwap(spotSqrt, twapSqrt, maxTwapDeviationBps);
    }

    {
      int24 middleTickTrunc;
      uint160 tickSqrtPrice = TickMath.getSqrtRatioAtTick(currentTick / tickSpacing * tickSpacing);
      if (spotSqrt > tickSqrtPrice) {
        middleTickTrunc = currentTick / tickSpacing;
      } else {
        middleTickTrunc = currentTick / tickSpacing - 1;
      }
      int24 tickLowerNewTrunc = posWidth == 1 ? middleTickTrunc : middleTickTrunc - posWidth / 2;
      int24 tickUpperNewTrunc = tickLowerNewTrunc + posWidth;
      tickLowerNew = tickLowerNewTrunc * tickSpacing;
      tickUpperNew = tickUpperNewTrunc * tickSpacing;
    }

    if (maxSlippageBps == 0 || maxSlippageBps > _BPS_DENOMINATOR) {
      return (tickLowerNew, tickUpperNew, 0, 0);
    }
    uint160 sqrtL = TickMath.getSqrtRatioAtTick(oldTickLower);
    uint160 sqrtU = TickMath.getSqrtRatioAtTick(oldTickUpper);
    // `decreaseLiquidity` returns amounts based on POOL SPOT, not TWAP. If the position is
    // out of range, the actual amounts are one-sided (0 on the out-of-range side) while a
    // TWAP-anchored expectation (TWAP still in range) would demand both sides > 0 — the NPM
    // then reverts with "PSC". Take the per-side MIN of (TWAP-based, spot-based) so the mins
    // accommodate both states; sandwich protection still comes from `_validateSpotVsTwap`.
    (uint256 e0t, uint256 e1t) = LiquidityAmounts.getAmountsForLiquidity(twapSqrt, sqrtL, sqrtU, oldLiquidity);
    (uint256 e0s, uint256 e1s) = LiquidityAmounts.getAmountsForLiquidity(spotSqrt, sqrtL, sqrtU, oldLiquidity);
    uint256 e0 = e0t < e0s ? e0t : e0s;
    uint256 e1 = e1t < e1s ? e1t : e1s;
    uint256 keep = _BPS_DENOMINATOR - maxSlippageBps;
    burnMin0 = (e0 * keep) / _BPS_DENOMINATOR;
    burnMin1 = (e1 * keep) / _BPS_DENOMINATOR;
  }

  function quoteMintMins(
    address pool,
    uint32 twapWindow,
    int24 tickLower,
    int24 tickUpper,
    uint256 amount0Desired,
    uint256 amount1Desired,
    uint256 maxSlippageBps
  ) external view returns (uint256 min0, uint256 min1) {
    if (maxSlippageBps == 0 || maxSlippageBps > _BPS_DENOMINATOR) {
      return (0, 0);
    }
    uint160 twapSqrt = _getTwapSqrtPriceX96(pool, twapWindow);
    uint160 spotSqrt = _getSpotSqrtPriceX96(pool);
    uint160 sqrtLower = TickMath.getSqrtRatioAtTick(tickLower);
    uint160 sqrtUpper = TickMath.getSqrtRatioAtTick(tickUpper);
    // The actual `mint` call consumes amounts based on POOL SPOT. If the new range is out of
    // range relative to spot, mint will be one-sided; a TWAP-anchored min on the other side
    // would fail with NPM's "PSC". Take per-side MIN of (TWAP-based, spot-based) — sandwich
    // protection upstream is via `_validateSpotVsTwap` in `prepareRebalance`.
    uint128 liqT = LiquidityAmounts.getLiquidityForAmounts(twapSqrt, sqrtLower, sqrtUpper, amount0Desired, amount1Desired);
    uint128 liqS = LiquidityAmounts.getLiquidityForAmounts(spotSqrt, sqrtLower, sqrtUpper, amount0Desired, amount1Desired);
    if (liqT == 0 && liqS == 0) {
      return (0, 0);
    }
    (uint256 m0t, uint256 m1t) = LiquidityAmounts.getAmountsForLiquidity(twapSqrt, sqrtLower, sqrtUpper, liqT);
    (uint256 m0s, uint256 m1s) = LiquidityAmounts.getAmountsForLiquidity(spotSqrt, sqrtLower, sqrtUpper, liqS);
    uint256 m0 = m0t < m0s ? m0t : m0s;
    uint256 m1 = m1t < m1s ? m1t : m1s;
    uint256 keep = _BPS_DENOMINATOR - maxSlippageBps;
    min0 = (m0 * keep) / _BPS_DENOMINATOR;
    min1 = (m1 * keep) / _BPS_DENOMINATOR;
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

  /// @notice Range-aware swap plan: given idle (balance0, balance1) and a target tick range,
  /// return the swap that brings the (a0, a1) ratio in line with what `LiquidityAmounts.
  /// getLiquidityForAmounts(sqrtCurrent, sqrtLower, sqrtUpper, ...)` will actually consume.
  /// Replaces the legacy `planSwap` 50/50 target which was correct only when spot sat at the
  /// exact midpoint of the new range — every off-center scenario left up to 50% of value as
  /// dust after mint.
  ///
  /// Math sketch (in-range case):
  ///   V        = b0 * sqrt² / Q192 + b1                 // total value in token1 units
  ///   α        = sqrt * (sqrtU - sqrt) / Q96            // proportional to a0_target's t1-value
  ///   β        = sqrtU * (sqrt - sqrtL) / Q96           // proportional to a1_target
  ///   a1_tgt   = V * β / (α + β)
  ///   swap     = b1 - a1_tgt   (positive ⇒ t1→t0; negative ⇒ t0→t1 in t0 units)
  ///
  /// Out-of-range cases collapse to a one-sided swap (all into the needed token).
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
  ) external view returns (RebalanceSwapPlan memory plan) {
    if (balance0 == 0 && balance1 == 0) return plan;
    uint160 twapSqrt = _getTwapSqrtPriceX96(pool, twapWindow);
    uint160 spotSqrt = _getSpotSqrtPriceX96(pool);
    if (maxTwapDeviationBps > 0) {
      _validateSpotVsTwap(spotSqrt, twapSqrt, maxTwapDeviationBps);
    }
    uint160 sqrtL = TickMath.getSqrtRatioAtTick(newTickLower);
    uint160 sqrtU = TickMath.getSqrtRatioAtTick(newTickUpper);

    // CRITICAL: use SPOT for the in-range/out-of-range decision and the swap-size math. The
    // swap executes at spot and the mint reads spot, so anchoring the plan to TWAP creates a
    // mismatch whenever they disagree — exactly the case where a rebalance is most likely to be
    // triggered (spot just crossed an old tick boundary, TWAP is still lagging).
    //
    // The minOut for the actual swap is still TWAP-anchored below (so a sandwicher can't drag
    // spot down to push minOut to zero); upstream `_validateSpotVsTwap` bounds how far spot can
    // deviate from TWAP in the first place.
    if (spotSqrt <= sqrtL) {
      // Range fully above current price → all-token0 mint. Swap any t1 to t0.
      if (balance1 == 0) return plan;
      return _buildOneSidedPlan(balance1, false, twapSqrt, maxSwapBps, maxSlippageBps);
    }
    if (spotSqrt >= sqrtU) {
      if (balance0 == 0) return plan;
      return _buildOneSidedPlan(balance0, true, twapSqrt, maxSwapBps, maxSlippageBps);
    }

    // In-range: compute optimal a1_target via the closed-form derivation. SPOT is used for
    // ratio math because the actual mint will consume at spot.
    //
    // One-step price-impact correction: the swap moves pool spot. If we compute a1Target at
    // the PRE-swap sqrt and follow it, the post-swap sqrt differs and the mint consumes a
    // different ratio than we set up — leaving dust. Instead, predict the post-swap sqrt via
    // V3 swap math (sqrt_post = sqrt_pre ± Δ*Q96/L_pool) and target the optimal at that sqrt.
    // V is preserved by the swap (modulo fees, ignored here), so we can iterate the target
    // once and the swap amount converges to near-optimal for any deposit size that fits inside
    // the active tick range.
    uint256 V = _toToken1ValueRaw(balance0, balance1, spotSqrt);
    if (V == 0) return plan;
    uint256 sqrt_ = uint256(spotSqrt);
    uint256 a1Target;
    {
      uint256 alpha = Math.mulDiv(sqrt_, uint256(sqrtU) - sqrt_, _Q96);
      uint256 beta = Math.mulDiv(uint256(sqrtU), sqrt_ - uint256(sqrtL), _Q96);
      uint256 totalDenom = alpha + beta;
      if (totalDenom == 0) return plan;
      uint256 a1Pre = Math.mulDiv(V, beta, totalDenom);

      // Predict post-swap sqrt. We attempt to read pool's active liquidity to model the swap's
      // price impact. If the pool doesn't expose `liquidity()` (e.g. MockCLPool in unit tests),
      // OR the predicted shift would push spot more than half the range (unreliable: swap would
      // cross the active tick), we silently fall back to the pre-swap a1Target. That fallback
      // preserves the legacy behaviour for extreme cases; the correction only kicks in for the
      // common case of a rebalance amount that's small relative to the pool's tick liquidity —
      // exactly where the under-targeting bug bites in production.
      uint256 sqrtPost = sqrt_;
      uint128 lPool = _tryReadPoolLiquidity(pool);
      if (lPool > 0) {
        uint256 maxShift = (uint256(sqrtU) - uint256(sqrtL)) / 2;
        if (balance1 > a1Pre) {
          // swap dy of t1 → t0 (zeroForOne=false). sqrt INCREASES by dy*Q96/L.
          uint256 dSqrt = Math.mulDiv(balance1 - a1Pre, _Q96, uint256(lPool));
          if (dSqrt > 0 && dSqrt <= maxShift && sqrt_ + dSqrt < uint256(sqrtU)) {
            sqrtPost = sqrt_ + dSqrt;
          }
        } else if (balance1 < a1Pre) {
          // swap dx of t0 → t1 (zeroForOne=true). sqrt DECREASES.
          // V3 exact: sqrt_post = L*Q96*sqrt_pre / (L*Q96 + dx*sqrt_pre).
          uint256 dx = _quote1To0(a1Pre - balance1, uint160(sqrt_));
          uint256 lQ96 = uint256(lPool) * _Q96;                          // ≤ 2^224
          uint256 dxs  = dx * sqrt_;                                     // may overflow on extreme inputs
          // Solidity 0.8 reverts on overflow; use unchecked + careful check.
          unchecked {
            uint256 sum = lQ96 + dxs;
            if (sum >= lQ96 && sum > 0) {
              uint256 cand = Math.mulDiv(lQ96, sqrt_, sum);
              if (cand > uint256(sqrtL) && cand < sqrt_ && (sqrt_ - cand) <= maxShift) {
                sqrtPost = cand;
              }
            }
          }
        }
      }

      // Recompute a1Target at post-swap sqrt. If the prediction didn't apply, sqrtPost ==
      // sqrt_ and this just reproduces a1Pre.
      uint256 alphaPost = Math.mulDiv(sqrtPost, uint256(sqrtU) - sqrtPost, _Q96);
      uint256 betaPost = Math.mulDiv(uint256(sqrtU), sqrtPost - uint256(sqrtL), _Q96);
      uint256 denomPost = alphaPost + betaPost;
      a1Target = denomPost == 0 ? a1Pre : Math.mulDiv(V, betaPost, denomPost);
    }
    // Precision edge: when sqrt sits 1-2 wei above sqrtL, the closed-form math rounds a1Target
    // down to 0. Draining b1 entirely would make the subsequent in-range mint produce L=0 and
    // revert. We pin a1Target up to 1 wei so the mint has a non-zero a1 to anchor L1; the
    // leftover effect is negligible (1 wei of token1 max).
    if (a1Target == 0) a1Target = 1;
    // The symmetric precision edge at the upper end (sqrt 1-2 wei below sqrtU → a1Target ≈ V,
    // swap wants to drain b0 entirely) is handled inside the swap-from-b0 branch below via the
    // `amountIn = balance0 - 1` clamp, which leaves 1 wei of t0 to anchor the in-range mint.

    if (balance1 > a1Target) {
      // Excess t1. Swap (b1 - a1Target) of t1 → t0.
      uint256 amountIn = balance1 - a1Target;
      uint256 maxSwap = (balance1 * maxSwapBps) / _BPS_DENOMINATOR;
      if (amountIn > maxSwap) amountIn = maxSwap;
      if (amountIn == 0) return plan;
      uint256 expectedOut = _quote1To0(amountIn, twapSqrt);
      uint256 minOut = _applySlippage(expectedOut, maxSlippageBps);
      plan.shouldSwap = minOut > 0;
      plan.zeroForOne = false;
      plan.amountIn = amountIn;
      plan.minOut = minOut;
      return plan;
    }
    if (balance1 < a1Target) {
      // Shortfall in t1: we have too much t0 in value terms. Swap t0 → t1.
      // Required t1 output = a1Target - b1; convert to t0 input at SPOT (so the post-swap
      // ratio matches what mint will consume at the same spot).
      uint256 amountIn = _quote1To0(a1Target - balance1, uint160(sqrt_));
      uint256 maxSwap = (balance0 * maxSwapBps) / _BPS_DENOMINATOR;
      if (amountIn > maxSwap) amountIn = maxSwap;
      // Same drain-protection on the t0 side: cap input so b0 has at least 1 wei left for the
      // mint's L0 anchor. (Mirror of the a1Target=1 clamp above.)
      if (balance0 > 0 && amountIn >= balance0) amountIn = balance0 - 1;
      if (amountIn == 0) return plan;
      uint256 expectedOut = _quote0To1(amountIn, twapSqrt);
      uint256 minOut = _applySlippage(expectedOut, maxSlippageBps);
      plan.shouldSwap = minOut > 0;
      plan.zeroForOne = true;
      plan.amountIn = amountIn;
      plan.minOut = minOut;
      return plan;
    }
    // balance1 == a1Target: nothing to swap.
  }

  /// @dev Helper for out-of-range case where we want to convert one side entirely into the other.
  function _buildOneSidedPlan(
    uint256 sourceBalance,
    bool zeroForOne,
    uint160 sqrt_,
    uint256 maxSwapBps,
    uint256 maxSlippageBps
  ) internal pure returns (RebalanceSwapPlan memory plan) {
    uint256 amountIn = sourceBalance;
    uint256 maxSwap = (sourceBalance * maxSwapBps) / _BPS_DENOMINATOR;
    if (amountIn > maxSwap) amountIn = maxSwap;
    if (amountIn == 0) return plan;
    uint256 expectedOut = zeroForOne ? _quote0To1(amountIn, sqrt_) : _quote1To0(amountIn, sqrt_);
    uint256 minOut = _applySlippage(expectedOut, maxSlippageBps);
    plan.shouldSwap = minOut > 0;
    plan.zeroForOne = zeroForOne;
    plan.amountIn = amountIn;
    plan.minOut = minOut;
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

    uint160 twapSqrtPriceX96_ = _getTwapSqrtPriceX96(pool, twapWindow);
    uint160 spotSqrtPriceX96_ = _getSpotSqrtPriceX96(pool);
    _validateSpotVsTwap(spotSqrtPriceX96_, twapSqrtPriceX96_, maxTwapDeviationBps);

    uint256 value0In1 = _quote0To1(balance0, twapSqrtPriceX96_);
    uint256 totalIn1 = balance1 + value0In1;
    uint256 targetIn1 = totalIn1 / 2;

    if (value0In1 > targetIn1) {
      uint256 excessValueIn1 = value0In1 - targetIn1;
      uint256 amount0ToSwap = _quote1To0(excessValueIn1, twapSqrtPriceX96_);
      uint256 maxSwap0 = (balance0 * maxSwapBps) / _BPS_DENOMINATOR;
      amount0ToSwap = amount0ToSwap.min(maxSwap0);
      if (amount0ToSwap == 0) {
        return plan;
      }
      uint256 expectedOut1 = _quote0To1(amount0ToSwap, twapSqrtPriceX96_);
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
    uint256 expectedOut0 = _quote1To0(amount1ToSwap, twapSqrtPriceX96_);
    uint256 minOut0 = _applySlippage(expectedOut0, maxSlippageBps);
    plan.shouldSwap = minOut0 > 0;
    plan.zeroForOne = false;
    plan.amountIn = amount1ToSwap;
    plan.minOut = minOut0;
  }

  function _getSpotSqrtPriceX96(address pool) internal view returns (uint160 sqrtPriceX96) {
    (sqrtPriceX96,,,,,) = IPool(pool).slot0();
  }

  /// @dev Soft read of pool.liquidity() — returns 0 if the pool doesn't implement it (e.g. test
  /// mocks). Callers MUST treat 0 as "no price-impact model available" and fall back to the
  /// pre-swap a1Target. Uses staticcall + try/catch-equivalent so an unexpected revert in the
  /// pool's view (paused/upgraded) doesn't brick the rebalance plan.
  function _tryReadPoolLiquidity(address pool) internal view returns (uint128) {
    (bool ok, bytes memory data) = pool.staticcall(abi.encodeWithSignature("liquidity()"));
    if (!ok || data.length < 32) return 0;
    return abi.decode(data, (uint128));
  }

  /// @notice Returns the pool address derived from the position manager's factory + token pair
  /// + tickSpacing. Hoisted out of CLVault to keep its bytecode under the 24,576-byte limit.
  function poolAddressFor(address posManager, address token0_, address token1_, int24 tickSpacing) external view returns (address) {
    return IFactory(INonfungiblePositionManager(posManager).factory()).getPool(token0_, token1_, tickSpacing);
  }

  /// @notice External wrapper for the pool spot sqrtPriceX96. Saves vault bytecode by removing
  /// its IPool import.
  function spotSqrtPriceX96(address pool) external view returns (uint160) {
    return _getSpotSqrtPriceX96(pool);
  }

  /// @notice Pool fee in hundredths of a basis point (UniswapV3 / Aerodrome CL convention).
  /// Used by ERC4626 wrappers to compute fee-aware preview functions.
  function poolFee(address pool) external view returns (uint24) {
    return IPool(pool).fee();
  }

  /// @notice Predicts the share count a `vault.deposit(amount0, amount1, ...)` would mint, given
  /// the supplied pre-deposit `liquidityBefore` (= `vault.underlyingBalanceWithInvestment()`) and
  /// `supply` (= `vault.totalSupply()`). Mirrors `vault._deposit`'s share math:
  ///   L_added = LiquidityAmounts.getLiquidityForAmounts(spot, sqrtLower, sqrtUpper, a0, a1)
  ///   toMint  = supply == 0 ? L_added : L_added * supply / liquidityBefore
  /// Used by ERC4626 wrappers so `previewDeposit` accurately reflects boundary-position behaviour
  /// (where mint consumes amounts in a ratio that may differ from the holder-side weights).
  function quoteDepositShares(
    address pool,
    int24 tickLower,
    int24 tickUpper,
    uint256 supply,
    uint256 liquidityBefore,
    uint256 amount0,
    uint256 amount1
  ) external view returns (uint256) {
    uint128 L = LiquidityAmounts.getLiquidityForAmounts(
      _getSpotSqrtPriceX96(pool),
      TickMath.getSqrtRatioAtTick(tickLower),
      TickMath.getSqrtRatioAtTick(tickUpper),
      amount0,
      amount1
    );
    if (L == 0) return 0;
    if (supply == 0) return uint256(L);
    if (liquidityBefore == 0) return 0;
    return (uint256(L) * supply) / liquidityBefore;
  }

  /// @notice Computes the vault's "underlying balance with investment" — total liquidity-equivalent
  /// of the active position plus any idle balances valued via spot sqrtPrice. Pass in the position
  /// liquidity, tick range, current sqrtPriceX96 and the idle token balances; returns the same
  /// uint256 the vault used to compute internally. Returns 0 if liquidity is 0.
  function quoteUnderlyingBalanceWithInvestment(
    uint160 sqrt,
    int24 tickLower,
    int24 tickUpper,
    uint128 liquidity,
    uint256 idle0,
    uint256 idle1
  ) external pure returns (uint256) {
    if (liquidity == 0) return 0;
    (uint256 a0, uint256 a1) = LiquidityAmounts.getAmountsForLiquidity(
      sqrt,
      TickMath.getSqrtRatioAtTick(tickLower),
      TickMath.getSqrtRatioAtTick(tickUpper),
      liquidity
    );
    uint256 totalIn1 = _toToken1ValueRaw(a0, a1, sqrt);
    uint256 liqU = uint256(liquidity);
    if (totalIn1 == 0) return liqU;
    uint256 idleIn1 = _toToken1ValueRaw(idle0, idle1, sqrt);
    if (idleIn1 == 0) return liqU;
    return liqU + (liqU * idleIn1) / totalIn1;
  }

  /// @dev token1-units value of (amount0, amount1) at the given sqrtPriceX96. Thin wrapper over
  /// _quote0To1 so the two-step overflow-safe mulDiv conversion lives in exactly one place.
  function _toToken1ValueRaw(uint256 amount0, uint256 amount1, uint160 sqrt) internal pure returns (uint256) {
    if (amount0 == 0) return amount1;
    return _quote0To1(amount0, sqrt) + amount1;
  }

  /// @notice Returns the (amount0, amount1) currently represented by the position's liquidity
  /// at the pool's spot sqrtPrice. Used by ERC4626-style wrappers to compute zap-in splits.
  function getCurrentTokenAmounts(
    address pool,
    address posMgr,
    uint256 positionId,
    int24 tickLower,
    int24 tickUpper
  ) external view returns (uint256 amount0, uint256 amount1) {
    (,,,,,,, uint128 liquidity,,,,) = INonfungiblePositionManager(posMgr).positions(positionId);
    if (liquidity == 0) return (0, 0);
    (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
      _getSpotSqrtPriceX96(pool),
      TickMath.getSqrtRatioAtTick(tickLower),
      TickMath.getSqrtRatioAtTick(tickUpper),
      liquidity
    );
  }

  /// @notice Returns weights (w0, w1) summing to 1e18 representing each token's share of the
  /// position's spot value (denominated in token1 units). Used by ERC4626-style wrappers to
  /// decide how to split a single-asset deposit into a two-token vault deposit.
  function getCurrentTokenWeights(
    address pool,
    address posMgr,
    uint256 positionId,
    int24 tickLower,
    int24 tickUpper
  ) external view returns (uint256 w0, uint256 w1) {
    uint160 sqrt = _getSpotSqrtPriceX96(pool);
    (,,,,,,, uint128 liquidity,,,,) = INonfungiblePositionManager(posMgr).positions(positionId);
    if (liquidity == 0) return (0, 0);
    (uint256 a0, uint256 a1) = LiquidityAmounts.getAmountsForLiquidity(
      sqrt,
      TickMath.getSqrtRatioAtTick(tickLower),
      TickMath.getSqrtRatioAtTick(tickUpper),
      liquidity
    );
    uint256 a0In1 = _toToken1ValueRaw(a0, 0, sqrt);
    uint256 totalIn1 = a0In1 + a1;
    if (totalIn1 == 0) return (0, 0);
    w0 = (a0In1 * 1e18) / totalIn1;
    // Compute w1 from the remainder so w0+w1 == 1e18 exactly even with rounding.
    w1 = 1e18 - w0;
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

  function _validateSpotVsTwap(uint160 spotSqrtPriceX96_, uint160 twapSqrtPriceX96_, uint256 maxDeviationBps) internal pure {
    if (maxDeviationBps == 0) {
      return;
    }
    uint256 unit = 1e18;
    uint256 spot0In1 = _quote0To1(unit, spotSqrtPriceX96_);
    uint256 twap0In1 = _quote0To1(unit, twapSqrtPriceX96_);
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
