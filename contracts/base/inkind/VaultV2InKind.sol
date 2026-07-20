// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "../interface/IERC4626.sol";
import "../VaultV1.sol";

/**
 * @dev Minimal interface for the in-kind functions the strategy must expose.
 * Only called while in-kind redemptions are explicitly enabled by governance,
 * so strategies without these functions remain compatible with this vault.
 */
interface IInKindStrategy {
    function withdrawInKind(uint256 shareNumerator, uint256 shareDenominator, address receiver) external returns (uint256);
    function previewWithdrawInKind(uint256 shareNumerator, uint256 shareDenominator) external view returns (uint256);
    function syncBalance() external;
    function syncedInvestedUnderlyingBalance() external view returns (uint256);
    function rewardPool() external view returns (address);
}

/**
 * @title VaultV2InKind
 * @dev ERC-4626 compliant vault based on `VaultV1`, extended with
 * governance-gated in-kind redemptions: while enabled, share holders can burn their vault
 * shares and receive their pro-rata slice of the strategy's position tokens (the lending
 * pool's ERC-20 shares) directly, instead of the underlying asset. This provides an exit
 * when the downstream lending pool has no redeemable liquidity, alongside the normal
 * withdrawal path — the vault stays fully functional in all other respects. While in-kind
 * redemptions are enabled, every deposit and withdrawal first syncs the strategy's cached
 * balance and the ERC-4626 views quote at the live (synced) rate, so previews match
 * execution exactly; minting at a stale cached price and immediately redeeming the true
 * pro-rata token slice would otherwise capture unaccrued yield from existing holders.
 */
