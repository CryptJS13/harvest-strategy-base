// Diagnostic: figure out why doHardWork sees zero reward accrual at the test fork blocks.
// Reads gauge.earned, strategy AERO balance, and rewardRate at multiple time points.
const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");
const Utils = require("../utilities/Utils.js");
const addresses = require("../test-config.js");

const Strategy = artifacts.require("AerodromeCLStrategyMainnet_cbETH_ETH1");
const IERC721 = artifacts.require("IERC721");
const IERC20 = artifacts.require("IERC20Upgradeable");
const ICLGauge = artifacts.require("ICLGauge");

const BN = web3.utils.toBN;
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";

describe("CL gauge diagnostic", function() {
  this.timeout(2000000);
  let governance, underlyingWhale;
  const posId = 19447757;
  const posManager = "0x827922686190790b37229fd06084350E74485b72";
  const gaugeAddr = "0xF5550F8F0331B8CAA165046667f4E6628E9E3Aac";
  let vault, controller, strategy;
  let aero, gauge;

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
  });

  it("explores reward accrual at multiple time advances", async function() {
    const periodFinish = parseInt(await gauge.periodFinish());
    const rewardRate = BN(await gauge.rewardRate()).toString();
    const now0 = (await web3.eth.getBlock("latest")).timestamp;
    console.log("\n=== Gauge state ===");
    console.log("rewardRate (wei/sec):", rewardRate);
    console.log("periodFinish:        ", periodFinish);
    console.log("current timestamp:   ", now0);
    console.log("seconds remaining:   ", periodFinish - now0);

    console.log("\n=== Cold doHardWork (transfers NFT to strategy + stakes) ===");
    await controller.doHardWork(vault.address, { from: governance });
    let aeroBal = BN(await aero.balanceOf(strategy.address));
    let earned = BN(await gauge.earned(strategy.address, posId));
    console.log("strategy AERO balance:", aeroBal.toString());
    console.log("gauge.earned(strategy, posId):", earned.toString());
    console.log("position posId from vault:", (await vault.posId()).toString());

    const timeAdvances = [
      { label: "+1 hour", blocks: 1800 },
      { label: "+24 hours", blocks: 43200 },
      { label: "+7 days", blocks: 302400 },
    ];

    for (const ta of timeAdvances) {
      await Utils.advanceNBlock(ta.blocks);
      const blockNow = (await web3.eth.getBlock("latest")).timestamp;
      const earnedNow = BN(await gauge.earned(strategy.address, posId));
      const aeroNow = BN(await aero.balanceOf(strategy.address));
      console.log("\n--- after " + ta.label + " (timestamp " + blockNow + ") ---");
      console.log("gauge.earned(strategy, posId):", earnedNow.toString(),
        " (~" + (parseFloat(earnedNow.toString()) / 1e18).toFixed(8) + " AERO)");
      console.log("strategy AERO balance:        ", aeroNow.toString());
    }

    console.log("\n=== Warm doHardWork (claims + compounds) ===");
    const ppsBefore = BN(await vault.getPricePerFullShare());
    const aeroBefore = BN(await aero.balanceOf(strategy.address));
    const earnedBefore = BN(await gauge.earned(strategy.address, posId));
    await controller.doHardWork(vault.address, { from: governance });
    const ppsAfter = BN(await vault.getPricePerFullShare());
    const aeroAfter = BN(await aero.balanceOf(strategy.address));
    const earnedAfter = BN(await gauge.earned(strategy.address, posId));
    console.log("AERO before -> after :", aeroBefore.toString(), "->", aeroAfter.toString());
    console.log("earned before -> after:", earnedBefore.toString(), "->", earnedAfter.toString());
    console.log("PPS before -> after:", ppsBefore.toString(), "->", ppsAfter.toString());
    console.log("PPS delta:", ppsAfter.sub(ppsBefore).toString());
  });
});
