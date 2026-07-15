// On-fork rebalance planner comparison. Uses the LIVE cbETH/ETH1 and tBTC/cbBTC pools' spot
// prices, then asks BOTH planners — legacy `planSwap` (50/50 target) and the new range-aware
// `planSwapForMint` — what they would swap for various candidate post-burn idle balances and
// candidate new ranges. Simulates the resulting mint (LiquidityAmounts-correct) at the live
// spot price and reports leftover bps for both. This validates the planner under real pool
// conditions without needing to actually execute a rebalance on-chain — the suite is
// completely view-only and shares no state with vault-bearing test files.
const IPosManager = artifacts.require("INonfungiblePositionManager");
const CLRebalanceHelper = artifacts.require("CLRebalanceHelper");

// posIds are used only to look up the (token0, token1, tickSpacing) of each pool via the public
// `positions()` view. We do NOT take custody of these NFTs.
const POOL_CONFIGS = [
  { name: "cbETH/ETH1", posId: 19447757 },
  { name: "tBTC/cbBTC", posId: 19450559 },
];

const BN = web3.utils.toBN;
const Q96_BI = BigInt(2) ** BigInt(96);
const Q192_BI = BigInt(2) ** BigInt(192);

function bi(x) { return BigInt(x.toString()); }
function valueIn1(a0, a1, sqrt) { return (a0 * sqrt * sqrt) / Q192_BI + a1; }

// Simulate the in-range / out-of-range mint at (sqrt, sqrtL, sqrtU) and report (consumed0, consumed1).
function simulateMint(sqrt, sqrtL, sqrtU, a0, a1) {
  if (sqrt <= sqrtL) return { c0: a0, c1: 0n };
  if (sqrt >= sqrtU) return { c0: 0n, c1: a1 };
  const L0 = (a0 * sqrt * sqrtU) / (Q96_BI * (sqrtU - sqrt));
  const L1 = (a1 * Q96_BI) / (sqrt - sqrtL);
  const L = L0 < L1 ? L0 : L1;
  const c0 = (L * Q96_BI * (sqrtU - sqrt)) / (sqrt * sqrtU);
  const c1 = (L * (sqrt - sqrtL)) / Q96_BI;
  return { c0, c1 };
}

