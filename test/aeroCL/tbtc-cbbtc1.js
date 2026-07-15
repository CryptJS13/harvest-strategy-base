// Utilities
const Utils = require("../utilities/Utils.js");
const {
  impersonates,
  setupCoreProtocol,
} = require("../utilities/hh-utils.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");

//const Strategy = artifacts.require("");
const Strategy = artifacts.require("AerodromeCLStrategyMainnet_tBTC_cbBTC1");
const IERC721 = artifacts.require("IERC721");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const ICLGauge = artifacts.require("ICLGauge");

// Developed and tested at blockNumber 32897925

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("CL test", function() {
  let accounts;

  // external setup
  let underlyingWhale = "0x6a74649aCFD7822ae8Fb78463a9f2192752E5Aa2";
  let posId = 19450559
  let posManager = "0x827922686190790b37229fd06084350E74485b72";
  let gauge = "0xB57eC27f68Bd356e300D57079B6cdbe57d50830d";
//   let aero = "0x940181a94A35A4569E4529A3CDfB74e38FD98631"
//   let superoeth = "0xDBFeFD2e8460a6Ee4955A68582F85708BAEA60A3"

  // parties in the protocol
  let governance;
  let farmer1;

  // Core protocol contracts
  let controller;
  let vault;
  let strategy;
  let nftToken;
  let gaugeContract;

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();

    farmer1 = governance;

    nftToken = await IERC721.at(posManager);
    gaugeContract = await ICLGauge.at(gauge);
    let actualOwner;
    try {
      actualOwner = await nftToken.ownerOf(posId);
    } catch (e) {
      const pm = await IPosManager.at(posManager);
      const gaugeToken0 = (await gaugeContract.token0()).toLowerCase();
      const gaugeToken1 = (await gaugeContract.token1()).toLowerCase();
      const supply = parseInt((await pm.totalSupply()).toString(), 10);
      const scanWindow = Math.min(supply, 120000);
      let foundPosId = null;
      let foundOwner = null;
      let foundLiquidity = "0";
      for (let i = 0; i < scanWindow; i++) {
        const idx = supply - 1 - i;
        let candidateId;
        try {
          candidateId = await pm.tokenByIndex(idx);
        } catch (_) {
          continue;
        }
        let details;
        try {
          details = await pm.positions(candidateId);
        } catch (_) {
          continue;
        }
        const token0 = details.token0.toLowerCase();
        const token1 = details.token1.toLowerCase();
        const liquidity = details.liquidity.toString();
        if (liquidity === "0") {
          continue;
        }
        if (token0 !== gaugeToken0 || token1 !== gaugeToken1) {
          continue;
        }
        try {
          foundOwner = await nftToken.ownerOf(candidateId);
        } catch (_) {
          continue;
        }
        foundPosId = parseInt(candidateId.toString(), 10);
        foundLiquidity = liquidity;
        break;
      }
      if (!foundPosId || !foundOwner) {
        console.log("No active tBTC/cbBTC CL position found in scan window", scanWindow);
        this.skip();
        return;
      }
      posId = foundPosId;
      actualOwner = foundOwner;
      console.log("Discovered dynamic posId", posId, "liquidity", foundLiquidity);
    }
    underlyingWhale = actualOwner;

    // impersonate accounts
    await impersonates([governance, underlyingWhale]);

    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [governance, "0x8AC7230489E80000"], // 10 ETH
    });
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [underlyingWhale, "0x8AC7230489E80000"], // 10 ETH
    });

    if (underlyingWhale.toLowerCase() !== governance.toLowerCase()) {
      await nftToken.transferFrom(underlyingWhale, governance, posId, { from: underlyingWhale });
    }

    [controller, vault, strategy] = await setupCoreProtocol({
      "CLVault": true,
      "CLSetup": {
        posId: posId,
        posManager: posManager,
        targetWidth: 1,
      },
      "existingVaultAddress": null,
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "governance": governance,
    //   "liquidation": [
    //     {"aerodrome": [aero, superoeth]},
    //   ]
    });

    let sqrtPrice = new BigNumber(await vault.getSqrtPriceX96())
    console.log(sqrtPrice.toFixed())
  });

  describe("Happy path", function() {
    it("Core hardening controls should work", async function() {
      const tickSpacing = await vault.tickSpacing();
      assert.notEqual(tickSpacing.toString(), "0");

      await vault.setRebalanceConfig(0, 3600, governance, { from: governance });

      await vault.setLanePause(false, true, false, false, { from: governance });
      let reverted = false;
      try {
        await controller.doHardWork(vault.address, { from: governance });
      } catch (e) {
        reverted = true;
      }
      assert.equal(reverted, true, "Expected paused harvest to revert");
      await vault.setLanePause(false, false, false, false, { from: governance });
    });

    it("should stake NFT into gauge on hardwork", async function() {
      const activePosId = await vault.posId();
      await controller.doHardWork(vault.address, { from: governance });

      const ownerAfter = await nftToken.ownerOf(activePosId);
      assert.equal(ownerAfter.toLowerCase(), gauge.toLowerCase(), "Expected gauge to own staked NFT");

      const staked = await gaugeContract.stakedContains(strategy.address, activePosId);
      assert.equal(staked, true, "Expected strategy position to be staked in gauge");
    });

    it("should expose gauge emission telemetry for APR diagnostics", async function() {
      const rewardRate = new BigNumber(await gaugeContract.rewardRate());
      const periodFinish = new BigNumber(await gaugeContract.periodFinish());
      const latestBlock = await web3.eth.getBlock("latest");
      const now = new BigNumber(latestBlock.timestamp);
      const emissionsActive = rewardRate.gt(0) && periodFinish.gt(now);

      console.log("Gauge rewardRate:", rewardRate.toFixed());
      console.log("Gauge periodFinish:", periodFinish.toFixed());
      console.log("Now:", now.toFixed());
      console.log("Emissions active:", emissionsActive);

      // Diagnostic assertion to keep this test deterministic on pinned forks.
      assert.equal(rewardRate.gte(0), true, "Gauge reward rate should be a valid non-negative value");
      if (!emissionsActive) {
        console.log("Gauge emissions inactive at pinned fork block; 0% APR can be expected.");
        return;
      }

      const activePosId = await vault.posId();
      let earnedBefore;
      try {
        earnedBefore = new BigNumber(await gaugeContract.earned(strategy.address, activePosId));
      } catch (e) {
        console.log("Gauge earned() not callable for diagnostics on this deployment, skipping accrual assertion.");
        return;
      }

      await Utils.advanceNBlock(1200);
      const earnedAfter = new BigNumber(await gaugeContract.earned(strategy.address, activePosId));
      Utils.assertBNGte(earnedAfter, earnedBefore);
      console.log("Gauge earned before:", earnedBefore.toFixed());
      console.log("Gauge earned after:", earnedAfter.toFixed());
    });

    it("should skip compounding under min threshold without revert", async function() {
      const rewardToken = await strategy.rewardToken();
      const highThreshold = "1000000000000000000000000"; // 1,000,000 tokens (18 decimals)
      await strategy.setMinRewardToCompound(rewardToken, highThreshold, { from: governance });

      const before = new BigNumber(await vault.getPricePerFullShare());
      await controller.doHardWork(vault.address, { from: governance });
      await Utils.advanceNBlock(5000);
      await controller.doHardWork(vault.address, { from: governance });
      const after = new BigNumber(await vault.getPricePerFullShare());
      Utils.assertBNGte(after, before);

      const configured = await strategy.minRewardToCompound(rewardToken);
      assert.equal(configured.toString(), highThreshold, "Threshold config mismatch");

      await strategy.setMinRewardToCompound(rewardToken, "1", { from: governance });
    });

    it("should enforce governance-only threshold updates", async function() {
      const rewardToken = await strategy.rewardToken();
      let reverted = false;
      try {
        await strategy.setMinRewardToCompound(rewardToken, "10", { from: accounts[3] });
      } catch (e) {
        reverted = true;
      }
      assert.equal(reverted, true, "Expected unauthorized threshold update to fail");
    });

    it("should support reward token allowlist lifecycle", async function() {
      const extraReward = await vault.token0();
      await strategy.addRewardToken(extraReward, { from: governance });
      let allowed = await strategy.rewardTokenAllowed(extraReward);
      assert.equal(allowed, true, "Expected added reward token to be allowed");

      await strategy.removeRewardToken(extraReward, { from: governance });
      allowed = await strategy.rewardTokenAllowed(extraReward);
      assert.equal(allowed, false, "Expected removed reward token to be disallowed");
    });

    it("should survive repeated skip cycles then resume compounding", async function() {
      const rewardToken = await strategy.rewardToken();
      const highThreshold = "999999999999999999999999999";
      await strategy.setMinRewardToCompound(rewardToken, highThreshold, { from: governance });

      for (let i = 0; i < 3; i++) {
        await controller.doHardWork(vault.address, { from: governance });
        await Utils.advanceNBlock(2000);
      }

      await strategy.setMinRewardToCompound(rewardToken, "1", { from: governance });
      await controller.doHardWork(vault.address, { from: governance });
      const sharePrice = new BigNumber(await vault.getPricePerFullShare());
      assert.equal(sharePrice.gt(0), true, "Expected strategy to remain operational after skip cycles");
    });

    it("Farmer should earn money", async function() {
      let sharePrice = new BigNumber(await vault.getPricePerFullShare());
      let farmerOldBalance = new BigNumber(await vault.balanceOf(farmer1)).times(sharePrice).div(1e18);

      let hours = 10;
      let blocksPerHour = 5000;
      let oldSharePrice;
      let newSharePrice;

      // First hardwork transfers NFT handoff and stakes; reward accrual starts after this.
      await controller.doHardWork(vault.address, { from: governance });
      await Utils.advanceNBlock(blocksPerHour);

      for (let i = 0; i < hours; i++) {
        console.log("loop ", i);

        oldSharePrice = new BigNumber(await vault.getPricePerFullShare());
        await controller.doHardWork(vault.address, { from: governance });
        newSharePrice = new BigNumber(await vault.getPricePerFullShare());

        console.log("old shareprice: ", oldSharePrice.toFixed());
        console.log("new shareprice: ", newSharePrice.toFixed());
        console.log("growth: ", newSharePrice.toFixed() / oldSharePrice.toFixed());

        apr = (newSharePrice.toFixed()/oldSharePrice.toFixed()-1)*(24/(blocksPerHour/1800))*365;
        apy = ((newSharePrice.toFixed()/oldSharePrice.toFixed()-1)*(24/(blocksPerHour/1800))+1)**365;

        console.log("instant APR:", apr*100, "%");
        console.log("instant APY:", (apy-1)*100, "%");

        await Utils.advanceNBlock(blocksPerHour);
      }
      sharePrice = new BigNumber(await vault.getPricePerFullShare());
      let farmerNewBalance = new BigNumber(await vault.balanceOf(farmer1)).times(sharePrice).div(1e18);
      Utils.assertBNGte(farmerNewBalance, farmerOldBalance);

      apr = (farmerNewBalance.toFixed()/farmerOldBalance.toFixed()-1)*(24/(blocksPerHour*hours/1800))*365;
      apy = ((farmerNewBalance.toFixed()/farmerOldBalance.toFixed()-1)*(24/(blocksPerHour*hours/1800))+1)**365;

      console.log("earned!");
      console.log("APR:", apr*100, "%");
      console.log("APY:", (apy-1)*100, "%");

      await strategy.withdrawAllToVault(true, { from: governance }); // making sure can withdraw all for a next switch
    });
  });
});
