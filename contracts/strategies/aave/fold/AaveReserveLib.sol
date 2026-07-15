// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../../base/interface/IUniversalLiquidator.sol";
import "../../../base/interface/aave/IPool.sol";
import "./AaveViewer.sol";

/**
 * @notice Off-strategy helpers for the Aave 2-asset fold strategy. Lives as an
 *         external library (DELEGATECALL) so the strategy fits the EIP-170
 *         code-size limit; the strategy is `address(this)` in every call, so
 *         balances, the health factor and token approvals all resolve to it.
 *
 *         Gas notes:
 *         - Prices come from a single AaveViewer.getPrice call; the reciprocal
 *           direction is derived arithmetically (floor(1e36 / price)), which is
 *           exactly what a second getPrice returns, halving the oracle reads.
 *         - `snap` returns the liquidation threshold alongside the position, so
 *           the strategy threads it through its hot paths and never pays for a
 *           second getUserAccountData in the same operation.
 *         - EIP-2929 makes every library call after the first in a tx "warm"
 *           (~150 gas), so the delegatecall overhead is negligible versus the
 *           external-read savings above.
 *
 *         Aave V3 ReserveConfigurationMap.data bit layout:
 *           48-55 decimals  56 active  57 frozen  58 borrowing enabled  60 paused
 *           80-115 borrow cap (whole units; 0 = uncapped)  116-151 supply cap
 *         Flags: bit 1 borrow ok, bit 2 supply ok, bit 4 repay/withdraw ok.
 */
