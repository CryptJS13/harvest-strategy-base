// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./interface/IERC4626.sol";
import "./interface/ICLVault.sol";
import "./interface/ICLRebalanceHelper.sol";
import "./interface/IController.sol";
import "./interface/IUniversalLiquidator.sol";
import "./inheritance/Controllable.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @title CLWrapper
/// @notice Single-asset (ERC4626-style) zap-in/out wrapper around a dual-token CLVault.
///         Depositors hand over a single token (`asset`); the wrapper splits it into the right
///         (token0, token1) ratio for the vault's current position by routing one half through
///         the universal liquidator, then forwards the deposit. Vault shares mint directly to
///         the receiver; the wrapper itself holds no shares between calls.
///         Redeem: pulls vault shares from owner, withdraws from the vault, swaps the non-asset
///         token back into asset, and sends asset to receiver.
contract CLWrapper is Controllable, ReentrancyGuard, IERC4626 {
    using SafeERC20 for IERC20;

    address internal immutable _vault;
    address internal immutable _asset;
    bool internal immutable _assetIsToken0;
    address internal immutable _pool;
    // token0/token1 are immutable on the vault post-init; caching them here removes an external
    // staticcall (plus the vault's keccak-slot SLOAD) from every deposit, redeem, and preview.
    address internal immutable _token0;
    address internal immutable _token1;
    uint256 internal constant _BPS_DENOMINATOR = 10_000;
    uint256 internal constant _Q96 = 2 ** 96;
    uint256 internal constant _MAX_PREVIEW_SAFETY_BPS = 1000; // hard cap on the buffer

    /// @notice Extra basis-point buffer applied on top of the fee-aware preview to cover small
    /// price impact, UL routing spreads, and rounding. Governance-tunable per wrapper instance.
    /// Default 25 bps. Governance should re-tune after testnet validation per asset pair.
    uint16 public previewSafetyBps = 25;

    /// @notice Maximum slippage (in bps) the wrapper accepts on each individual swap leg vs the
    /// pool's spot×(1-poolFee) quote. Protects users from broken/multi-hop UL routes that would
    /// otherwise silently bleed value (e.g. 25%+ on sub-dust BTC swaps). Default 100 bps (1%).
    /// Governance-tunable; capped at 1000 bps. Set higher per-pair only when the routing is
    /// known-lossy and a user has accepted that explicitly.
    uint16 public maxSwapSlippageBps = 100;

    event PreviewSafetyBpsUpdated(uint16 newValue);
    event MaxSwapSlippageBpsUpdated(uint16 newValue);

    error WrapperZeroAmount();
    error WrapperSlippage();
    error WrapperSafetyBpsTooLarge();
    error WrapperSwapBelowPrecision();

    /// @dev Greylist defense — contracts on the controller's greylist can't deposit/redeem,
    /// EOAs and unlisted contracts pass through.
    modifier defense() {
        require(
            msg.sender == tx.origin || !IController(controller()).greyList(msg.sender),
            "grey list"
        );
        _;
    }

    constructor(
        address _storage,
        address vaultAddress,
        bool useToken0
    ) Controllable(_storage) ReentrancyGuard() {
        _vault = vaultAddress;
        _assetIsToken0 = useToken0;
        address t0 = ICLVault(vaultAddress).token0();
        address t1 = ICLVault(vaultAddress).token1();
        _token0 = t0;
        _token1 = t1;
        _asset = useToken0 ? t0 : t1;
        // Cache pool address — token0/token1/tickSpacing on the vault are immutable post-init,
        // so the pool is too. Helper is allowed to change later; its `poolAddressFor` view is a
        // pure derivation of those inputs, so any future helper returns the same pool.
        _pool = ICLRebalanceHelper(ICLVault(vaultAddress).rebalanceHelper()).poolAddressFor(
            ICLVault(vaultAddress).posManager(),
            t0,
            t1,
            ICLVault(vaultAddress).tickSpacing()
        );
    }

    /// @notice Governance-tunable safety buffer applied on top of the fee-aware preview.
    /// Default 25 bps (see `previewSafetyBps` declaration); capped at 1000 bps.
    function setPreviewSafetyBps(uint16 newValue) external onlyGovernance {
        if (newValue > _MAX_PREVIEW_SAFETY_BPS) revert WrapperSafetyBpsTooLarge();
        previewSafetyBps = newValue;
        emit PreviewSafetyBpsUpdated(newValue);
    }

    /// @notice Governance-tunable cap on per-swap-leg slippage. Default 100 bps (1%); cap 1000.
    function setMaxSwapSlippageBps(uint16 newValue) external onlyGovernance {
        if (newValue > _MAX_PREVIEW_SAFETY_BPS) revert WrapperSafetyBpsTooLarge();
        maxSwapSlippageBps = newValue;
        emit MaxSwapSlippageBpsUpdated(newValue);
    }

    /// @notice Returns the underlying pool address this wrapper is bound to.
    function pool() external view returns (address) {
        return _pool;
    }

    // ============================================================================
    // ERC4626 metadata
    // ============================================================================

    function asset() external view override returns (address) {
        return _asset;
    }

    function vault() external view returns (address) {
        return _vault;
    }

    function balanceOf(address depositor) public view returns (uint256) {
        return ICLVault(_vault).balanceOf(depositor);
    }

    function totalSupply() public view returns (uint256) {
        return ICLVault(_vault).totalSupply();
    }

    /// @notice NAV expressed in `asset` units. Uses spot sqrtPrice via the vault's helper.
    function totalAssets() public view override returns (uint256) {
        (uint256 a0, uint256 a1) = ICLVault(_vault).getCurrentTokenAmounts();
        return _quoteInAsset(a0, a1, ICLVault(_vault).getSqrtPriceX96());
    }

    function assetsPerShare() external view override returns (uint256) {
        return convertToAssets(1e18);
    }

    function assetsOf(address depositor) public view override returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 0;
        return (totalAssets() * balanceOf(depositor)) / supply;
    }

    // ============================================================================
    // ERC4626 deposit/redeem (mint/withdraw not supported — see reverts below)
    // ============================================================================

    function maxDeposit(address /*caller*/) external pure override returns (uint256) {
        return type(uint256).max;
    }

    /// @notice Mint-aware preview of `deposit(assets)`. Mirrors the wrapper's full deposit flow:
    /// (1) split the input by the position's value-weights, (2) predict swap output at spot ×
    /// (1 - poolFee), (3) feed the resulting (a0, a1) through the same `getLiquidityForAmounts`
    /// math the vault uses, and (4) convert L → shares using the vault's pre-deposit NAV in
    /// liquidity units. This is accurate even for tick-boundary positions, where the mint
    /// consumes (a0, a1) in a ratio that may differ from the holder-side spot weights and most
    /// of the input ends up as leftover dust returned to the receiver.
    function previewDeposit(uint256 assets) public view override returns (uint256) {
        if (assets == 0) return 0;
        uint256 supply = totalSupply();
        uint256 navL = ICLVault(_vault).underlyingBalanceWithInvestment();
        if (supply == 0) return assets; // first depositor mints L of the new mint
        if (navL == 0) return 0;

        ICLRebalanceHelper rh = ICLRebalanceHelper(ICLVault(_vault).rebalanceHelper());
        uint160 sqrt = rh.spotSqrtPriceX96(_pool);
        uint24 feeHun = rh.poolFee(_pool);

        // Same split + truncation guard as _depositInternal, so preview correctly returns 0
        // for sizes the deposit would refuse anyway.
        (uint256 swapPortion, bool ok) = _computeSwapPortion(assets);
        if (!ok) return 0;
        // Estimated raw amount received from the swap leg, accounting for pool fee. Spot-priced
        // (no impact). UL routing may add extra friction — `previewSafetyBps` covers that.
        uint256 swapOutOther = _quoteSwapOut(swapPortion, sqrt, feeHun);

        uint256 a0;
        uint256 a1;
        if (_assetIsToken0) {
            a0 = assets - swapPortion;
            a1 = swapOutOther;
        } else {
            a1 = assets - swapPortion;
            a0 = swapOutOther;
        }

        uint256 mintShares = rh.quoteDepositShares(
            _pool, ICLVault(_vault).tickLower(), ICLVault(_vault).tickUpper(),
            supply, navL, a0, a1
        );
        return _applySafetyBuffer(mintShares);
    }

    function deposit(uint256 assets, address receiver) external override nonReentrant defense returns (uint256) {
        return _depositInternal(assets, msg.sender, receiver, previewDeposit(assets));
    }

    function deposit(uint256 assets, address receiver, uint256 minSharesOut) external nonReentrant defense returns (uint256) {
        return _depositInternal(assets, msg.sender, receiver, minSharesOut);
    }

    function maxMint(address) external pure override returns (uint256) {
        return 0;
    }

    function previewMint(uint256) external pure override returns (uint256) {
        revert("Use deposit");
    }

    function mint(uint256, address) external pure override returns (uint256) {
        revert("Use deposit");
    }

    function maxWithdraw(address) external pure override returns (uint256) {
        return 0;
    }

    function previewWithdraw(uint256) external pure override returns (uint256) {
        revert("Use redeem");
    }

    function withdraw(uint256, address, address) external pure override returns (uint256) {
        revert("Use redeem");
    }

    function maxRedeem(address depositor) external view override returns (uint256) {
        return balanceOf(depositor);
    }

    /// @notice Mint-aware preview of `redeem(shares)`. Mirrors the wrapper's full redeem flow:
    /// (1) compute the per-side payout the vault would return for `shares`, including a
    /// proportional slice of any idle balances, (2) swap the non-asset side back into the asset
    /// at spot × (1 - poolFee), (3) sum into asset units. Like `previewDeposit`, this is exact
    /// for in-range positions (linear in L), correct for out-of-range positions (one side is 0),
    /// and only approximated by `previewSafetyBps` for the residual UL routing friction.
    function previewRedeem(uint256 shares) public view override returns (uint256) {
        if (shares == 0) return 0;
        uint256 supply = totalSupply();
        if (supply == 0) return 0;

        ICLRebalanceHelper rh = ICLRebalanceHelper(ICLVault(_vault).rebalanceHelper());
        uint160 sqrt = rh.spotSqrtPriceX96(_pool);
        uint24 feeHun = rh.poolFee(_pool);

        (uint256 a0Pos, uint256 a1Pos) = ICLVault(_vault).getCurrentTokenAmounts();
        // Scale by shares fraction. Proportional scaling is exact for in-range positions
        // because LiquidityAmounts is linear in liquidity at fixed sqrtPrice.
        uint256 received0 = (a0Pos * shares) / supply;
        uint256 received1 = (a1Pos * shares) / supply;

        // Add the user's pro-rata share of vault idle balances.
        uint256 payout0 = received0 + (IERC20(_token0).balanceOf(_vault) * shares) / supply;
        uint256 payout1 = received1 + (IERC20(_token1).balanceOf(_vault) * shares) / supply;

        uint256 totalAsset;
        if (_assetIsToken0) {
            // swap payout1 (token1) → token0
            totalAsset = payout0 + _quoteSwapOut(payout1, sqrt, feeHun, false);
        } else {
            // swap payout0 (token0) → token1
            totalAsset = _quoteSwapOut(payout0, sqrt, feeHun, true) + payout1;
        }
        return _applySafetyBuffer(totalAsset);
    }

    function redeem(uint256 shares, address receiver, address owner) external override nonReentrant defense returns (uint256) {
        return _redeemInternal(shares, receiver, owner, previewRedeem(shares));
    }

    function redeem(uint256 shares, address receiver, address owner, uint256 minAssetsOut) external nonReentrant defense returns (uint256) {
        return _redeemInternal(shares, receiver, owner, minAssetsOut);
    }

    // ============================================================================
    // Conversions
    // ============================================================================

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return shares;
        uint256 nav = totalAssets();
        if (nav == 0) return shares;
        return (shares * nav) / supply;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return assets;
        uint256 nav = totalAssets();
        if (nav == 0) return assets;
        return (assets * supply) / nav;
    }

    // ============================================================================
    // Internal flow
    // ============================================================================

    function _depositInternal(uint256 assets, address sender, address receiver, uint256 minSharesOut) internal returns (uint256) {
        if (assets == 0) revert WrapperZeroAmount();
        IERC20(_asset).safeTransferFrom(sender, address(this), assets);

        address token0 = _token0;
        address token1 = _token1;
        // Split the input: swap a fraction of `_asset` into the other token according to the
        // position's current value-weights so the deposit lands in roughly the right ratio.
        // Anything left over is returned to the receiver after the deposit.
        {
            (uint256 swapPortion, bool ok) = _computeSwapPortion(assets);
            if (!ok) revert WrapperSwapBelowPrecision();
            if (swapPortion > 0) {
                if (_assetIsToken0) {
                    _swap(token0, token1, swapPortion);
                } else {
                    _swap(token1, token0, swapPortion);
                }
            }
        }

        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));
        IERC20(token0).safeApprove(_vault, 0);
        IERC20(token0).safeApprove(_vault, amount0);
        IERC20(token1).safeApprove(_vault, 0);
        IERC20(token1).safeApprove(_vault, amount1);

        uint256 sharesOut = ICLVault(_vault).deposit(amount0, amount1, minSharesOut, receiver);
        if (sharesOut < minSharesOut) revert WrapperSlippage();

        // Reset approvals so we don't leave standing allowances on this contract.
        IERC20(token0).safeApprove(_vault, 0);
        IERC20(token1).safeApprove(_vault, 0);

        emit Deposit(sender, receiver, assets, sharesOut);
        _sweepToReceiver(token0, token1, receiver);
        return sharesOut;
    }

    function _redeemInternal(uint256 shares, address receiver, address owner, uint256 minAssetsOut) internal returns (uint256) {
        if (shares == 0) revert WrapperZeroAmount();
        IERC20(_vault).safeTransferFrom(owner, address(this), shares);

        address token0 = _token0;
        address token1 = _token1;
        // Pass mins=0 to the vault — the wrapper's final asset-balance check provides slippage
        // protection against the whole flow, and 0-mins keep one-sided positions usable.
        (uint256 amount0, uint256 amount1) = ICLVault(_vault).withdraw(shares, 0, 0);

        // Swap the non-asset side back into asset.
        if (_assetIsToken0 && amount1 > 0) {
            _swap(token1, token0, amount1);
        } else if (!_assetIsToken0 && amount0 > 0) {
            _swap(token0, token1, amount0);
        }

        uint256 assetsOut = IERC20(_asset).balanceOf(address(this));
        if (assetsOut < minAssetsOut) revert WrapperSlippage();

        emit Withdraw(msg.sender, receiver, owner, assetsOut, shares);
        _sweepToReceiver(token0, token1, receiver);
        return assetsOut;
    }

    /// @dev Performs a UL swap with a per-leg slippage guard derived from the pool's spot price
    /// and fee. minOut = spot×(1-poolFee)×(1-maxSwapSlippageBps). Blocks broken/multi-hop UL
    /// routes that would otherwise silently swallow large portions of the input — observed at
    /// 25%+ on sub-dust BTC swaps where UL routing fees dominate.
    ///
    /// To make the slippage guard *enforceable* we also reject swaps where the slippage
    /// allowance would round to zero (i.e. `expectedOut * maxSwapSlippageBps / 10000 == 0`).
    /// Below that precision, any `minOut` value becomes effectively `1` and UL can return a
    /// single wei to satisfy it — exactly the failure mode that ate 25% of small BTC deposits.
    /// Reverting here is the correct behaviour: it tells the user the swap is too small to be
    /// price-protected, rather than silently bleeding their input.
    function _swap(address tokenIn, address tokenOut, uint256 amountIn) internal {
        ICLRebalanceHelper rh = ICLRebalanceHelper(ICLVault(_vault).rebalanceHelper());
        uint160 sqrt = rh.spotSqrtPriceX96(_pool);
        uint24 feeHun = rh.poolFee(_pool);
        bool inIsToken0 = tokenIn == _token0;
        uint256 expectedOut = _quoteSwapOut(amountIn, sqrt, feeHun, inIsToken0);
        if (expectedOut == 0) revert WrapperSwapBelowPrecision();
        uint256 slippageAllowance = (expectedOut * uint256(maxSwapSlippageBps)) / _BPS_DENOMINATOR;
        if (slippageAllowance == 0) revert WrapperSwapBelowPrecision();
        uint256 minOut = expectedOut - slippageAllowance;

        address ul = IController(controller()).universalLiquidator();
        IERC20(tokenIn).safeApprove(ul, 0);
        IERC20(tokenIn).safeApprove(ul, amountIn);
        IUniversalLiquidator(ul).swap(tokenIn, tokenOut, amountIn, minOut, address(this));
        IERC20(tokenIn).safeApprove(ul, 0);
    }

    /// @dev Flushes the wrapper's entire token0 + token1 balance to `to`. Called at the end of
    /// every deposit/redeem so the wrapper never holds funds between transactions.
    function _sweepToReceiver(address token0, address token1, address to) internal {
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        if (b0 > 0) IERC20(token0).safeTransfer(to, b0);
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        if (b1 > 0) IERC20(token1).safeTransfer(to, b1);
    }

    /// @dev Computes how much of an `assets` input must flow through the swap leg, given the
    /// position's current value-weights, plus whether integer truncation of that portion is
    /// within the 1% guard. Shared by previewDeposit (returns 0 on guard failure) and
    /// _depositInternal (reverts on guard failure) so the two can never drift apart.
    ///
    /// Truncation guard rationale: when (assets x wOther) is comparable to 1e18, integer
    /// truncation can lose >1% of the intended swap-portion, leaving the (a0, a1) ratio
    /// mismatched and producing far fewer shares than convertToShares predicts - the second
    /// failure mode behind the BTC vault's 25% silent loss on small deposits.
    function _computeSwapPortion(uint256 assets) internal view returns (uint256 swapPortion, bool ok) {
        (uint256 w0, uint256 w1) = ICLVault(_vault).getCurrentTokenWeights();
        uint256 wOther = _assetIsToken0 ? w1 : w0;
        uint256 intended = assets * wOther;
        swapPortion = intended / 1e18;
        ok = (intended - swapPortion * 1e18) * 100 <= intended;
    }

    /// @dev Quotes a swap of `amountIn` raw units of `inIsToken0 ? token0 : token1` into the
    /// other token at spot × (1 - fee). Two-step `mulDiv` avoids overflow when squaring sqrt.
    /// Used by both preview directions: deposit (asset→other) passes inIsToken0=_assetIsToken0,
    /// redeem (other→asset) passes inIsToken0=!_assetIsToken0. Price impact is not modelled —
    /// `previewSafetyBps` covers that.
    function _quoteSwapOut(uint256 amountIn, uint160 sqrt, uint24 feeHun, bool inIsToken0) internal pure returns (uint256) {
        if (amountIn == 0) return 0;
        uint256 afterFee = (amountIn * (1_000_000 - uint256(feeHun))) / 1_000_000;
        if (inIsToken0) {
            // token0 → token1: out = afterFee * sqrt² / 2^192
            uint256 step0 = Math.mulDiv(afterFee, uint256(sqrt), _Q96);
            return Math.mulDiv(step0, uint256(sqrt), _Q96);
        }
        // token1 → token0: out = afterFee * 2^192 / sqrt²
        uint256 step1 = Math.mulDiv(afterFee, _Q96, uint256(sqrt));
        return Math.mulDiv(step1, _Q96, uint256(sqrt));
    }

    /// @dev Convenience for the deposit direction (asset → other).
    function _quoteSwapOut(uint256 amountIn, uint160 sqrt, uint24 feeHun) internal view returns (uint256) {
        return _quoteSwapOut(amountIn, sqrt, feeHun, _assetIsToken0);
    }

    function _applySafetyBuffer(uint256 amount) internal view returns (uint256) {
        uint256 buffer = uint256(previewSafetyBps);
        return (amount * (_BPS_DENOMINATOR - buffer)) / _BPS_DENOMINATOR;
    }

    /// @dev Token-pair value in `_asset` units at the supplied sqrtPrice. Two-step mulDiv avoids
    /// uint256 overflow when squaring sqrt.
    function _quoteInAsset(uint256 a0, uint256 a1, uint160 sqrt) internal view returns (uint256) {
        if (_assetIsToken0) {
            if (a1 == 0) return a0;
            uint256 stepT0 = Math.mulDiv(a1, _Q96, uint256(sqrt));
            return a0 + Math.mulDiv(stepT0, _Q96, uint256(sqrt));
        }
        if (a0 == 0) return a1;
        uint256 stepT1 = Math.mulDiv(a0, uint256(sqrt), _Q96);
        return Math.mulDiv(stepT1, uint256(sqrt), _Q96) + a1;
    }
}