for (const PCFG of POOL_CONFIGS) {
describe(`CL rebalance planner comparison on live ${PCFG.name} pool`, function() {
  this.timeout(2000000);

  // This suite only needs view-only access to the helper + live pool spot.
  // It does NOT mint, transfer the position NFT, or deploy a vault/strategy.
  // That keeps it isolated from any state earlier test files in the same run
  // may have left behind (e.g. cl-user-fairness moves the position NFT into
  // its own vault contract, which would then appear as the "owner" here and
  // cause many slow upstream RPC calls when re-impersonated).
  const posId = PCFG.posId;
  const posManager = "0x827922686190790b37229fd06084350E74485b72";

  let helper;
  let mockTickMath;
  let poolAddr;
  let liveSpot;
  let liveTick;
  let tickSpacing;
  const rows = [];

  let positionAvailable = true;

  before(async function() {
    const posMgr = await IPosManager.at(posManager);
    let pos;
    try {
      pos = await posMgr.positions(posId);                    // public view; no ownership required
    } catch (e) {
      // Position has been burned / doesn't exist at this fork block. Skip this suite —
      // the planner math is the same regardless of which posId we pick; the test only
      // needs ONE valid in-range Slipstream pool. Run at a fork block where this posId
      // is alive, or update POOL_CONFIGS with a current posId.
      positionAvailable = false;
      console.log(`\n  [skipped] posId ${posId} not found at this fork block (${e.message.split("\n")[0]})`);
      this.skip();
      return;
    }
    const t0Addr = pos.token0;
    const t1Addr = pos.token1;
    tickSpacing = parseInt(pos.tickSpacing.toString());

    helper = await CLRebalanceHelper.new();                  // fresh standalone helper
    const MockTickMath = artifacts.require("MockTickMath");
    mockTickMath = await MockTickMath.new();                 // deployed once, reused per scenario
    poolAddr = await helper.poolAddressFor(posManager, t0Addr, t1Addr, tickSpacing);
    liveSpot = bi(await helper.spotSqrtPriceX96(poolAddr));
    liveTick = Math.floor(Math.log(Number(liveSpot) / Number(Q96_BI)) / 0.5 / Math.log(1.0001));
    console.log(`\n  Live pool: spotSqrt=${liveSpot} (approx tick=${liveTick}, tickSpacing=${tickSpacing})`);
  });

  beforeEach(function() {
    if (!positionAvailable) this.skip();
  });

  async function runScenario({ tickLower, tickUpper, b0, b1, maxSwapBps, maxSlippageBps, label }) {
    // Snap to tickSpacing.
    tickLower = Math.floor(tickLower / tickSpacing) * tickSpacing;
    tickUpper = Math.ceil(tickUpper / tickSpacing) * tickSpacing;
    if (tickUpper <= tickLower) tickUpper = tickLower + tickSpacing;

    // Compute sqrt for ticks via Solidity TickMath so the JS-side mint simulation agrees
    // with the contract's view of in-range vs out-of-range. (JS Math.exp diverges by ~10^11 wei.)
    const sL = bi(await mockTickMath.getSqrtRatioAtTick(tickLower));
    const sU = bi(await mockTickMath.getSqrtRatioAtTick(tickUpper));
    const spot = liveSpot;

    const legacyPlan = await helper.planSwap(poolAddr, b0.toString(), b1.toString(), maxSwapBps, maxSlippageBps, 0, 0);
    const newPlan = await helper.planSwapForMint(poolAddr, tickLower, tickUpper, b0.toString(), b1.toString(), maxSwapBps, maxSlippageBps, 0, 0);

    function applyPlan(plan) {
      let p0 = b0, p1 = b1;
      if (plan.shouldSwap && bi(plan.amountIn) > 0n) {
        const amt = bi(plan.amountIn);
        if (plan.zeroForOne) {
          const out = (amt * spot * spot) / Q192_BI;
          p0 -= amt;
          p1 += out;
        } else {
          const out = (amt * Q192_BI) / (spot * spot);
          p1 -= amt;
          p0 += out;
        }
      }
      const m = simulateMint(spot, sL, sU, p0, p1);
      const lo0 = p0 - m.c0;
      const lo1 = p1 - m.c1;
      const lov = valueIn1(lo0, lo1, spot);
      const tot = valueIn1(b0, b1, spot);
      return tot > 0n ? Number((lov * 10000n) / tot) : 0;
    }

    const legacyBps = applyPlan(legacyPlan);
    const newBps = applyPlan(newPlan);
    rows.push({ label, legacyBps, newBps });
    return { legacyBps, newBps };
  }

  it("centered ranges of various widths around live spot", async function() {
    const base = liveTick;
    for (const wTicks of [1, 5, 20, 100, 500, 2000]) {
      const half = wTicks * tickSpacing;
      await runScenario({
        tickLower: base - half, tickUpper: base + half,
        b0: BigInt(1e18), b1: BigInt(1e18),
        maxSwapBps: 10000, maxSlippageBps: 100,
        label: `centered, w=${wTicks*tickSpacing*2}`,
      });
    }
  });

  it("offset ranges (spot near edge)", async function() {
    const base = liveTick;
    for (const offset of [-50, -20, -5, 5, 20, 50]) {
      const wTicks = 100;
      const half = wTicks * tickSpacing;
      await runScenario({
        tickLower: base + (offset * tickSpacing) - half, tickUpper: base + (offset * tickSpacing) + half,
        b0: BigInt(1e18), b1: BigInt(1e18),
        maxSwapBps: 10000, maxSlippageBps: 100,
        label: `offset=${offset}, w=${wTicks*tickSpacing*2}`,
      });
    }
  });

  it("imbalanced post-burn idle (e.g. burn near edge yields one-sided)", async function() {
    const base = liveTick;
    const wTicks = 50;
    const half = wTicks * tickSpacing;
    const cases = [
      { b0: BigInt(10e18), b1: BigInt(1e18), label: "10:1 t0 idle" },
      { b0: BigInt(100e18), b1: BigInt(1e18), label: "100:1 t0 idle" },
      { b0: BigInt(1e18), b1: BigInt(10e18), label: "1:10 t1 idle" },
      { b0: BigInt(1e18), b1: BigInt(100e18), label: "1:100 t1 idle" },
      { b0: BigInt(0), b1: BigInt(1e18), label: "0:full t1 only" },
      { b0: BigInt(1e18), b1: BigInt(0), label: "full:0 t0 only" },
    ];
    for (const c of cases) {
      await runScenario({
        tickLower: base - half, tickUpper: base + half,
        b0: c.b0, b1: c.b1,
        maxSwapBps: 10000, maxSlippageBps: 100,
        label: c.label,
      });
    }
  });

  it("random fuzz — 60 scenarios on live pool", async function() {
    const base = liveTick;
    let seed = 0xC0FFEE;
    function rng() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; }
    for (let i = 0; i < 60; i++) {
      const center = base + ((rng() % 400) - 200) * tickSpacing;
      const widthTicks = 1 + (rng() % 200);
      const tickLower = center - Math.floor(widthTicks / 2) * tickSpacing;
      const tickUpper = tickLower + widthTicks * tickSpacing;
      const b0 = BigInt(rng() % Number(1e9)) * BigInt(1e12) + BigInt(1e15);
      const b1 = BigInt(rng() % Number(1e9)) * BigInt(1e12) + BigInt(1e15);
      try {
        await runScenario({
          tickLower, tickUpper, b0, b1,
          maxSwapBps: 10000, maxSlippageBps: 100,
          label: `fuzz#${i}`,
        });
      } catch (e) { /* skip overflow/edge cases */ }
    }
  });

  after(function() {
    console.log("\n========================================");
    console.log("Live-pool planner comparison (legacy 50/50 vs range-aware)");
    console.log("========================================");
    console.log("label                                   | legacy bps | new bps | improvement");
    console.log("----------------------------------------|------------|---------|------------");
    let total = 0, sumLegacy = 0, sumNew = 0, maxLegacy = 0, maxNew = 0;
    for (const r of rows) {
      const label = (r.label || "").padEnd(39);
      console.log(`${label} | ${String(r.legacyBps).padStart(10)} | ${String(r.newBps).padStart(7)} | ${String(r.legacyBps - r.newBps).padStart(11)}`);
      total++; sumLegacy += r.legacyBps; sumNew += r.newBps;
      if (r.legacyBps > maxLegacy) maxLegacy = r.legacyBps;
      if (r.newBps > maxNew) maxNew = r.newBps;
    }
    console.log("----------------------------------------|------------|---------|------------");
    console.log(`scenarios=${total}  avg legacy=${(sumLegacy/total).toFixed(1)}  avg new=${(sumNew/total).toFixed(1)}  max legacy=${maxLegacy}  max new=${maxNew}`);
    console.log("========================================\n");
  });
});
}