contract VaultV2InKind is IERC4626, VaultV1 {
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using SafeMathUpgradeable for uint256;

    /// @notice Constant used for decimal conversions, initialized to `10` as a `uint256`.
    uint256 public constant TEN = 10;

    bytes32 internal constant _REDEEM_IN_KIND_ENABLED_SLOT = 0xa1c4a46e26d435a0ab545346c100c3d90a738cc204528b23378616049e546b9f;

    event RedeemInKind(
        address indexed sender,
        address indexed receiver,
        address indexed owner,
        uint256 shares,
        uint256 assetsOut,
        uint256 poolSharesOut
    );
    event RedeemInKindEnabled(bool enabled);

    constructor() {
        assert(_REDEEM_IN_KIND_ENABLED_SLOT == bytes32(uint256(keccak256("eip1967.vaultStorage.redeemInKindEnabled")) - 1));
    }

    // ========================= In-Kind Redemption =========================

    /**
     * @notice Whether in-kind redemptions are currently enabled.
     */
    function redeemInKindEnabled() public view returns (bool) {
        return getBoolean(_REDEEM_IN_KIND_ENABLED_SLOT);
    }

    /**
     * @notice Enables or disables in-kind redemptions. While enabled, deposits sync the
     * strategy's cached balance first, so the strategy must implement `syncBalance`.
     * @param _enabled New state of the in-kind redemption switch.
     */
    function setRedeemInKindEnabled(bool _enabled) external onlyGovernance {
        setBoolean(_REDEEM_IN_KIND_ENABLED_SLOT, _enabled);
        emit RedeemInKindEnabled(_enabled);
    }

    /**
     * @notice Redeems `_owner`'s vault shares for their pro-rata slice of the vault's holdings,
     * paid out to `_receiver` as the strategy's position tokens (lending pool shares) plus a
     * pro-rata part of any underlying idle in the vault. The payout is a proportional split of
     * the tokens actually held, so it does not depend on the vault's cached share price.
     * @param _shares Number of vault shares to redeem.
     * @param _receiver Address receiving the pool shares and underlying.
     * @param _owner Address whose vault shares are burned.
     * @return assetsOut Amount of underlying transferred (pro-rata share of vault-idle balance).
     * @return poolSharesOut Amount of lending pool shares transferred.
     */
    function redeemInKind(
        uint256 _shares,
        address _receiver,
        address _owner
    ) public nonReentrant defense whenStrategyDefined returns (uint256 assetsOut, uint256 poolSharesOut) {
        require(redeemInKindEnabled(), "In-kind redemptions not enabled");
        require(_shares > 0, "shares must be greater than 0");
        require(_receiver != address(0), "receiver must be defined");
        uint256 totalSupplyBefore = totalSupply();
        require(totalSupplyBefore > 0, "Vault has no shares");

        if (msg.sender != _owner) {
            uint256 currentAllowance = allowance(_owner, msg.sender);
            if (currentAllowance != type(uint256).max) {
                require(currentAllowance >= _shares, "ERC20: transfer amount exceeds allowance");
                _approve(_owner, msg.sender, currentAllowance - _shares);
            }
        }
        _burn(_owner, _shares);

        assetsOut = underlyingBalanceInVault().mul(_shares).div(totalSupplyBefore);
        poolSharesOut = IInKindStrategy(strategy()).withdrawInKind(_shares, totalSupplyBefore, _receiver);
        require(assetsOut > 0 || poolSharesOut > 0, "nothing to redeem");
        if (assetsOut > 0) {
            IERC20Upgradeable(underlying()).safeTransfer(_receiver, assetsOut);
        }

        emit RedeemInKind(msg.sender, _receiver, _owner, _shares, assetsOut, poolSharesOut);
    }

    /**
     * @notice Estimates the payout of `redeemInKind` for a given number of vault shares.
     * @param _shares Number of vault shares to redeem.
     * @return assetsOut Estimated underlying payout (pro-rata share of vault-idle balance).
     * @return poolSharesOut Estimated lending pool share payout.
     */
    function previewRedeemInKind(uint256 _shares) public view returns (uint256 assetsOut, uint256 poolSharesOut) {
        uint256 supply = totalSupply();
        if (_shares == 0 || supply == 0 || strategy() == address(0)) {
            return (0, 0);
        }
        assetsOut = underlyingBalanceInVault().mul(_shares).div(supply);
        poolSharesOut = IInKindStrategy(strategy()).previewWithdrawInKind(_shares, supply);
    }

    /**
     * @notice The lending pool share token paid out by `redeemInKind`.
     */
    function inKindToken() public view returns (address) {
        return IInKindStrategy(strategy()).rewardPool();
    }

    /**
     * @dev Syncs the strategy's cached balance while in-kind redemptions are enabled.
     * Deposits and withdrawals then price at the live rate, so minting at a stale cached
     * price and immediately redeeming the true pro-rata token slice cannot capture
     * unaccrued yield from existing holders. A no-op while the switch is off.
     */
    function _syncStrategy() internal {
        address _strategy = strategy();
        if (redeemInKindEnabled() && _strategy != address(0)) {
            IInKindStrategy(_strategy).syncBalance();
        }
    }

    function _deposit(uint256 amount, address sender, address beneficiary) internal override returns (uint256) {
        _syncStrategy();
        return super._deposit(amount, sender, beneficiary);
    }

    function _withdraw(uint256 numberOfShares, address receiver, address owner) internal override returns (uint256) {
        _syncStrategy();
        return super._withdraw(numberOfShares, receiver, owner);
    }

    // ========================= ERC-4626 Functions =========================

    /**
     * @notice Returns the underlying asset address.
     * @return Address of the underlying asset.
     */
    function asset() public view override returns (address) {
        return underlying();
    }

    /**
     * @notice Returns the total assets managed by the vault, including invested assets.
     * While in-kind redemptions are enabled this quotes at the live (synced) strategy
     * balance so that previews match execution, which syncs before pricing.
     * @return Total assets in the vault.
     */
    function totalAssets() public view override returns (uint256) {
        address _strategy = strategy();
        if (redeemInKindEnabled() && _strategy != address(0)) {
            return underlyingBalanceInVault() + IInKindStrategy(_strategy).syncedInvestedUnderlyingBalance();
        }
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
     * @return Maximum deposit limit as `type(uint256).max` (no limit).
     */
    function maxDeposit(address /*caller*/) public pure override returns (uint256) {
        return type(uint256).max;
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
     * @return Maximum mint limit as `type(uint256).max` (no limit).
     */
    function maxMint(address /*caller*/) public pure override returns (uint256) {
        return type(uint256).max;
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
        _syncStrategy();
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
        _syncStrategy();
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
