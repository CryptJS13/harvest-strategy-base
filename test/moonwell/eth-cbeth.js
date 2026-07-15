// Utilities
const Utils = require("../utilities/Utils.js");
const {
  impersonates,
  setupCoreProtocol,
  depositVault,
} = require("../utilities/hh-utils.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");
const IERC20 = artifacts.require("IERC20");
const Vault = artifacts.require("VaultV2");

//const Strategy = artifacts.require("");
const Strategy = artifacts.require("Moonwell2AssetFoldStrategyMainnet_ETH_cbETH");

// Developed and tested at blockNumber 41792550

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Base Mainnet Moonwell Fold cbETH-ETH", function() {
  let accounts;

  // external contracts
  let underlying;

  // external setup
  let underlyingWhale = "0x3695D94c2db00Afb62f29Ffc995d775Ad0e0B4D5";
  let well = "0xA88594D404727625A9437C3f886C7643872296AE";
  let weth = "0x4200000000000000000000000000000000000006";
  let cbeth = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";

  // parties in the protocol
  let governance;
  let farmer1;

  // numbers used in tests
  let farmerBalance;

  // Core protocol contracts
  let controller;
  let vault;
  let strategy;

  async function setupExternalContracts() {
    underlying = await IERC20.at("0x4200000000000000000000000000000000000006");
    console.log("Fetching Underlying at: ", underlying.address);
  }

  async function setupBalance(){
    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: underlyingWhale, value: 10e18});

    farmerBalance = await underlying.balanceOf(underlyingWhale);
    await underlying.transfer(farmer1, farmerBalance, { from: underlyingWhale });
  }

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();

    farmer1 = accounts[1];

    // impersonate accounts
    await impersonates([governance, underlyingWhale]);

    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18});

    await setupExternalContracts();
    const newVaultImpl = await Vault.new();
    [controller, vault, strategy] = await setupCoreProtocol({
      "vaultImplementationOverride": newVaultImpl.address,
      "existingVaultAddress": null,
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "underlying": underlying,
      "governance": governance,
      "liquidation": [
        {"aeroCL": [well, weth, cbeth]},
        {"aeroCL": [weth, cbeth]},
        {"aeroCL": [cbeth, weth]},
      ],
    });

    // whale send underlying to farmers
    await setupBalance();
  });

  describe("Happy path", function() {
    it("Farmer should earn money", async function() {
      let farmerOldBalance = new BigNumber(await underlying.balanceOf(farmer1));
      await depositVault(farmer1, underlying, vault, farmerOldBalance.div(2));

      let hours = 10;
      let blocksPerHour = 3600;
      let oldSharePrice;
      let newSharePrice;

      for (let i = 0; i < hours; i++) {
        console.log("loop ", i);

        console.log("Making deposit:", farmerOldBalance.div(20).toFixed());
        await strategy.preInteract({from:governance}); // to accrue fee for a more precise APR calculation
        await depositVault(farmer1, underlying, vault, farmerOldBalance.div(20));

        // console.log("");
        // console.log("Doing hardwork...");
        // oldSharePrice = new BigNumber(await vault.getPricePerFullShare());
        // await controller.doHardWork(vault.address, { from: governance });
        // newSharePrice = new BigNumber(await vault.getPricePerFullShare());

        // console.log("old shareprice: ", oldSharePrice.toFixed());
        // console.log("new shareprice: ", newSharePrice.toFixed());
        // console.log("growth:         ", newSharePrice.toFixed() / oldSharePrice.toFixed());

        // apr = (newSharePrice.toFixed()/oldSharePrice.toFixed()-1)*(24/(blocksPerHour/1800))*365;
        // apy = ((newSharePrice.toFixed()/oldSharePrice.toFixed()-1)*(24/(blocksPerHour/1800))+1)**365;

        // console.log("instant APR:", apr*100, "%");
        // console.log("instant APY:", (apy-1)*100, "%");

        await Utils.advanceNBlock(blocksPerHour);
      }
      await vault.withdraw(new BigNumber(await vault.balanceOf(farmer1)).div(2).toFixed(), { from: farmer1 });
      await vault.withdraw(new BigNumber(await vault.balanceOf(farmer1)).toFixed(), { from: farmer1 });
      let farmerNewBalance = new BigNumber(await underlying.balanceOf(farmer1));

      apr = (farmerNewBalance.toFixed()/farmerOldBalance.toFixed()-1)*(24/(blocksPerHour*hours/1800))*365;
      apy = ((farmerNewBalance.toFixed()/farmerOldBalance.toFixed()-1)*(24/(blocksPerHour*hours/1800))+1)**365;

      console.log("earned!");
      console.log("APR:", apr*100, "%");
      console.log("APY:", (apy-1)*100, "%");

      await strategy.withdrawAllToVault({from:governance}); // making sure can withdraw all for a next switch
      Utils.assertBNGt(farmerNewBalance, farmerOldBalance);
    });
  });
});
