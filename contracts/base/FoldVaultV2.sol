// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./interface/IERC4626.sol";
import "./FoldVaultV1.sol";

/**
 * @title FoldVaultV2
 * @dev ERC-4626 looping-strategy vault inheriting from `FoldVaultV1` (deposit
 * cap + resilience deposit/withdraw). Its `maxDeposit`/`maxMint` reflect the
 * deposit cap. The base `VaultV2` is intentionally left untouched (== master).
 */
contract FoldVaultV2 is IERC4626, FoldVaultV1 {

    /// @notice Constant used for decimal conversions, initialized to `10` as a `uint256`.
    uint256 public constant TEN = 10;

    /**
     * @notice Returns the underlying asset address.
     * @return Address of the underlying asset.
     */
    function asset() public view override returns (address) {
        return underlying();
    }

    /**
     * @notice Returns the total assets managed by the vault, including invested assets.
     * @return Total assets in the vault.
     */
    function totalAssets() public view override returns (uint256) {
        return underlyingBalanceWithInvestment();
    }

    /**
     * @notice Calculates the value of one share in terms of the underlying asset.
     * @return Value of one share in underlying assets.
     */
    function assetsPerShare() public view override returns (uint256) {
        return convertToAssets(TEN ** decimals());
    }

    /**
     * @notice Returns the total assets owned by a specific depositor.
     * @param _depositor Address of the depositor.
     * @return Total assets of the depositor.
     */
    function assetsOf(address _depositor) public view override returns (uint256) {
        return totalAssets() * balanceOf(_depositor) / totalSupply();
    }

    /**
     * @notice Returns the maximum amount of assets that can be deposited by the caller.
     * @dev Estimate: the cap is enforced in _deposit against the balance measured
     * after preInteract() (fee accrual), so on a live fold position this value can
     * be marginally optimistic. It always errs safe (a deposit never lets TVL
     * exceed the cap). With no cap set it is exact (type(uint256).max).
     * @return Remaining capacity under the deposit cap, or `type(uint256).max` if uncapped.
     */
    function maxDeposit(address /*caller*/) public view override returns (uint256) {
        uint256 cap = depositCap();
        if (cap == 0) return type(uint256).max;
        uint256 tvl = totalAssets();
        return cap > tvl ? cap - tvl : 0;
    }

    /**
     * @notice Provides an estimate of shares that will be minted for a given asset deposit.
     * @param _assets Amount of assets to deposit.
     * @return Estimated number of shares to be minted.
     */
    function previewDeposit(uint256 _assets) public view override returns (uint256) {
        return convertToShares(_assets);
    }

    /**
     * @notice Deposits assets in the vault and mints shares to the receiver.
     * @param _assets Amount of assets to deposit.
     * @param _receiver Address that will receive the minted shares.
     * @return Number of shares minted.
     */
    function deposit(uint256 _assets, address _receiver) public override nonReentrant defense returns (uint256) {
        uint256 shares = _deposit(_assets, msg.sender, _receiver);
        return shares;
    }

    /**
     * @notice Returns the maximum amount of shares that can be minted by the caller.
     * @return Shares mintable under the deposit cap, or `type(uint256).max` if uncapped.
     */
    function maxMint(address _caller) public view override returns (uint256) {
        if (depositCap() == 0) return type(uint256).max;
        return convertToShares(maxDeposit(_caller));
    }

    /**
     * @notice Provides an estimate of assets required to mint a given amount of shares.
     * @param _shares Amount of shares to mint.
     * @return Estimated amount of assets needed.
     */
    function previewMint(uint256 _shares) public view override returns (uint256) {
        return convertToAssets(_shares);
    }

    /**
     * @notice Mints shares to the receiver by depositing the required amount of assets.
     * @param _shares Number of shares to mint.
     * @param _receiver Address that will receive the minted shares.
     * @return Amount of assets deposited.
     */
    function mint(uint256 _shares, address _receiver) public override nonReentrant defense returns (uint256) {
        uint assets = convertToAssets(_shares);
        _deposit(assets, msg.sender, _receiver);
        return assets;
    }

    /**
     * @notice Returns the maximum amount of assets that can be withdrawn by a caller.
     * @param _caller Address of the caller.
     * @return Maximum withdrawable asset amount.
     */
    function maxWithdraw(address _caller) public view override returns (uint256) {
        return assetsOf(_caller);
    }

    /**
     * @notice Provides an estimate of shares needed to withdraw a specified amount of assets.
     * @param _assets Amount of assets to withdraw.
     * @return Estimated shares required.
     */
    function previewWithdraw(uint256 _assets) public view override returns (uint256) {
        return convertToShares(_assets);
    }

    /**
     * @notice Withdraws assets from the vault by burning a proportional amount of shares.
     * @param _assets Amount of assets to withdraw.
     * @param _receiver Address to receive the withdrawn assets.
     * @param _owner Address of the share owner.
     * @return Number of shares burned.
     */
    function withdraw(
        uint256 _assets,
        address _receiver,
        address _owner
    ) public override nonReentrant defense returns (uint256) {
        uint256 shares = convertToShares(_assets);
        _withdraw(shares, _receiver, _owner);
        return shares;
    }

    /**
     * @notice Returns the maximum number of shares that can be redeemed by the caller.
     * @param _caller Address of the caller.
     * @return Maximum redeemable shares.
     */
    function maxRedeem(address _caller) public view override returns (uint256) {
        return balanceOf(_caller);
    }

    /**
     * @notice Provides an estimate of assets that would be returned for a specified amount of shares.
     * @param _shares Amount of shares to redeem.
     * @return Estimated amount of assets returned.
     */
    function previewRedeem(uint256 _shares) public view override returns (uint256) {
        return convertToAssets(_shares);
    }

    /**
     * @notice Redeems shares for assets and transfers the assets to the receiver.
     * @param _shares Number of shares to redeem.
     * @param _receiver Address to receive the redeemed assets.
     * @param _owner Address of the share owner.
     * @return Amount of assets transferred.
     */
    function redeem(
        uint256 _shares,
        address _receiver,
        address _owner
    ) public override nonReentrant defense returns (uint256) {
        uint256 assets = _withdraw(_shares, _receiver, _owner);
        return assets;
    }

    // ========================= Conversion Functions =========================

    /**
     * @notice Converts a given amount of shares to the equivalent amount of assets.
     * @param _shares Amount of shares to convert.
     * @return Equivalent amount of assets.
     */
    function convertToAssets(uint256 _shares) public view returns (uint256) {
        return totalAssets() == 0 || totalSupply() == 0
            ? _shares * (TEN ** ERC20Upgradeable(underlying()).decimals()) / (TEN ** decimals())
            : _shares * totalAssets() / totalSupply();
    }

    /**
     * @notice Converts a given amount of assets to the equivalent amount of shares.
     * @param _assets Amount of assets to convert.
     * @return Equivalent amount of shares.
     */
    function convertToShares(uint256 _assets) public view returns (uint256) {
        return totalAssets() == 0 || totalSupply() == 0
            ? _assets * (TEN ** decimals()) / (TEN ** ERC20Upgradeable(underlying()).decimals())
            : _assets * totalSupply() / totalAssets();
    }
}
