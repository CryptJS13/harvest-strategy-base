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

//const Strategy = artifacts.require("");
const Strategy = artifacts.require("FluidLendStrategyMainnet_EURC");

// Developed and tested at blockNumber 43608200

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Mainnet Fluid Lend EURC upgrade rewards", function() {
  let accounts;

  // external contracts
  let underlying;

  // external setup
  let underlyingWhale = "0x8e598D2b619100c7eb9051aB274773490c129edb";
  let fluidWhale = "0x9111a0197D48d9064D279c19cFBEb6015909d3F4";
  let usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  let eurc = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42";
  let weth = "0x4200000000000000000000000000000000000006";
  let fluid = "0x61E030A56D33e8260FdD81f03B162A79Fe3449Cd";
  let fluidToken;

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
    underlying = await IERC20.at("0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42");
    console.log("Fetching Underlying at: ", underlying.address);
    fluidToken = await IERC20.at(fluid);
  }

  async function setupBalance(){
    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: underlyingWhale, value: 10e18});
    await web3.eth.sendTransaction({ from: etherGiver, to: fluidWhale, value: 10e18});

    farmerBalance = await underlying.balanceOf(underlyingWhale);
    await underlying.transfer(farmer1, farmerBalance, { from: underlyingWhale });
  }

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();

    farmer1 = accounts[1];

    // impersonate accounts
    await impersonates([governance, underlyingWhale, addresses.ULOwner, fluidWhale]);

    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18});
    await web3.eth.sendTransaction({ from: etherGiver, to: addresses.ULOwner, value: 10e18});

    await setupExternalContracts();
    [controller, vault, strategy] = await setupCoreProtocol({
      "existingVaultAddress": "0x96716C274F66C8A17a8574825904D19C5804e54b",
      "upgradeStrategy": true,
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "underlying": underlying,
      "governance": governance,
      "ULOwner": addresses.ULOwner,
      "liquidation": [
        {"uniV3": [fluid, weth]},
        {"uniV3": [fluid, weth, usdc, eurc]},
      ],
      "uniV3Fee": [
        [fluid, weth, 10000],
      ],
    });

    // whale send underlying to farmers
    await setupBalance();
  });

  describe("Happy path", function() {
    it("Farmer should earn money", async function() {
      let farmerOldBalance = new BigNumber(await underlying.balanceOf(farmer1));
      await depositVault(farmer1, underlying, vault, farmerBalance);

      let hours = 10;
      let blocksPerHour = 2400;
      let oldSharePrice;
      let newSharePrice;

      console.log(strategy.address);

      await strategy.claim(
        "0x94312a608246Cecfce6811Db84B3Ef4B2619054E",
        "132721104406988110555",
        1,
        "0x0000000000000000000000001943fa26360f038230442525cf1b9125b5dcb401",
        737,
        [
          "0xf7e30614983a720cd95844cb343f95c13eac175447a0d91f2e545f3438190f74",
          "0xf182833399b3d158ef03257ccdd9b7b8b313fcd7fc1c54aa20f67560683017e0",
          "0x7b656900d5e948def8c14199e6c42a25ad43f6306ea2dc532f86d8bb7d1a5416",
          "0xdf7cc4ad614b38e43e282bad85705b3ecf605a474a9097f6d4516395095249c0",
          "0x0d74d584ef6f6c17f5a33c6e4a0132d3723eee054b94191512587518fba3d958",
          "0xcf13e753094954c684fa871ff1a64b9c640ac59a055ac3a7e21f5cf656d22eeb",
          "0x23216a39ec00ae5a8d203acc11c9ebaaacdeecb15c54af1f4c476964e498ed93",
          "0x4660908c2241da1b550d725391e6623854b9be97e6945e300847b4f40177768f",
          "0xc29f90e6d81947482fba17ef384df99e9f4c00224817622762956137c5b62dcb",
          "0x5a8cb5ffee8b30d1f14e45a80ae52dc081aef91de0ae01a37fca290428edb742",
          "0x13f18504cf6e31bbeb20581f12d283f5675002a4e1a5354aac3f4490a7392eb9",
          "0x0980cb0f19179f9b251a4486ee852a7d2f843934156eaf1f650c66006f990603",
          "0x0531a6306f4f94df9338af49358d85bbe4f30b1b359b678aa25420ef933654cc",
          "0x75edf8dce3fa7fd22dbbeea8cd44ca386797f23bd102ec7cb1e1c0380797fe47"
        ],
        "0x"  
      )

      for (let i = 0; i < hours; i++) {
        console.log("loop ", i);

        await fluidToken.transfer(strategy.address, new BigNumber(10e18).toFixed(), {from: fluidWhale});

        oldSharePrice = new BigNumber(await vault.getPricePerFullShare());
        await controller.doHardWork(vault.address, { from: governance });
        newSharePrice = new BigNumber(await vault.getPricePerFullShare());

        console.log("old shareprice: ", oldSharePrice.toFixed());
        console.log("new shareprice: ", newSharePrice.toFixed());
        console.log("growth: ", newSharePrice.toFixed() / oldSharePrice.toFixed());

        apr = (newSharePrice.toFixed()/oldSharePrice.toFixed()-1)*(24/(blocksPerHour/300))*365;
        apy = ((newSharePrice.toFixed()/oldSharePrice.toFixed()-1)*(24/(blocksPerHour/300))+1)**365;

        console.log("instant APR:", apr*100, "%");
        console.log("instant APY:", (apy-1)*100, "%");

        await Utils.advanceNBlock(blocksPerHour);
      }
      await vault.withdraw(new BigNumber(await vault.balanceOf(farmer1)).toFixed(), { from: farmer1 });
      let farmerNewBalance = new BigNumber(await underlying.balanceOf(farmer1));
      Utils.assertBNGt(farmerNewBalance, farmerOldBalance);

      apr = (farmerNewBalance.toFixed()/farmerOldBalance.toFixed()-1)*(24/(blocksPerHour*hours/300))*365;
      apy = ((farmerNewBalance.toFixed()/farmerOldBalance.toFixed()-1)*(24/(blocksPerHour*hours/300))+1)**365;

      console.log("earned!");
      console.log("APR:", apr*100, "%");
      console.log("APY:", (apy-1)*100, "%");

      await strategy.withdrawAllToVault({from:governance}); // making sure can withdraw all for a next switch

    });
  });
});