library AaveReserveLib {

  using SafeERC20 for IERC20;

  uint256 internal constant BPS = 10_000;
  uint256 private constant CAP_MASK = (1 << 36) - 1;
  address private constant VIEWER = address(0x1e51654aB193bA165b7F7715C734dAF454f08148);

  // ---------------------------------------------------------------------------
  // Prices: one getPrice read; the reverse direction is its exact reciprocal.
  // ---------------------------------------------------------------------------
  function _prices(address supplyAsset, address underlying)
    private view returns (uint256 priceSupplyInBorrow, uint256 priceBorrowInSupply)
  {
    priceSupplyInBorrow = AaveViewer(VIEWER).getPrice(supplyAsset, underlying);
    priceBorrowInSupply = (1e18 * 1e18) / priceSupplyInBorrow;
  }

  function prices(address supplyAsset, address underlying)
    external view returns (uint256 priceSupplyInBorrow, uint256 priceBorrowInSupply)
  {
    return _prices(supplyAsset, underlying);
  }

  // ---------------------------------------------------------------------------
  // Full position snapshot: both prices, debt, collateral-in-debt-units and the
  // health factor. The liquidation threshold is intentionally NOT read here —
  // only the two lever paths need it, and reading it in every snapshot would tax
  // the withdraw / fee paths with a getUserAccountData they never use. Those two
  // callers read it once locally instead.
  // ---------------------------------------------------------------------------
  function snap(
    address supplyAsset,
    address underlying,
    address supplyAToken,
    address borrowAToken
  ) external view returns (
    uint256 priceSupplyInBorrow,
    uint256 priceBorrowInSupply,
    uint256 borrowedDebt,
    uint256 suppliedInDebt,
    uint256 health
  ) {
    (priceSupplyInBorrow, priceBorrowInSupply) = _prices(supplyAsset, underlying);
    borrowedDebt = IERC20(borrowAToken).balanceOf(address(this));
    suppliedInDebt = (IERC20(supplyAToken).balanceOf(address(this)) * priceSupplyInBorrow) / 1e18;
    health = AaveViewer(VIEWER).getPositionHealth();
  }

  // ---------------------------------------------------------------------------
  // Reserve status flags.
  // ---------------------------------------------------------------------------
  function _flagsFor(
    IPool pool,
    address asset,
    address debtToken,
    address aToken
  ) private view returns (uint8 flags) {
    uint256 d = pool.getConfiguration(asset).data;
    bool active = ((d >> 56) & 1) == 1;
    bool paused = ((d >> 60) & 1) == 1;
    if (active && !paused) flags |= 4;
    if (!active || paused) return flags;
    if (((d >> 57) & 1) == 1) return flags; // frozen
    uint256 dec = (d >> 48) & 0xFF;
    if (debtToken != address(0) && ((d >> 58) & 1) == 1) {
      uint256 cap = (d >> 80) & CAP_MASK;
      if (cap == 0 || IERC20(debtToken).totalSupply() < cap * (10 ** dec)) flags |= 1;
    }
    if (aToken != address(0)) {
      uint256 cap = (d >> 116) & CAP_MASK;
      if (cap == 0 || IERC20(aToken).totalSupply() < cap * (10 ** dec)) flags |= 2;
    }
  }

  function borrowFlags(IPool pool, address asset, address debtToken) external view returns (uint8) {
    return _flagsFor(pool, asset, debtToken, address(0));
  }

  function supplyFlags(IPool pool, address asset, address aToken) external view returns (uint8) {
    return _flagsFor(pool, asset, address(0), aToken);
  }

  // ---------------------------------------------------------------------------
  // Cap headroom: how many token units of extra borrow / supply the reserve can
  // still absorb (type(uint256).max when uncapped). aToken/debtToken totalSupply
  // excludes reserve.accruedToTreasury, so the caller applies a safety buffer.
  // ---------------------------------------------------------------------------
  function _capHeadroom(IPool pool, address asset, address token, uint256 capShift) private view returns (uint256) {
    uint256 d = pool.getConfiguration(asset).data;
    uint256 cap = (d >> capShift) & CAP_MASK;
    if (cap == 0) return type(uint256).max;
    uint256 capBase = cap * (10 ** ((d >> 48) & 0xFF));
    uint256 ts = IERC20(token).totalSupply();
    return capBase > ts ? capBase - ts : 0;
  }

  function borrowCapHeadroom(IPool pool, address asset, address debtToken) external view returns (uint256) {
    return _capHeadroom(pool, asset, debtToken, 80);
  }

  function supplyCapHeadroom(IPool pool, address asset, address aToken) external view returns (uint256) {
    return _capHeadroom(pool, asset, aToken, 116);
  }

  /**
   * @notice Clamp a desired new-debt increase to what BOTH reserves can still
   *         absorb under their borrow/supply caps, minus a safety buffer.
   */
  function capClampedDebtIncrease(
    IPool pool,
    address borrowAsset,
    address debtToken,
    address supplyAsset,
    address aToken,
    uint256 desired,
    uint256 priceSupplyInBorrow,
    uint256 bufferBps
  ) external view returns (uint256) {
    uint256 bh = _capHeadroom(pool, borrowAsset, debtToken, 80);
    if (bh != type(uint256).max) {
      bh = (bh * (BPS - bufferBps)) / BPS;
      if (desired > bh) desired = bh;
    }
    uint256 sh = _capHeadroom(pool, supplyAsset, aToken, 116);
    if (sh != type(uint256).max) {
      uint256 debtBound = (((sh * (BPS - bufferBps)) / BPS) * priceSupplyInBorrow) / 1e18;
      if (desired > debtBound) desired = debtBound;
    }
    return desired;
  }

  // ---------------------------------------------------------------------------
  // Oracle-priced swap through the universal liquidator with a slippage floor.
  // ---------------------------------------------------------------------------
  function _swap(
    address universalLiquidator,
    address from,
    address to,
    uint256 amount,
    address supplyAsset,
    address underlying,
    uint256 priceSupplyInBorrow,
    uint256 priceBorrowInSupply,
    uint256 slippageBps
  ) private {
    uint256 oracleOut;
    if (from == supplyAsset && to == underlying) {
      oracleOut = (amount * priceSupplyInBorrow) / 1e18;
    } else if (from == underlying && to == supplyAsset) {
      oracleOut = (amount * priceBorrowInSupply) / 1e18;
    } else {
      revert("pair");
    }
    uint256 minOut = (oracleOut * (BPS - slippageBps)) / BPS;
    IERC20(from).safeApprove(universalLiquidator, 0);
    IERC20(from).safeApprove(universalLiquidator, amount);
    IUniversalLiquidator(universalLiquidator).swap(from, to, amount, minOut, address(this));
  }

  function swapWithSlippage(
    address universalLiquidator,
    address from,
    address to,
    uint256 amount,
    address supplyAsset,
    address underlying,
    uint256 priceSupplyInBorrow,
    uint256 priceBorrowInSupply,
    uint256 slippageBps
  ) external {
    _swap(universalLiquidator, from, to, amount, supplyAsset, underlying,
          priceSupplyInBorrow, priceBorrowInSupply, slippageBps);
  }

  // ---------------------------------------------------------------------------
  // Manual non-flashloan deleverage step (governance fallback): withdraw
  // collateral, swap to the underlying, repay debt. Aave reverts the withdraw
  // if it would push HF below 1, bounding the chunk size.
  // ---------------------------------------------------------------------------
  function manualDeleverStep(
    address pool,
    address universalLiquidator,
    address supplyAsset,
    address underlying,
    address debtToken,
    uint256 slippageBps,
    uint256 collateralAmount
  ) external {
    if (collateralAmount > 0) {
      IPool(pool).withdraw(supplyAsset, collateralAmount, address(this));
    }
    uint256 collBal = IERC20(supplyAsset).balanceOf(address(this));
    if (collBal > 0) {
      (uint256 ps, uint256 pb) = _prices(supplyAsset, underlying);
      _swap(universalLiquidator, supplyAsset, underlying, collBal, supplyAsset, underlying, ps, pb, slippageBps);
    }
    uint256 owed = IERC20(debtToken).balanceOf(address(this));
    uint256 idle = IERC20(underlying).balanceOf(address(this));
    if (owed > 0 && idle > 0) {
      uint256 amt = idle < owed ? idle : owed;
      IERC20(underlying).safeApprove(pool, 0);
      IERC20(underlying).safeApprove(pool, amt);
      IPool(pool).repay(underlying, amt, 2, address(this));
    }
  }
}
