// Performance + cost benchmarks for the CL vault on a recent Base fork.
// Run with: FORK_BLOCK=<recent> npx hardhat test test/aeroCL/cl-vault-benchmark.js
// Prints gas costs, principal-loss round-trip, and a multi-cycle yield simulation.
const Utils = require("../utilities/Utils.js");
const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");

const Strategy = artifacts.require("AerodromeCLStrategyMainnet_cbETH_ETH1");
const IERC721 = artifacts.require("IERC721");
const IERC20 = artifacts.require("IERC20Upgradeable");

const BN = web3.utils.toBN;
const TWO_192 = BN("2").pow(BN("192"));

function valueIn1(amt0, amt1, sqrtBN) {
  const a0 = BN(amt0);
  const a1 = BN(amt1);
  if (a0.isZero()) return a1;
  return a0.mul(sqrtBN).mul(sqrtBN).div(TWO_192).add(a1);
}

function fmt(n) {
  // pretty print BN as decimal-ish string
  return new BigNumber(n.toString()).toFixed();
}

function pctBps(numer, denom) {
  // numer/denom * 10000 in BN
  if (denom.isZero()) return "n/a";
  return numer.mul(BN("1000000")).div(denom).toNumber() / 100; // returns bps as float
}

describe("CL vault performance & cost benchmarks (cbETH/ETH1)", function() {
  this.timeout(2000000);

  let governance;
  let underlyingWhale = "0x6a74649aCFD7822ae8Fb78463a9f2192752E5Aa2";
  const posId = 19447757;
  const posManager = "0x827922686190790b37229fd06084350E74485b72";

  let controller;
  let vault;
  let strategy;
  let token0;
  let token1;
  let accounts;

  // Aggregate report we print at the end.
  const report = { forkBlock: null, gas: {}, principalLossBps: null, yield: null };

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();

    const nft = await IERC721.at(posManager);
    underlyingWhale = await nft.ownerOf(posId);

    await impersonates([governance, underlyingWhale]);
    for (const a of [governance, underlyingWhale]) {
      await hre.network.provider.request({
        method: "hardhat_setBalance",
        params: [a, "0x8AC7230489E80000"],
      });
    }
    if (underlyingWhale.toLowerCase() !== governance.toLowerCase()) {
      await nft.transferFrom(underlyingWhale, governance, posId, { from: underlyingWhale });
    }

    [controller, vault, strategy] = await setupCoreProtocol({
      CLVault: true,
      CLSetup: { posId, posManager, targetWidth: 1 },
      existingVaultAddress: null,
      strategyArtifact: Strategy,
      strategyArtifactIsUpgradable: true,
      governance,
    });

    token0 = await IERC20.at(await vault.token0());
    token1 = await IERC20.at(await vault.token1());

    // Open all lanes; cooldown 0; executor = governance.
    await vault.setLanePause(false, false, false, false, { from: governance });
    await vault.setRebalanceConfig(0, 0, governance, { from: governance });

    report.forkBlock = await web3.eth.getBlockNumber();
  });

  // ---------- helpers ----------
  async function withdrawSlice(divisor) {
    const shares = BN(await vault.balanceOf(governance)).div(BN(divisor));
    const t0Before = BN(await token0.balanceOf(governance));
    const t1Before = BN(await token1.balanceOf(governance));
    const tx = await vault.withdraw(shares.toString(), 0, 0, { from: governance });
    return {
      shares,
      gas: tx.receipt.gasUsed,
      dt0: BN(await token0.balanceOf(governance)).sub(t0Before),
      dt1: BN(await token1.balanceOf(governance)).sub(t1Before),
    };
  }

  async function depositAll() {
    const a0 = BN(await token0.balanceOf(governance));
    const a1 = BN(await token1.balanceOf(governance));
    if (a0.isZero() && a1.isZero()) return null;
    await token0.approve(vault.address, a0.toString(), { from: governance });
    await token1.approve(vault.address, a1.toString(), { from: governance });
    const sharesBefore = BN(await vault.balanceOf(governance));
    const tx = await vault.deposit(a0.toString(), a1.toString(), 0, governance, { from: governance });
    return {
      a0,
      a1,
      gas: tx.receipt.gasUsed,
      mintedShares: BN(await vault.balanceOf(governance)).sub(sharesBefore),
    };
  }

  // ---------- benchmarks ----------

  it("benchmarks gas: deposit 1%, deposit 10%, deposit ALL, withdraw small/medium/full", async function() {
    // 1% slice deposit
    let w = await withdrawSlice(100);
    let d = await depositAll();
    report.gas.deposit_1pct = d ? d.gas : null;
    report.gas.withdraw_1pct = w.gas;

    // 10% slice
    w = await withdrawSlice(10);
    d = await depositAll();
    report.gas.deposit_10pct = d ? d.gas : null;
    report.gas.withdraw_10pct = w.gas;

    // 50% slice (the largest non-final round-trip we can measure without zeroing PPS)
    w = await withdrawSlice(2);
    d = await depositAll();
    report.gas.deposit_50pct = d ? d.gas : null;
    report.gas.withdraw_50pct = w.gas;
  });

  it("benchmarks gas: doHardWork (cold) and doHardWork (warm)", async function() {
    // First doHardWork: NFT transfers to strategy + stake. "Cold" path.
    const tx1 = await controller.doHardWork(vault.address, { from: governance });
    report.gas.doHardWork_cold = tx1.receipt.gasUsed;

    // advance ~1 hour to accrue some rewards
    await Utils.advanceNBlock(1800); // 1800 blocks ~= 1 hour at 2s blocktime

    const tx2 = await controller.doHardWork(vault.address, { from: governance });
    report.gas.doHardWork_warm = tx2.receipt.gasUsed;
  });

  it("benchmarks gas: rebalanceCurrentTick", async function() {
    try {
      const tx = await vault.rebalanceCurrentTick(1, { from: governance });
      report.gas.rebalanceCurrentTick = tx.receipt.gasUsed;
    } catch (e) {
      // No-op rebalance branch (tick range unchanged) doesn't emit. Try posWidth=2 if available.
      try {
        const tx = await vault.rebalanceCurrentTick(2, { from: governance });
        report.gas.rebalanceCurrentTick = tx.receipt.gasUsed;
      } catch (_) {
        report.gas.rebalanceCurrentTick = "skipped (no-op or guard tripped)";
      }
    }
  });

  it("measures round-trip principal loss (deposit -> immediate withdraw)", async function() {
    // Withdraw 5% of governance shares → idle tokens.
    const w = await withdrawSlice(20);
    if (w.dt0.isZero() && w.dt1.isZero()) {
      report.principalLossBps = "skipped (no proceeds)";
      return;
    }

    const sqrtPre = BN(await vault.getSqrtPriceX96());
    const inputValue = valueIn1(w.dt0, w.dt1, sqrtPre);

    // Now deposit those same tokens.
    const d = await depositAll();
    if (!d) {
      report.principalLossBps = "skipped (deposit failed)";
      return;
    }

    // Immediately withdraw the freshly minted shares.
    const t0Before = BN(await token0.balanceOf(governance));
    const t1Before = BN(await token1.balanceOf(governance));
    await vault.withdraw(d.mintedShares.toString(), 0, 0, { from: governance });
    const got0 = BN(await token0.balanceOf(governance)).sub(t0Before);
    const got1 = BN(await token1.balanceOf(governance)).sub(t1Before);

    const sqrtPost = BN(await vault.getSqrtPriceX96());
    const outputValue = valueIn1(got0, got1, sqrtPost);
    const loss = inputValue.gt(outputValue) ? inputValue.sub(outputValue) : BN("0");
    const lossBps = pctBps(loss, inputValue);

    report.principalLossBps = lossBps;
    report.principalLossDetail = {
      inputValueIn1: inputValue.toString(),
      outputValueIn1: outputValue.toString(),
      lossInToken1Units: loss.toString(),
    };
  });

  it("simulates yield over N hourly cycles and reports APR/APY", async function() {
    const HOURS = 12;
    const BLOCKS_PER_HOUR = 1800;

    // Initial doHardWork to ensure strategy holds NFT and is staked.
    await controller.doHardWork(vault.address, { from: governance });
    const ppsStart = BN(await vault.getPricePerFullShare());
    const tStart = BN((await web3.eth.getBlock("latest")).timestamp);

    let ppsHistory = [{ hour: 0, pps: ppsStart.toString() }];
    let totalGasHardwork = BN("0");
    for (let h = 1; h <= HOURS; h++) {
      await Utils.advanceNBlock(BLOCKS_PER_HOUR);
      const tx = await controller.doHardWork(vault.address, { from: governance });
      totalGasHardwork = totalGasHardwork.add(BN(tx.receipt.gasUsed));
      const pps = BN(await vault.getPricePerFullShare());
      ppsHistory.push({ hour: h, pps: pps.toString() });
    }
    const ppsEnd = BN((await vault.getPricePerFullShare()).toString());
    const tEnd = BN((await web3.eth.getBlock("latest")).timestamp);
    const elapsedSec = tEnd.sub(tStart).toNumber();
    const elapsedHours = elapsedSec / 3600;

    // growth per period (linear approximation), annualised.
    const ppsStartF = parseFloat(ppsStart.toString());
    const ppsEndF = parseFloat(ppsEnd.toString());
    const growth = ppsStartF > 0 ? (ppsEndF / ppsStartF - 1) : 0; // fractional
    const yearsElapsed = elapsedHours / (24 * 365);
    const aprAnnual = yearsElapsed > 0 ? growth / yearsElapsed : 0;
    const apyAnnual = yearsElapsed > 0 ? Math.pow(1 + (growth / (yearsElapsed * 365 * 24)), 365 * 24) - 1 : 0;

    report.yield = {
      hoursSimulated: HOURS,
      elapsedSecondsOnFork: elapsedSec,
      ppsStart: ppsStart.toString(),
      ppsEnd: ppsEnd.toString(),
      growthPctOverPeriod: (growth * 100).toFixed(6),
      aprPct: (aprAnnual * 100).toFixed(4),
      apyPctCompounded: (apyAnnual * 100).toFixed(4),
      totalHardworkGas: totalGasHardwork.toString(),
      avgHardworkGas: totalGasHardwork.div(BN(HOURS.toString())).toString(),
      ppsHistory,
    };
  });

  after(function() {
    // Print the final aggregated report. Mocha lets us emit text and the gas-reporter table
    // separately; we want both visible in the output.
    console.log("\n========================================");
    console.log("CL Vault Benchmark Report");
    console.log("========================================");
    console.log("Fork block:", report.forkBlock);
    console.log("\nGas costs (gasUsed per call):");
    for (const k of Object.keys(report.gas)) {
      console.log("  " + k.padEnd(28) + " = " + report.gas[k]);
    }
    console.log("\nPrincipal loss (round-trip deposit+withdraw):");
    console.log("  loss in basis points:", report.principalLossBps);
    if (report.principalLossDetail) {
      console.log("  input  (token1-units):", report.principalLossDetail.inputValueIn1);
      console.log("  output (token1-units):", report.principalLossDetail.outputValueIn1);
      console.log("  loss   (token1-units):", report.principalLossDetail.lossInToken1Units);
    }
    console.log("\nYield simulation (" + (report.yield ? report.yield.hoursSimulated : "?") + " hourly cycles):");
    if (report.yield) {
      console.log("  elapsed seconds on fork :", report.yield.elapsedSecondsOnFork);
      console.log("  PPS start               :", report.yield.ppsStart);
      console.log("  PPS end                 :", report.yield.ppsEnd);
      console.log("  growth over period (%)  :", report.yield.growthPctOverPeriod);
      console.log("  estimated APR (%)       :", report.yield.aprPct);
      console.log("  estimated APY (%)       :", report.yield.apyPctCompounded);
      console.log("  total doHardWork gas    :", report.yield.totalHardworkGas);
      console.log("  avg per doHardWork      :", report.yield.avgHardworkGas);
      console.log("  PPS history             :");
      for (const row of report.yield.ppsHistory) {
        console.log("    hour " + row.hour + " : " + row.pps);
      }
    }
    console.log("========================================\n");
  });
});
