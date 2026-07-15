// Step-by-step trace of doHardWork at a block where the gauge IS paying. Tracks every token
// movement: AERO claim, fees to rewardForwarder, swap to token0, value-balance swap to token1,
// final increaseLiquidity. Prints the absolute USD value lost at each step.
const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");
const Utils = require("../utilities/Utils.js");
const addresses = require("../test-config.js");

const Strategy = artifacts.require("AerodromeCLStrategyMainnet_cbETH_ETH1");
const IERC721 = artifacts.require("IERC721");
const IERC20 = artifacts.require("IERC20Upgradeable");
const ICLGauge = artifacts.require("ICLGauge");
const IController = artifacts.require("IController");

const BN = web3.utils.toBN;
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";

// Crude USD anchors (fork is ~July 2025, AERO ~$1, cbETH/ETH1 ~$3000/ETH).
const USD = { aero: 1, t0: 3000, t1: 3000 };

function fmtRaw(rawBN, decimals) {
  const s = BN(rawBN).toString();
  const padded = s.padStart(decimals + 1, "0");
  return padded.slice(0, padded.length - decimals) + "." + padded.slice(padded.length - decimals).slice(0, 6);
}

function usdOf(rawBN, decimals, anchor) {
  return parseFloat(BN(rawBN).toString()) * anchor / Math.pow(10, decimals);
}

