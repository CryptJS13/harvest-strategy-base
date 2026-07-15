// Deep rebalance analysis (helper + MockCLPool). For each scenario we:
//   1. Configure pool with a chosen sqrt + ticks
//   2. Call BOTH planners — legacy planSwap (50/50 target) and new planSwapForMint (range-aware)
//   3. Simulate the swap and a LiquidityAmounts-correct mint at the new range
//   4. Report leftover bps for BOTH planners, side-by-side
const CLRebalanceHelper = artifacts.require("CLRebalanceHelper");
const MockCLPool = artifacts.require("MockCLPool");
const MockTickMath = artifacts.require("MockTickMath");

const BN = web3.utils.toBN;
const Q96_BI = BigInt(2) ** BigInt(96);
const Q192_BI = BigInt(2) ** BigInt(192);

// Solidity-backed sqrtRatioAtTick — must match TickMath the contract uses so the JS-side
// mint simulation agrees with the contract's view of in-range vs out-of-range.
let _tm;
async function sqrtRatioAtTick(tick) {
  const v = await _tm.getSqrtRatioAtTick(tick);
  return BigInt(v.toString());
}

// Simulate the mint output (consumed0, consumed1) at given (sqrt, sqrtL, sqrtU) with inputs (a0, a1)
function simulateMint(sqrt, sqrtL, sqrtU, a0, a1) {
  if (sqrt <= sqrtL) {
    return { consumed0: a0, consumed1: 0n };
  }
  if (sqrt >= sqrtU) {
    return { consumed0: 0n, consumed1: a1 };
  }
  const L0 = (a0 * sqrt * sqrtU) / (Q96_BI * (sqrtU - sqrt));
  const L1 = (a1 * Q96_BI) / (sqrt - sqrtL);
  const L = L0 < L1 ? L0 : L1;
  const consumed0 = (L * Q96_BI * (sqrtU - sqrt)) / (sqrt * sqrtU);
  const consumed1 = (L * (sqrt - sqrtL)) / Q96_BI;
  return { consumed0, consumed1 };
}

function valueIn1(a0, a1, sqrt) {
  return (a0 * sqrt * sqrt) / Q192_BI + a1;
}

