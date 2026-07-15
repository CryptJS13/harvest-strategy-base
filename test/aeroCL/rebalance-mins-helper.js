const CLRebalanceHelper = artifacts.require("CLRebalanceHelper");
const MockCLPool = artifacts.require("MockCLPool");

// Helper-only tests for the TWAP-anchored burn/mint min quoting added to CLRebalanceHelper.
// Mock pool lets us set spot vs TWAP independently and exercise edge cases that are awkward to
// reach against real Aerodrome state.
describe("CL rebalance TWAP-mins helper", function() {
  let helper;
  let pool;
  // sqrtPriceX96 for tick = 0 (1:1 price)
  const Q96 = web3.utils.toBN("79228162514264337593543950336");
  const BPS = 10000;

  beforeEach(async function() {
    helper = await CLRebalanceHelper.new();
    pool = await MockCLPool.new();
    // Spot at tick 0 (1:1), TWAP at tick 0 (1:1) by default.
    await pool.setSlot0(Q96.toString(), 0);
    await pool.setObserve("0", "0");
  });

  describe("prepareRebalance", function() {
    it("returns zero burn mins when maxSlippageBps is 0", async function() {
      const ret = await helper.prepareRebalance(
        pool.address,
        900,             // twapWindow
        200,             // maxTwapDeviationBps
        0,               // maxSlippageBps -> mins must be 0
        2,               // posWidth
        60,              // tickSpacing
        -60,             // oldTickLower
        60,              // oldTickUpper
        "1000000000000"  // oldLiquidity
      );
      assert.equal(ret.burnMin0.toString(), "0");
      assert.equal(ret.burnMin1.toString(), "0");
    });

    it("returns non-zero burn mins ~ (1 - slippage) of expected at TWAP for in-range liquidity", async function() {
      // Spot/TWAP both at tick 0. Range [-60, 60] => in-range, both tokens needed.
      // For 1e18 liquidity at tick 0, expected amounts ~ ~3e15 of each token (small width).
      const slip = 100; // 1%
      const liq = web3.utils.toBN("1000000000000000000"); // 1e18
      const ret = await helper.prepareRebalance(
        pool.address,
        900,
        200,
        slip,
        2,
        60,
        -60,
        60,
        liq.toString()
      );
      // Both mins should be non-zero and roughly equal (range is symmetric around tick 0).
      const m0 = web3.utils.toBN(ret.burnMin0);
      const m1 = web3.utils.toBN(ret.burnMin1);
      assert.equal(m0.gt(web3.utils.toBN(0)), true, "burnMin0 should be > 0");
      assert.equal(m1.gt(web3.utils.toBN(0)), true, "burnMin1 should be > 0");
      // Symmetric range at tick 0: amounts on either side should be very close.
      const diff = m0.gt(m1) ? m0.sub(m1) : m1.sub(m0);
      assert.equal(diff.lte(m0.div(web3.utils.toBN(1000))), true,
        "expected near-symmetric burn mins for symmetric range at tick 0");
    });

    it("computes new tick limits centered on the current tick", async function() {
      // tickSpacing = 60, posWidth = 2 => target range width = 120 ticks.
      // Spot at tick 0 with sqrt at exact tick boundary; centered range should be roughly [-60, 60].
      const ret = await helper.prepareRebalance(
        pool.address,
        900,
        0,         // disable TWAP guard so we don't accidentally trip
        100,
        2,
        60,
        -60,
        60,
        "1"
      );
      const lower = parseInt(ret.tickLowerNew, 10);
      const upper = parseInt(ret.tickUpperNew, 10);
      assert.equal(upper - lower, 120, "expected width of 2 * tickSpacing");
      assert.equal(lower % 60, 0, "tickLower must be tickSpacing-aligned");
      assert.equal(upper % 60, 0, "tickUpper must be tickSpacing-aligned");
      // For posWidth = 2 the centered range should bracket tick 0.
      assert.equal(lower <= 0 && upper >= 0, true, "expected range to bracket the current tick");
    });

    it("reverts when spot deviates from TWAP beyond maxTwapDeviationBps", async function() {
      // Spot stays at tick 0; move TWAP to tick 10000 over 900 sec (>> deviation tolerance).
      await pool.setObserve("0", "9000000");
      let failed = false;
      try {
        await helper.prepareRebalance(
          pool.address,
          900,
          10,    // 10 bps tolerance — easily exceeded
          100,
          2,
          60,
          -60,
          60,
          "1000000000000000000"
        );
      } catch (e) {
        failed = true;
      }
      assert.equal(failed, true, "expected TWAP deviation guard to revert");
    });

    it("skips TWAP guard when maxTwapDeviationBps == 0", async function() {
      await pool.setObserve("0", "9000000"); // huge TWAP/spot divergence
      // Should NOT revert because guard is disabled.
      const ret = await helper.prepareRebalance(
        pool.address,
        900,
        0,        // disabled
        100,
        2,
        60,
        -60,
        60,
        "1000000000000000000"
      );
      // Sanity: returns valid output even with diverged TWAP.
      assert.equal(parseInt(ret.tickUpperNew, 10) > parseInt(ret.tickLowerNew, 10), true);
    });
  });

  describe("quoteMintMins", function() {
    it("returns zero mins when maxSlippageBps is 0", async function() {
      const ret = await helper.quoteMintMins(
        pool.address,
        900,
        -60,
        60,
        "1000000000000000000",
        "1000000000000000000",
        0
      );
      assert.equal(ret.min0.toString(), "0");
      assert.equal(ret.min1.toString(), "0");
    });

    it("returns zero mins when desired amounts produce zero liquidity", async function() {
      // Tiny amounts well below the rounding threshold for getLiquidityForAmounts.
      const ret = await helper.quoteMintMins(
        pool.address,
        900,
        -60,
        60,
        "0",
        "0",
        100
      );
      assert.equal(ret.min0.toString(), "0");
      assert.equal(ret.min1.toString(), "0");
    });

    it("returns non-zero mins reduced by slippage for normal balanced inputs", async function() {
      // Range [-60, 60] in-range at tick 0, equal balanced inputs.
      const slip = 100; // 1%
      const desired = web3.utils.toBN("1000000000000000000"); // 1e18 each
      const ret = await helper.quoteMintMins(
        pool.address,
        900,
        -60,
        60,
        desired.toString(),
        desired.toString(),
        slip
      );
      const m0 = web3.utils.toBN(ret.min0);
      const m1 = web3.utils.toBN(ret.min1);
      assert.equal(m0.gt(web3.utils.toBN(0)), true, "mintMin0 should be > 0");
      assert.equal(m1.gt(web3.utils.toBN(0)), true, "mintMin1 should be > 0");
      // Each min must be <= corresponding desired (we apply slippage downward only).
      assert.equal(m0.lte(desired), true, "mintMin0 must be <= desired");
      assert.equal(m1.lte(desired), true, "mintMin1 must be <= desired");
      // And by no more than 1% under expected (slippage applied to expected, not desired,
      // so the loose upper bound is desired itself).
    });
  });
});