describe("CL reward-active trace [cbETH/ETH1]", function() {
  this.timeout(2000000);
  let governance, underlyingWhale;
  const posId = 19447757;
  const posManager = "0x827922686190790b37229fd06084350E74485b72";
  const gaugeAddr = "0xF5550F8F0331B8CAA165046667f4E6628E9E3Aac";
  let vault, controller, strategy;
  let aero, gauge, token0, token1;
  let rewardForwarder;

  before(async function() {
    governance = addresses.Governance;
    const nft = await IERC721.at(posManager);
    underlyingWhale = await nft.ownerOf(posId);
    await impersonates([governance, underlyingWhale]);
    for (const a of [governance, underlyingWhale]) {
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [a, "0x8AC7230489E80000"] });
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
    await vault.setLanePause(false, false, false, false, { from: governance });
    aero = await IERC20.at(AERO);
    gauge = await ICLGauge.at(gaugeAddr);
    token0 = await IERC20.at(await vault.token0());
    token1 = await IERC20.at(await vault.token1());
    const ctrl = await IController.at(await vault.controller());
    rewardForwarder = await ctrl.rewardForwarder();
  });

  async function snap() {
    let earned = BN("0");
    try { earned = BN(await gauge.earned(strategy.address, posId)); } catch (_) { /* not staked */ }
    return {
      stratAero: BN(await aero.balanceOf(strategy.address)),
      stratT0: BN(await token0.balanceOf(strategy.address)),
      stratT1: BN(await token1.balanceOf(strategy.address)),
      vaultIdle0: BN(await token0.balanceOf(vault.address)),
      vaultIdle1: BN(await token1.balanceOf(vault.address)),
      forwarderAero: BN(await aero.balanceOf(rewardForwarder)),
      governanceAero: BN(await aero.balanceOf(governance)),
      pps: BN(await vault.getPricePerFullShare()),
      supply: BN(await vault.totalSupply()),
      navL: BN(await vault.underlyingBalanceWithInvestment()),
      pos: await vault.getCurrentTokenAmounts(),
      gaugeEarned: earned,
    };
  }

  function totalUsd(s) {
    return usdOf(s.stratAero, 18, USD.aero) +
           usdOf(s.stratT0, 18, USD.t0) +
           usdOf(s.stratT1, 18, USD.t1) +
           usdOf(s.vaultIdle0, 18, USD.t0) +
           usdOf(s.vaultIdle1, 18, USD.t1) +
           usdOf(s.forwarderAero, 18, USD.aero) +
           usdOf(BN(s.pos[0]), 18, USD.t0) +
           usdOf(BN(s.pos[1]), 18, USD.t1);
  }

  function header(label) {
    console.log("\n=== " + label + " ===");
    console.log("metric                       | strategy AERO | strategy t0 | strategy t1 | vault idle (t0/t1) | forwarder AERO | gauge earned | position (t0/t1) | NAV(L) | PPS");
  }

  function row(s, label) {
    console.log(label.padEnd(28) + " | " +
      fmtRaw(s.stratAero, 18).padStart(13) + " | " +
      fmtRaw(s.stratT0, 18).padStart(11) + " | " +
      fmtRaw(s.stratT1, 18).padStart(11) + " | " +
      (fmtRaw(s.vaultIdle0, 18) + "/" + fmtRaw(s.vaultIdle1, 18)).padStart(20) + " | " +
      fmtRaw(s.forwarderAero, 18).padStart(14) + " | " +
      fmtRaw(s.gaugeEarned, 18).padStart(12) + " | " +
      (fmtRaw(BN(s.pos[0]), 18) + "/" + fmtRaw(BN(s.pos[1]), 18)).padStart(20) + " | " +
      s.navL.toString().padStart(20) + " | " +
      s.pps.toString().padStart(20));
  }

  it("traces a full reward cycle (stake -> 24h -> claim+compound)", async function() {
    // Stage 0: pre-stake
    let s0 = await snap();
    header("Stage 0: pre-stake (just after vault setup)");
    row(s0, "stage 0");

    // Stage 1: cold doHardWork stakes the position into the gauge
    await controller.doHardWork(vault.address, { from: governance });
    let s1 = await snap();
    row(s1, "stage 1 (post cold HW)");

    // Stage 2: advance ~24h to accrue rewards
    await Utils.advanceNBlock(43200);
    let s2 = await snap();
    row(s2, "stage 2 (+24h, pre claim)");

    // Stage 3: warm doHardWork claims + compounds
    await controller.doHardWork(vault.address, { from: governance });
    let s3 = await snap();
    row(s3, "stage 3 (post warm HW)");

    // ---- value flow analysis ----
    const earnedAtClaim = s2.gaugeEarned;
    const earnedUsd = usdOf(earnedAtClaim, 18, USD.aero);
    const feeAero = s3.forwarderAero.sub(s2.forwarderAero); // fee taken
    const feeUsd = usdOf(feeAero, 18, USD.aero);
    const stratAeroDelta = s3.stratAero.sub(s2.stratAero); // strategy net AERO change after claim+swap
    const stratAeroUsd = usdOf(stratAeroDelta, 18, USD.aero);
    const stratT0Delta = s3.stratT0.sub(s2.stratT0);
    const stratT1Delta = s3.stratT1.sub(s2.stratT1);
    const posT0Delta = BN(s3.pos[0]).sub(BN(s2.pos[0]));
    const posT1Delta = BN(s3.pos[1]).sub(BN(s2.pos[1]));
    const posT0Usd = usdOf(posT0Delta, 18, USD.t0);
    const posT1Usd = usdOf(posT1Delta, 18, USD.t1);

    const ppsChange = parseFloat(s3.pps.sub(s2.pps).toString());
    const ppsBps = ppsChange / parseFloat(s2.pps.toString()) * 10000;
    const navLDelta = s3.navL.sub(s2.navL).toString();

    const totalBefore = totalUsd(s2);
    const totalAfter = totalUsd(s3);
    const netChangeUsd = totalAfter - totalBefore;

    console.log("\n=== Reward cycle accounting ===");
    console.log("rewards earned over 24h     :", fmtRaw(earnedAtClaim, 18), "AERO ($" + earnedUsd.toFixed(6) + ")");
    console.log("fee skimmed by forwarder    :", fmtRaw(feeAero, 18), "AERO ($" + feeUsd.toFixed(6) + ") = " + (earnedUsd > 0 ? (feeUsd / earnedUsd * 100).toFixed(2) : "0") + "% of earned");
    console.log("strategy AERO net change    :", fmtRaw(stratAeroDelta, 18), "AERO ($" + stratAeroUsd.toFixed(6) + ")");
    console.log("strategy t0 net change      :", fmtRaw(stratT0Delta, 18), "($" + usdOf(stratT0Delta, 18, USD.t0).toFixed(6) + ")");
    console.log("strategy t1 net change      :", fmtRaw(stratT1Delta, 18), "($" + usdOf(stratT1Delta, 18, USD.t1).toFixed(6) + ")");
    console.log("position t0 added           :", fmtRaw(posT0Delta, 18), "($" + posT0Usd.toFixed(6) + ")");
    console.log("position t1 added           :", fmtRaw(posT1Delta, 18), "($" + posT1Usd.toFixed(6) + ")");
    console.log("NAV-L delta                 :", navLDelta);
    console.log("PPS change (bps)            :", ppsBps.toFixed(6));
    console.log("net total tracked USD delta :", netChangeUsd.toFixed(6));
    console.log("(internal cost = -netChange):", (-netChangeUsd).toFixed(6),
      "USD — this is what UL routing + fees ate");
  });
});
