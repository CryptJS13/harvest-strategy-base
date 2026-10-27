// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "./inheritance/Controllable.sol";
import "./interface/IController.sol";
import "./interface/IChainlinkAggregator.sol";
import "./interface/IUniversalLiquidator.sol";

/**
 * @title RewardForwarderV2
 * @dev Receives fees from strategies and pays them out in bounded, priced steps.
 *
 * Stage 1 (settle): each listed fee token is sold into `hub` (WETH), at most `swapLimits[token][hub].maxIn`
 * per call and never below a floor. The platform-fee part goes to the protocol fee receiver. The profit-share
 * part stays here as `pendingProfitShare[hub]`.
 *
 * Stage 2 (buy): that WETH buys the profit-share token (iFARM), again in capped chunks above a floor. The
 * unattended `distributeAllFees` buys one chunk per call at the stored floor. `buyProfitShare` lets a
 * hardWorker pass its own, tighter minimum.
 *
 * A swap's floor is governance's: the higher of `minRate` and a Chainlink value less `oracleToleranceBps`
 * (used when both tokens have a feed; a stale feed blocks the swap). A hardWorker's `keeperRate` can raise
 * that floor but never create one. A pair with no cap or no governance floor is never swapped, so a fee
 * waits instead of being sold blind. Every swap checks what the receiver actually got. A failed swap
 * leaves the fee pending.
 *
 * Only governance-listed tokens are iterated, so a junk token sent through `notifyFee` is booked but costs
 * the scheduled run nothing. The hub is always settled and need not be listed.
 */
