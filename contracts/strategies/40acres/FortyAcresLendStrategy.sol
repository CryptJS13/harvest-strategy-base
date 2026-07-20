//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "../euler/EulerLendStrategy.sol";

/**
 * @title FortyAcresLendStrategy
 * @dev EulerLendStrategy extended with in-kind withdrawals: the vault can pull a pro-rata
 * slice of the strategy's lending pool shares and send them straight to a redeeming user.
 * This provides an exit for vault users while the lending pool has no redeemable liquidity.
 * The pool shares backing accrued-but-unpaid fees are carved out before the split so fee
 * accounting stays intact.
 */
contract FortyAcresLendStrategy is EulerLendStrategy {

  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  event WithdrawInKind(address indexed receiver, uint256 shareNumerator, uint256 shareDenominator, uint256 poolSharesOut);

  constructor() EulerLendStrategy() {}

  /**
   * @notice Transfers `_shareNumerator / _shareDenominator` of the strategy's lending pool
   * shares (net of the shares backing pending fees) to `_receiver`. Called by the vault
   * when a user redeems vault shares in kind; the fraction is the user's share of the
   * vault's total supply, so the payout is exactly proportional to the tokens held and
   * does not depend on any cached exchange rate.
   * @param _shareNumerator Numerator of the redeemed fraction (redeemed vault shares).
   * @param _shareDenominator Denominator of the redeemed fraction (vault total supply before burn).
   * @param _receiver Address receiving the pool shares.
   * @return poolSharesOut Amount of pool shares transferred.
   */
  function withdrawInKind(
    uint256 _shareNumerator,
    uint256 _shareDenominator,
    address _receiver
  ) external restricted returns (uint256 poolSharesOut) {
    require(_shareDenominator > 0, "denominator must be greater than 0");
    require(_shareNumerator <= _shareDenominator, "numerator must not exceed denominator");
    _accrueFee();
    address _pool = eulerVault();
    uint256 balance = IERC20(_pool).balanceOf(address(this));
    uint256 feeShares = IERC4626(_pool).previewWithdraw(pendingFee());
    uint256 netBalance = balance > feeShares ? balance.sub(feeShares) : 0;
    poolSharesOut = netBalance.mul(_shareNumerator).div(_shareDenominator);
    if (poolSharesOut > 0) {
      IERC20(_pool).safeTransfer(_receiver, poolSharesOut);
    }
    _updateStoredBalance();
    emit WithdrawInKind(_receiver, _shareNumerator, _shareDenominator, poolSharesOut);
  }

  /**
   * @notice Accrues fees and refreshes the cached balance so the vault's share price
   * reflects the pool's live rate. Called by the vault before minting deposits while
   * in-kind redemptions are enabled.
   */
  function syncBalance() external restricted {
    _accrueFee();
    _updateStoredBalance();
  }

  /**
   * @dev Returns the pending fee as it would stand right after an accrual, i.e. including
   * the fee on any balance increase since the last sync.
   */
  function _simulatedPendingFee() internal view returns (uint256) {
    uint256 pending = pendingFee();
    uint256 current = currentBalance();
    uint256 stored = storedBalance();
    if (current > stored) {
      pending = pending.add(current.sub(stored).mul(totalFeeNumerator()).div(feeDenominator()));
    }
    return pending;
  }

  /**
   * @notice Returns the invested underlying balance as it would stand right after
   * `syncBalance`, i.e. based on the pool's live rate instead of the cached balance.
   * Used by the vault to quote deposits and withdrawals while in-kind redemptions are
   * enabled, so previews match the synced rate used during execution.
   * @return Live invested underlying balance, net of pending fees.
   */
  function syncedInvestedUnderlyingBalance() public view returns (uint256) {
    uint256 gross = IERC20(underlying()).balanceOf(address(this)).add(currentBalance());
    uint256 pending = _simulatedPendingFee();
    return gross > pending ? gross.sub(pending) : 0;
  }

  /**
   * @notice Estimates the pool share payout of `withdrawInKind` for a given fraction,
   * including the fee that would be accrued at execution time.
   * @param _shareNumerator Numerator of the redeemed fraction.
   * @param _shareDenominator Denominator of the redeemed fraction.
   * @return Estimated amount of pool shares that would be transferred.
   */
  function previewWithdrawInKind(
    uint256 _shareNumerator,
    uint256 _shareDenominator
  ) public view returns (uint256) {
    if (_shareDenominator == 0) {
      return 0;
    }
    address _pool = eulerVault();
    uint256 balance = IERC20(_pool).balanceOf(address(this));
    uint256 feeShares = IERC4626(_pool).previewWithdraw(_simulatedPendingFee());
    uint256 netBalance = balance > feeShares ? balance.sub(feeShares) : 0;
    return netBalance.mul(_shareNumerator).div(_shareDenominator);
  }
}
