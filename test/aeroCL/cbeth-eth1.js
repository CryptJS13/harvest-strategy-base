// Utilities
const Utils = require("../utilities/Utils.js");
const {
  impersonates,
  setupCoreProtocol,
} = require("../utilities/hh-utils.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");

//const Strategy = artifacts.require("");
const Strategy = artifacts.require("AerodromeCLStrategyMainnet_cbETH_ETH1");
const IERC721 = artifacts.require("IERC721");

// Developed and tested at blockNumber 32896930

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("CL test", function() {
  let accounts;

  // external setup
  let underlyingWhale = "0x6a74649aCFD7822ae8Fb78463a9f2192752E5Aa2";
  let posId = 19447757
  let posManager = "0x827922686190790b37229fd06084350E74485b72";
//   let aero = "0x940181a94A35A4569E4529A3CDfB74e38FD98631"
//   let superoeth = "0xDBFeFD2e8460a6Ee4955A68582F85708BAEA60A3"

  // parties in the protocol
  let governance;
  let farmer1;

  // Core protocol contracts
  let controller;
  let vault;
  let strategy;

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();

    farmer1 = governance;

    const nftToken = await IERC721.at(posManager);
    const actualOwner = await nftToken.ownerOf(posId);
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

    it("Farmer should earn money", async function() {
      let sharePrice = new BigNumber(await vault.getPricePerFullShare());
      let farmerOldBalance = new BigNumber(await vault.balanceOf(farmer1)).times(sharePrice).div(1e18);

      let hours = 10;
      let blocksPerHour = 3600;
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