describe("Rebalance deep analysis [legacy vs range-aware planner]", function() {
  this.timeout(2000000);

  let helper;
  let pool;
  const rows = [];

  before(async function() {
    helper = await CLRebalanceHelper.new();
    _tm = await MockTickMath.new();
  });

  beforeEach(async function() {
    pool = await MockCLPool.new();
  });

  async function runOne({ tickLower, tickUpper, sqrtFracOfRange, b0, b1, maxSwapBps, maxSlippageBps, label }) {
    const sqrtLower = await sqrtRatioAtTick(tickLower);
    const sqrtUpper = await sqrtRatioAtTick(tickUpper);
    let sqrtCurrent;
    if (sqrtFracOfRange === "lower-edge") sqrtCurrent = sqrtLower + 1n;
    else if (sqrtFracOfRange === "upper-edge") sqrtCurrent = sqrtUpper - 1n;
    else {
      sqrtCurrent = sqrtLower + ((sqrtUpper - sqrtLower) * BigInt(Math.round(sqrtFracOfRange * 1000))) / 1000n;
    }
    await pool.setSlot0(sqrtCurrent.toString(), 0);
    await pool.setObserve("0", "0");

    async function withPlan(plan) {
      let postSwap0 = b0;
      let postSwap1 = b1;
      if (plan.shouldSwap && BigInt(plan.amountIn.toString()) > 0n) {
        const amountIn = BigInt(plan.amountIn.toString());
        if (plan.zeroForOne) {
          const out = (amountIn * sqrtCurrent * sqrtCurrent) / Q192_BI;
          postSwap0 -= amountIn;
          postSwap1 += out;
        } else {
          const out = (amountIn * Q192_BI) / (sqrtCurrent * sqrtCurrent);
          postSwap1 -= amountIn;
          postSwap0 += out;
        }
      }
      const m = simulateMint(sqrtCurrent, sqrtLower, sqrtUpper, postSwap0, postSwap1);
      const lo0 = postSwap0 - m.consumed0;
      const lo1 = postSwap1 - m.consumed1;
      const lov = valueIn1(lo0, lo1, sqrtCurrent);
      const tot = valueIn1(b0, b1, sqrtCurrent);
      const bps = tot > 0n ? Number((lov * 10000n) / tot) : 0;
      return bps;
    }

    const legacyPlan = await helper.planSwap(
      pool.address, b0.toString(), b1.toString(),
      maxSwapBps, maxSlippageBps, 0, 0,
    );
    const newPlan = await helper.planSwapForMint(
      pool.address, tickLower, tickUpper,
      b0.toString(), b1.toString(),
      maxSwapBps, maxSlippageBps, 0, 0,
    );
    const legacyBps = await withPlan(legacyPlan);
    const newBps = await withPlan(newPlan);
    rows.push({ label, legacyBps, newBps, improvement: legacyBps - newBps });
  }

  it("centered ranges, sqrt at exact middle", async function() {
    for (const w of [1, 2, 5, 10, 50, 200]) {
      await runOne({ tickLower: -w, tickUpper: w, sqrtFracOfRange: 0.5,
        b0: BigInt(1e18), b1: BigInt(1e18), maxSwapBps: 5000, maxSlippageBps: 100,
        label: `centered, posWidth=${w*2}` });
    }
  });

  it("sqrt at lower edge [maxSwapBps=5000 vs 10000]", async function() {
    for (const w of [1, 2, 5, 10, 50]) {
      await runOne({ tickLower: 0, tickUpper: w, sqrtFracOfRange: "lower-edge",
        b0: BigInt(1e18), b1: BigInt(1e18), maxSwapBps: 5000, maxSlippageBps: 100,
        label: `lower-edge, w=${w}, maxSwap=50%` });
      await runOne({ tickLower: 0, tickUpper: w, sqrtFracOfRange: "lower-edge",
        b0: BigInt(1e18), b1: BigInt(1e18), maxSwapBps: 10000, maxSlippageBps: 100,
        label: `lower-edge, w=${w}, maxSwap=100%` });
    }
  });

  it("sqrt at upper edge [maxSwapBps=5000 vs 10000]", async function() {
    for (const w of [1, 2, 5, 10, 50]) {
      await runOne({ tickLower: 0, tickUpper: w, sqrtFracOfRange: "upper-edge",
        b0: BigInt(1e18), b1: BigInt(1e18), maxSwapBps: 5000, maxSlippageBps: 100,
        label: `upper-edge, w=${w}, maxSwap=50%` });
      await runOne({ tickLower: 0, tickUpper: w, sqrtFracOfRange: "upper-edge",
        b0: BigInt(1e18), b1: BigInt(1e18), maxSwapBps: 10000, maxSlippageBps: 100,
        label: `upper-edge, w=${w}, maxSwap=100%` });
    }
  });

  it("sqrt at various fractions of range", async function() {
    for (const f of [0.1, 0.25, 0.4, 0.6, 0.75, 0.9]) {
      await runOne({ tickLower: 0, tickUpper: 100, sqrtFracOfRange: f,
        b0: BigInt(1e18), b1: BigInt(1e18), maxSwapBps: 5000, maxSlippageBps: 100,
        label: `posWidth=100, sqrt at frac ${f}` });
    }
  });

  it("imbalanced starting balances", async function() {
    const cases = [
      { b0: BigInt(10e18), b1: BigInt(1e18), label: "10:1 t0 heavy" },
      { b0: BigInt(100e18), b1: BigInt(1e18), label: "100:1 t0 heavy" },
      { b0: BigInt(1e18), b1: BigInt(10e18), label: "1:10 t1 heavy" },
      { b0: BigInt(1e18), b1: BigInt(100e18), label: "1:100 t1 heavy" },
    ];
    for (const c of cases) {
      await runOne({ tickLower: -10, tickUpper: 10, sqrtFracOfRange: 0.5,
        b0: c.b0, b1: c.b1, maxSwapBps: 5000, maxSlippageBps: 100, label: c.label });
    }
  });

  it("tiny amounts (precision)", async function() {
    for (const e of [3, 6, 9, 12]) {
      const v = BigInt(10) ** BigInt(e);
      await runOne({ tickLower: -10, tickUpper: 10, sqrtFracOfRange: 0.5,
        b0: v, b1: v, maxSwapBps: 5000, maxSlippageBps: 100,
        label: `tiny=${v.toString()} each` });
    }
  });

  it("large amounts", async function() {
    for (const e of [18, 24, 30]) {
      const v = BigInt(10) ** BigInt(e);
      await runOne({ tickLower: -10, tickUpper: 10, sqrtFracOfRange: 0.5,
        b0: v, b1: v, maxSwapBps: 5000, maxSlippageBps: 100,
        label: `large=1e${e} each` });
    }
  });

  it("random fuzz — 100 scenarios @ maxSwap=100%", async function() {
    let seed = 0xDEADBEEF;
    function rng() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; }
    for (let i = 0; i < 100; i++) {
      const center = (rng() % 200) - 100;
      const width = 1 + (rng() % 100);
      const tickLower = center - Math.floor(width / 2);
      const tickUpper = tickLower + width;
      const frac = (rng() % 1000) / 1000;
      const b0 = BigInt(rng() % Number(1e9)) * BigInt(1e12) + BigInt(1e15);
      const b1 = BigInt(rng() % Number(1e9)) * BigInt(1e12) + BigInt(1e15);
      try {
        await runOne({ tickLower, tickUpper, sqrtFracOfRange: frac,
          b0, b1, maxSwapBps: 10000, maxSlippageBps: 100,
          label: `fuzz#${i} c=${center} w=${width} f=${frac.toFixed(2)}` });
      } catch (e) {
        // skip edge cases where simulation arithmetic fails
      }
    }
  });

  after(function() {
    console.log("\n========================================");
    console.log("Rebalance leftover comparison (legacy 50/50 vs new range-aware)");
    console.log("========================================");
    console.log("label                                          | legacy bps | new bps | Δ improvement");
    console.log("-----------------------------------------------|------------|---------|--------------");
    let total = 0;
    let sumLegacy = 0;
    let sumNew = 0;
    let maxLegacy = 0;
    let maxNew = 0;
    const bucketsLegacy = { "0-10": 0, "10-100": 0, "100-1000": 0, "1000-5000": 0, ">5000": 0 };
    const bucketsNew = { "0-10": 0, "10-100": 0, "100-1000": 0, "1000-5000": 0, ">5000": 0 };
    function bucket(buckets, bps) {
      if (bps < 10) buckets["0-10"]++;
      else if (bps < 100) buckets["10-100"]++;
      else if (bps < 1000) buckets["100-1000"]++;
      else if (bps < 5000) buckets["1000-5000"]++;
      else buckets[">5000"]++;
    }
    for (const r of rows) {
      const label = (r.label || "").padEnd(46);
      console.log(`${label} | ${String(r.legacyBps).padStart(10)} | ${String(r.newBps).padStart(7)} | ${String(r.improvement).padStart(12)}`);
      total++;
      sumLegacy += r.legacyBps;
      sumNew += r.newBps;
      if (r.legacyBps > maxLegacy) maxLegacy = r.legacyBps;
      if (r.newBps > maxNew) maxNew = r.newBps;
      bucket(bucketsLegacy, r.legacyBps);
      bucket(bucketsNew, r.newBps);
    }
    console.log("-----------------------------------------------|------------|---------|--------------");
    console.log(`scenarios=${total}  avg legacy=${(sumLegacy/total).toFixed(1)}  avg new=${(sumNew/total).toFixed(1)}  max legacy=${maxLegacy}  max new=${maxNew}`);
    console.log("legacy distribution:", JSON.stringify(bucketsLegacy));
    console.log("new    distribution:", JSON.stringify(bucketsNew));
    console.log("========================================\n");
  });
});