contract RewardForwarderV2 is Controllable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct SwapLimit {
        uint128 maxIn;   // most tokenIn sold per swap; 0 = never swap the pair
        uint128 minRate; // tokenOut wei per 1e18 tokenIn wei; governance's hard floor
    }

    struct PriceFeed {
        address feed;
        uint32 maxAge;
        uint8 feedDecimals;
        uint8 tokenDecimals;
    }

    /// @notice WETH: what every fee token is sold into, and what the platform fee is paid in
    address public immutable hub;
    /// @notice the token the profit share is bought as (iFARM); may be `hub`, then it is paid directly
    address public profitShareToken;
    uint256 public oracleToleranceBps;
    uint256 public minBuyInterval;
    uint256 public lastBuyTime;

    address[] public rewardTokens;
    mapping(address => uint256) private idxPlusOne;
    mapping(address => uint256) public pendingProfitShare;
    mapping(address => uint256) public pendingPlatformFee;
    mapping(address => mapping(address => SwapLimit)) public swapLimits;
    mapping(address => mapping(address => uint128)) public keeperRate;
    mapping(address => PriceFeed) public priceFeeds;

    event FeeNotified(address indexed token, address indexed from, uint256 profitSharingFee, uint256 platformFee);
    event FeeSwapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 minOut);
    event ProfitShareBought(address indexed token, uint256 hubIn, uint256 amountOut, uint256 minOut);
    event SwapFailed(address indexed tokenIn, address indexed tokenOut, uint256 amount);
    event SwapSkipped(address indexed tokenIn, address indexed tokenOut, uint256 amount);
    event RewardTokenAdded(address indexed token);
    event RewardTokenRemoved(address indexed token);
    event SwapLimitSet(address indexed tokenIn, address indexed tokenOut, uint256 maxIn, uint256 minRate);
    event KeeperRateSet(address indexed tokenIn, address indexed tokenOut, uint256 rate);
    event PriceFeedSet(address indexed token, address feed, uint256 maxAge);
    event OracleToleranceSet(uint256 bps);
    event MinBuyIntervalSet(uint256 interval);
    event ProfitShareTokenSet(address indexed token);
    event FeesMigrated(address indexed token, address indexed to, uint256 profitSharingFee, uint256 platformFee, uint256 balance);

    error OnlySelf();
    error ShortReceipt(uint256 received, uint256 minOut);
    error ExceedsCap(uint256 amount, uint256 cap);
    error ExceedsPending(uint256 amount, uint256 pending);
    error BelowFloor(uint256 minOut, uint256 floor);
    error TooSoon(uint256 nextBuyTime);
    error NothingToBuy();
    error Unbacked(uint256 balance, uint256 booked);
    error BadFeed(address feed);

    modifier onlyHardWorkerOrGovernance() {
        require(
            IController(controller()).hardWorkers(msg.sender) || (msg.sender == governance()),
            "only hard worker can call this"
        );
        _;
    }

    /**
     * @param _storage Address of the storage contract.
     * @param _hub The controller's target token (WETH).
     * @param _profitShareToken The token the profit share is bought as (iFARM).
     */
    constructor(address _storage, address _hub, address _profitShareToken) Controllable(_storage) {
        require(_hub == IController(controller()).targetToken(), "hub must be the target token");
        require(_profitShareToken != address(0), "token=0");
        hub = _hub;
        profitShareToken = _profitShareToken;
    }

    /**
     * @notice Books fees sent by a strategy. Pulls `_profitSharingFee + _platformFee` and swaps nothing.
     * The strategist fee is not collected, as in V1.
     */
    function notifyFee(
        address _token,
        uint256 _profitSharingFee,
        uint256,
        uint256 _platformFee
    ) external nonReentrant {
        require(_token != address(0), "token=0");
        uint256 total = _profitSharingFee + _platformFee;
        if (total == 0) return;

        uint256 balanceBefore = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransferFrom(msg.sender, address(this), total);
        // book what arrived, split pro rata, so a fee-on-transfer token cannot leave the books unbacked
        uint256 received = IERC20(_token).balanceOf(address(this)) - balanceBefore;
        uint256 platform = received == total ? _platformFee : _platformFee * received / total;
        pendingPlatformFee[_token] += platform;
        pendingProfitShare[_token] += received - platform;
        emit FeeNotified(_token, msg.sender, received - platform, platform);
    }

    /// @notice Books tokens already held here, e.g. after a migration. Reverts if the books would exceed the balance.
    function notifyFeeAdmin(address _token, uint256 _profitSharingFee, uint256 _platformFee) external onlyGovernance {
        require(_token != address(0), "token=0");
        pendingProfitShare[_token] += _profitSharingFee;
        pendingPlatformFee[_token] += _platformFee;
        uint256 booked = pendingProfitShare[_token] + pendingPlatformFee[_token];
        uint256 balance = IERC20(_token).balanceOf(address(this));
        if (balance < booked) revert Unbacked(balance, booked);
        emit FeeNotified(_token, msg.sender, _profitSharingFee, _platformFee);
    }

    /// @notice Settles one token (stage 1), whether or not it is listed.
    function distributeFee(address _token) external onlyHardWorkerOrGovernance nonReentrant {
        _settle(_token);
    }

    /**
     * @notice The scheduled entry point: settles every listed token (stage 1), then buys at most one chunk of
     * the profit-share token at the stored floor (stage 2). Never reverts on a failed swap.
     */
    function distributeAllFees() external onlyHardWorkerOrGovernance nonReentrant {
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            if (rewardTokens[i] != hub) _settle(rewardTokens[i]);
        }
        // the hub goes last, so what stage 1 just added is paid out in the same call
        _settle(hub);

        address pst = profitShareToken;
        if (pst == hub || block.timestamp < lastBuyTime + minBuyInterval) return;
        uint256 hubIn = Math.min(pendingProfitShare[hub], swapLimits[hub][pst].maxIn);
        if (hubIn == 0) return;
        uint256 minOut = _floor(hub, pst, hubIn);
        if (minOut == 0) {
            emit SwapSkipped(hub, pst, hubIn);
            return;
        }
        address receiver = IController(controller()).profitSharingReceiver();
        try this.swapChecked(hub, pst, hubIn, minOut, receiver) returns (uint256 out) {
            pendingProfitShare[hub] -= hubIn;
            lastBuyTime = block.timestamp;
            emit ProfitShareBought(pst, hubIn, out, minOut);
        } catch {
            emit SwapFailed(hub, pst, hubIn);
        }
    }

    /**
     * @notice Keeper path for stage 2: buys exactly `_hubIn` of WETH worth of the profit-share token, requiring
     * at least `_minOut`, which may not be below the stored floor. Reverts instead of skipping, so a keeper
     * can simulate it.
     */
    function buyProfitShare(uint256 _hubIn, uint256 _minOut)
        external
        onlyHardWorkerOrGovernance
        nonReentrant
        returns (uint256 out)
    {
        address pst = profitShareToken;
        if (pst == hub) revert NothingToBuy();
        if (block.timestamp < lastBuyTime + minBuyInterval) revert TooSoon(lastBuyTime + minBuyInterval);
        uint256 cap = swapLimits[hub][pst].maxIn;
        if (_hubIn == 0 || _hubIn > cap) revert ExceedsCap(_hubIn, cap);
        if (_hubIn > pendingProfitShare[hub]) revert ExceedsPending(_hubIn, pendingProfitShare[hub]);
        uint256 floor = _floor(hub, pst, _hubIn);
        if (floor == 0 || _minOut < floor) revert BelowFloor(_minOut, floor);

        out = this.swapChecked(hub, pst, _hubIn, _minOut, IController(controller()).profitSharingReceiver());
        pendingProfitShare[hub] -= _hubIn;
        lastBuyTime = block.timestamp;
        emit ProfitShareBought(pst, _hubIn, out, _minOut);
    }

    /**
     * @dev Swaps through the universal liquidator and reverts unless `_receiver` gained at least `_minOut`.
     * External so the callers can wrap it in try/catch: a short receipt then undoes the whole swap.
     */
    function swapChecked(
        address _tokenIn,
        address _tokenOut,
        uint256 _amountIn,
        uint256 _minOut,
        address _receiver
    ) external returns (uint256 received) {
        if (msg.sender != address(this)) revert OnlySelf();
        address liquidator = IController(controller()).universalLiquidator();
        uint256 balanceBefore = IERC20(_tokenOut).balanceOf(_receiver);
        IERC20(_tokenIn).forceApprove(liquidator, _amountIn);
        IUniversalLiquidator(liquidator).swap(_tokenIn, _tokenOut, _amountIn, _minOut, _receiver);
        IERC20(_tokenIn).forceApprove(liquidator, 0);
        received = IERC20(_tokenOut).balanceOf(_receiver) - balanceBefore;
        if (received < _minOut) revert ShortReceipt(received, _minOut);
    }

    /// @notice The minimum `_tokenOut` a swap of `_amountIn` must return now; 0 means it must not be swapped.
    function floorFor(address _tokenIn, address _tokenOut, uint256 _amountIn) external view returns (uint256) {
        return _floor(_tokenIn, _tokenOut, _amountIn);
    }

    function rewardTokensLength() external view returns (uint256) {
        return rewardTokens.length;
    }

    // ---------------------------------------------------------------- configuration

    function addRewardToken(address _token) external onlyGovernance {
        require(_token != address(0), "token=0");
        _addRewardToken(_token);
    }

    /// @notice Stops iterating a token. Its books and balance stay; `distributeFee` can still settle it.
    function removeRewardToken(address _token) external onlyGovernance {
        uint256 idx = idxPlusOne[_token];
        if (idx == 0) return;
        uint256 last = rewardTokens.length - 1;
        if (idx - 1 != last) {
            address moved = rewardTokens[last];
            rewardTokens[idx - 1] = moved;
            idxPlusOne[moved] = idx;
        }
        rewardTokens.pop();
        idxPlusOne[_token] = 0;
        emit RewardTokenRemoved(_token);
    }

    function setSwapLimit(address _tokenIn, address _tokenOut, uint128 _maxIn, uint128 _minRate)
        external
        onlyGovernance
    {
        swapLimits[_tokenIn][_tokenOut] = SwapLimit(_maxIn, _minRate);
        emit SwapLimitSet(_tokenIn, _tokenOut, _maxIn, _minRate);
    }

    /// @notice A floor a hardWorker may set from a fresh quote. It only binds when above governance's floor,
    /// and has no effect on a pair whose governance floor is 0.
    function setKeeperRate(address _tokenIn, address _tokenOut, uint128 _rate) external onlyHardWorkerOrGovernance {
        keeperRate[_tokenIn][_tokenOut] = _rate;
        emit KeeperRateSet(_tokenIn, _tokenOut, _rate);
    }

    /// @notice Sets (or with `_feed == 0` clears) a token's USD feed. The feed must answer now.
    function setPriceFeed(address _token, address _feed, uint32 _maxAge) external onlyGovernance {
        if (_feed == address(0)) {
            delete priceFeeds[_token];
        } else {
            uint8 feedDecimals = IChainlinkAggregator(_feed).decimals();
            uint8 tokenDecimals = IERC20Metadata(_token).decimals();
            if (feedDecimals > 18 || tokenDecimals > 36) revert BadFeed(_feed);
            priceFeeds[_token] = PriceFeed(_feed, _maxAge, feedDecimals, tokenDecimals);
            (bool ok,) = _price(_token);
            if (!ok) revert BadFeed(_feed);
        }
        emit PriceFeedSet(_token, _feed, _maxAge);
    }

    function setOracleTolerance(uint256 _bps) external onlyGovernance {
        require(_bps < 10000, "bps");
        oracleToleranceBps = _bps;
        emit OracleToleranceSet(_bps);
    }

    function setMinBuyInterval(uint256 _interval) external onlyGovernance {
        minBuyInterval = _interval;
        emit MinBuyIntervalSet(_interval);
    }

    /// @notice The WETH buffer is unaffected, so switching (e.g. to FARM, or to WETH itself) needs no migration.
    function setProfitShareToken(address _token) external onlyGovernance {
        require(_token != address(0), "token=0");
        profitShareToken = _token;
        emit ProfitShareTokenSet(_token);
    }

    /**
     * @notice Hands a token to a successor forwarder: clears its books and moves the whole balance. The event
     * carries the split so the successor can book it with `notifyFeeAdmin`.
     */
    function migrateFees(address _token, address _to) external onlyGovernance nonReentrant {
        require(_to != address(0), "to=0");
        uint256 profitSharingFee = pendingProfitShare[_token];
        uint256 platformFee = pendingPlatformFee[_token];
        pendingProfitShare[_token] = 0;
        pendingPlatformFee[_token] = 0;
        uint256 balance = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransfer(_to, balance);
        emit FeesMigrated(_token, _to, profitSharingFee, platformFee, balance);
    }

    // ---------------------------------------------------------------- internals

    function _addRewardToken(address _token) internal {
        if (idxPlusOne[_token] != 0) return;
        rewardTokens.push(_token);
        idxPlusOne[_token] = rewardTokens.length;
        emit RewardTokenAdded(_token);
    }

    /// @dev Stage 1 for one token: pays what needs no swap, then sells at most one capped chunk into the hub.
    function _settle(address _token) internal {
        address _controller = controller();
        uint256 profitShare = pendingProfitShare[_token];
        uint256 platformFee = pendingPlatformFee[_token];

        if (_token == hub) {
            if (platformFee > 0) {
                pendingPlatformFee[_token] = 0;
                IERC20(_token).safeTransfer(IController(_controller).protocolFeeReceiver(), platformFee);
            }
            if (profitShareToken == hub && profitShare > 0) {
                pendingProfitShare[_token] = 0;
                IERC20(_token).safeTransfer(IController(_controller).profitSharingReceiver(), profitShare);
            }
            return;
        }
        if (_token == profitShareToken && profitShare > 0) {
            pendingProfitShare[_token] = 0;
            IERC20(_token).safeTransfer(IController(_controller).profitSharingReceiver(), profitShare);
            profitShare = 0;
        }

        uint256 total = profitShare + platformFee;
        uint256 amountIn = Math.min(total, swapLimits[_token][hub].maxIn);
        if (amountIn == 0) return;
        uint256 minOut = _floor(_token, hub, amountIn);
        if (minOut == 0) {
            emit SwapSkipped(_token, hub, amountIn);
            return;
        }

        // a partial chunk takes platform fee and profit share pro rata; platformIn <= platformFee and
        // amountIn - platformIn <= profitShare (it is the ceiling of profitShare * amountIn / total)
        uint256 platformIn = platformFee * amountIn / total;
        try this.swapChecked(_token, hub, amountIn, minOut, address(this)) returns (uint256 out) {
            uint256 platformOut = out * platformIn / amountIn;
            pendingPlatformFee[_token] = platformFee - platformIn;
            pendingProfitShare[_token] = profitShare - (amountIn - platformIn);
            pendingProfitShare[hub] += out - platformOut;
            if (platformOut > 0) {
                IERC20(hub).safeTransfer(IController(_controller).protocolFeeReceiver(), platformOut);
            }
            emit FeeSwapped(_token, hub, amountIn, out, minOut);
        } catch {
            emit SwapFailed(_token, hub, amountIn);
        }
    }

    /// @dev Governance's floor is the higher of minRate and the oracle value less tolerance; the keeper rate
    /// can only raise it. Returns 0 (do not swap) when governance's floor is 0, so a keeper rate never
    /// unlocks a pair governance left unpriced, or when both tokens have feeds and either is unusable.
    function _floor(address _tokenIn, address _tokenOut, uint256 _amountIn) internal view returns (uint256 floor) {
        // _amountIn is capped by a uint128 maxIn and both rates are uint128, so neither product overflows
        floor = _amountIn * swapLimits[_tokenIn][_tokenOut].minRate / 1e18;

        PriceFeed memory feedIn = priceFeeds[_tokenIn];
        PriceFeed memory feedOut = priceFeeds[_tokenOut];
        if (feedIn.feed != address(0) && feedOut.feed != address(0)) {
            (bool okIn, uint256 priceIn) = _price(_tokenIn);
            (bool okOut, uint256 priceOut) = _price(_tokenOut);
            if (!okIn || !okOut) return 0;
            uint256 value = Math.mulDiv(
                _amountIn,
                priceIn * 10 ** feedOut.tokenDecimals,
                priceOut * 10 ** feedIn.tokenDecimals
            );
            floor = Math.max(floor, value * (10000 - oracleToleranceBps) / 10000);
        }
        if (floor == 0) return 0;
        floor = Math.max(floor, _amountIn * keeperRate[_tokenIn][_tokenOut] / 1e18);
    }

    /// @dev The feed's USD price scaled to 18 decimals; false when the call fails, the answer is not
    /// positive, or it is older than maxAge.
    function _price(address _token) internal view returns (bool ok, uint256 price) {
        PriceFeed memory f = priceFeeds[_token];
        try IChainlinkAggregator(f.feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || updatedAt + f.maxAge < block.timestamp) return (false, 0);
            return (true, uint256(answer) * 10 ** (18 - f.feedDecimals));
        } catch {
            return (false, 0);
        }
    }
}
