// Unit test for AaveReserveLib bit-decoding.
//
// On the live Base fork the only flag-flip we cannot reproduce through the
// PoolConfigurator (the test admin holds POOL_ADMIN but not RISK_ADMIN, and
// setReserveFreeze requires the latter). This unit test fills that gap by
// driving the library directly against a tiny mock pool, asserting the flag
// returned for every relevant configuration.

const BigNumber = require("bignumber.js");

const MockAavePool = artifacts.require("MockAavePool");
const MockToken = artifacts.require("MockToken");
const AaveReserveLib = artifacts.require("AaveReserveLib");
const AaveReserveLibTester = artifacts.require("AaveReserveLibTester");

const MAX_UINT = new BigNumber(2).pow(256).minus(1);

// The library is invoked through a tester wrapper because the truffle JS ABI
// encoder cannot consume the library's IPool parameter type directly.
describe("AaveReserveLib bit decoder", function() {
  const ASSET = "0x0000000000000000000000000000000000000A55";
  const TOKEN = "0x0000000000000000000000000000000000000B07";

  let pool;
  let lib;
  let tester;

  // Builds a ReserveConfigurationMap.data uint256 with the flags we care about.
  // active/frozen/borrowingEnabled/paused are bools; supplyCap/borrowCap are
  // whole units of underlying; decimals defaults to 18.
  function makeConfig({
    active = true, frozen = false, borrowingEnabled = true, paused = false,
    supplyCap = 0n, borrowCap = 0n, decimals = 18n,
  } = {}) {
    let d = 0n;
    d |= (decimals & 0xFFn) << 48n;
    if (active)           d |= 1n << 56n;
    if (frozen)           d |= 1n << 57n;
    if (borrowingEnabled) d |= 1n << 58n;
    if (paused)           d |= 1n << 60n;
    d |= (borrowCap & ((1n << 36n) - 1n)) << 80n;
    d |= (supplyCap & ((1n << 36n) - 1n)) << 116n;
    return d;
  }

  before(async function() {
    pool = await MockAavePool.new();
    lib = await AaveReserveLib.new();
    AaveReserveLibTester.link(lib);
    tester = await AaveReserveLibTester.new();
  });

  async function setAndGet(cfgBits, side /* "borrow" | "supply" */) {
    await pool.setConfig(ASSET, cfgBits.toString());
    if (side === "borrow") {
      return new BigNumber(await tester.borrowFlags(pool.address, ASSET, TOKEN));
    } else {
      return new BigNumber(await tester.supplyFlags(pool.address, ASSET, TOKEN));
    }
  }

  describe("borrow side", function() {

    it("returns 1|4 for an active, unfrozen, borrowing-enabled, unpaused, uncapped reserve", async function() {
      const flags = await setAndGet(makeConfig(), "borrow");
      assert.equal(flags.toNumber() & 1, 1, "borrow bit");
      assert.equal(flags.toNumber() & 4, 4, "repay bit");
    });

    it("clears the borrow bit when frozen, keeps the repay bit", async function() {
      const flags = await setAndGet(makeConfig({ frozen: true }), "borrow");
      assert.equal(flags.toNumber() & 1, 0, "borrow bit");
      assert.equal(flags.toNumber() & 4, 4, "repay bit");
    });

    it("clears both bits when paused", async function() {
      const flags = await setAndGet(makeConfig({ paused: true }), "borrow");
      assert.equal(flags.toNumber() & 1, 0, "borrow bit");
      assert.equal(flags.toNumber() & 4, 0, "repay bit");
    });

    it("clears both bits when inactive", async function() {
      const flags = await setAndGet(makeConfig({ active: false }), "borrow");
      assert.equal(flags.toNumber() & 1, 0, "borrow bit");
      assert.equal(flags.toNumber() & 4, 0, "repay bit");
    });

    it("clears the borrow bit when borrowing is disabled", async function() {
      const flags = await setAndGet(makeConfig({ borrowingEnabled: false }), "borrow");
      assert.equal(flags.toNumber() & 1, 0, "borrow bit");
      assert.equal(flags.toNumber() & 4, 4, "repay bit");
    });

    // Cap exhaustion is exercised end-to-end against the live Aave pool in
    // the integration test (`borrow cap exhausted: behaves like
    // borrowing-disabled`). A unit test for it would need a real ERC20 mock
    // for the debt token to report a totalSupply that overflows the cap.
  });

  describe("supply side", function() {

    it("returns 2|4 for an active, unfrozen, unpaused, uncapped reserve", async function() {
      const flags = await setAndGet(makeConfig(), "supply");
      assert.equal(flags.toNumber() & 2, 2, "supply bit");
      assert.equal(flags.toNumber() & 4, 4, "withdraw bit");
    });

    it("clears the supply bit when frozen, keeps the withdraw bit", async function() {
      const flags = await setAndGet(makeConfig({ frozen: true }), "supply");
      assert.equal(flags.toNumber() & 2, 0, "supply bit");
      assert.equal(flags.toNumber() & 4, 4, "withdraw bit");
    });

    it("clears both bits when paused", async function() {
      const flags = await setAndGet(makeConfig({ paused: true }), "supply");
      assert.equal(flags.toNumber() & 2, 0, "supply bit");
      assert.equal(flags.toNumber() & 4, 0, "withdraw bit");
    });

    it("clears both bits when inactive", async function() {
      const flags = await setAndGet(makeConfig({ active: false }), "supply");
      assert.equal(flags.toNumber() & 2, 0, "supply bit");
      assert.equal(flags.toNumber() & 4, 0, "withdraw bit");
    });

    it("supply cap of 0 means uncapped", async function() {
      const flags = await setAndGet(makeConfig({ supplyCap: 0n }), "supply");
      assert.equal(flags.toNumber() & 2, 2, "supply bit");
    });
  });

  // ---------------------------------------------------------------------------
  // Cap-headroom maths (S3): how much extra borrow / supply a reserve can still
  // absorb, and the lever-up clamp derived from it.
  // ---------------------------------------------------------------------------
  describe("cap headroom", function() {
    const e18 = (n) => new BigNumber(n).times("1e18");

    it("borrow headroom = cap*unit - debt totalSupply", async function() {
      await pool.setConfig(ASSET, makeConfig({ borrowCap: 100n, decimals: 18n }).toString());
      const debt = await MockToken.new();
      await debt.setTotalSupply(e18(60).toFixed());
      const hr = new BigNumber(await tester.borrowCapHeadroom(pool.address, ASSET, debt.address));
      assert.equal(hr.toFixed(), e18(40).toFixed());
    });

    it("supply headroom = cap*unit - aToken totalSupply", async function() {
      await pool.setConfig(ASSET, makeConfig({ supplyCap: 9000n, decimals: 18n }).toString());
      const aToken = await MockToken.new();
      await aToken.setTotalSupply(e18(3718).toFixed());
      const hr = new BigNumber(await tester.supplyCapHeadroom(pool.address, ASSET, aToken.address));
      assert.equal(hr.toFixed(), e18(5282).toFixed());
    });

    it("uncapped reserve (cap 0) reports max headroom", async function() {
      await pool.setConfig(ASSET, makeConfig({ borrowCap: 0n, supplyCap: 0n }).toString());
      const t = await MockToken.new();
      await t.setTotalSupply(e18(1).toFixed());
      assert.equal(new BigNumber(await tester.borrowCapHeadroom(pool.address, ASSET, t.address)).toFixed(), MAX_UINT.toFixed());
      assert.equal(new BigNumber(await tester.supplyCapHeadroom(pool.address, ASSET, t.address)).toFixed(), MAX_UINT.toFixed());
    });

    it("headroom clamps to 0 when supply is at/over cap (never underflows)", async function() {
      await pool.setConfig(ASSET, makeConfig({ borrowCap: 100n, decimals: 18n }).toString());
      const debt = await MockToken.new();
      await debt.setTotalSupply(e18(140).toFixed()); // already over the cap
      const hr = new BigNumber(await tester.borrowCapHeadroom(pool.address, ASSET, debt.address));
      assert.equal(hr.toFixed(), "0");
    });

    it("clamp is a no-op when both reserves are far from cap", async function() {
      const bAsset = "0x0000000000000000000000000000000000000B01";
      const sAsset = "0x0000000000000000000000000000000000000501";
      await pool.setConfig(bAsset, makeConfig({ borrowCap: 143000n, decimals: 18n }).toString());
      await pool.setConfig(sAsset, makeConfig({ supplyCap: 9000n, decimals: 18n }).toString());
      const debt = await MockToken.new(); await debt.setTotalSupply(e18(91000).toFixed());
      const aTok = await MockToken.new(); await aTok.setTotalSupply(e18(3700).toFixed());
      const desired = e18(10); // tiny vs ~51k / ~5.3k headroom
      const out = new BigNumber(await tester.capClampedDebtIncrease(
        pool.address, bAsset, debt.address, sAsset, aTok.address, desired.toFixed(), e18(1).toFixed(), "100"));
      assert.equal(out.toFixed(), desired.toFixed(), "should not clamp far from cap");
    });

    it("clamp binds on the borrow cap (minus buffer) when desired exceeds it", async function() {
      const bAsset = "0x0000000000000000000000000000000000000B02";
      const sAsset = "0x0000000000000000000000000000000000000502";
      await pool.setConfig(bAsset, makeConfig({ borrowCap: 100n, decimals: 18n }).toString());
      await pool.setConfig(sAsset, makeConfig({ supplyCap: 0n }).toString()); // supply uncapped
      const debt = await MockToken.new(); await debt.setTotalSupply(e18(60).toFixed()); // 40 headroom
      const aTok = await MockToken.new();
      const out = new BigNumber(await tester.capClampedDebtIncrease(
        pool.address, bAsset, debt.address, sAsset, aTok.address, e18(50).toFixed(), e18(1).toFixed(), "100"));
      // 40 headroom, 1% buffer -> 39.6
      assert.equal(out.toFixed(), e18("39.6").toFixed());
    });

    it("clamp binds on the supply cap (converted to debt units via price)", async function() {
      const bAsset = "0x0000000000000000000000000000000000000B03";
      const sAsset = "0x0000000000000000000000000000000000000503";
      await pool.setConfig(bAsset, makeConfig({ borrowCap: 0n }).toString()); // borrow uncapped
      await pool.setConfig(sAsset, makeConfig({ supplyCap: 30n, decimals: 18n }).toString());
      const debt = await MockToken.new();
      const aTok = await MockToken.new(); await aTok.setTotalSupply(e18(10).toFixed()); // 20 collateral headroom
      // price 1.05 debt-per-collateral; 20 * 0.99 * 1.05 = 20.79
      const out = new BigNumber(await tester.capClampedDebtIncrease(
        pool.address, bAsset, debt.address, sAsset, aTok.address, e18(50).toFixed(), new BigNumber("1.05e18").toFixed(), "100"));
      assert.equal(out.toFixed(), new BigNumber("20.79e18").toFixed());
    });
  });
});
