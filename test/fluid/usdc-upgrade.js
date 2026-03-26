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
const Strategy = artifacts.require("FluidLendStrategyMainnet_USDC");

// Developed and tested at blockNumber 43608200

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Mainnet Fluid Lend USDC upgrade rewards", function() {
  let accounts;

  // external contracts
  let underlying;

  // external setup
  let underlyingWhale = "0xDDC976cB693fDa9c7570eC68Df397623E48815e9";
  let fluidWhale = "0x9111a0197D48d9064D279c19cFBEb6015909d3F4";
  let usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
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
    underlying = await IERC20.at("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
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
      "existingVaultAddress": "0xD9e38d724CC5ee983BC0Fd0Ce35C3eB20417b673",
      "upgradeStrategy": true,
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "underlying": underlying,
      "governance": governance,
      "ULOwner": addresses.ULOwner,
      "liquidation": [
        {"uniV3": [fluid, weth]},
        {"uniV3": [fluid, weth, usdc]},
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
        "2078858741131574216",
        1,
        "0x000000000000000000000000f42f5795d9ac7e9d757db633d693cd548cfd9169",
        737,
        [
          "0xfd0957addaaa561483dac10bbda0e204f34692fdb0aa23af329493c7f16e51c6",
          "0xd91901b2b5a62ab9754ff408883327417b777412977e452942ea66ae625641fa",
          "0x7f22bd23bad7b8489ef343d1ae57bd3e596d43ce940daf28db8cd63e2283a50f",
          "0x70e1ec79d1fde2e488f8ed201dcceeb33c4dda07e2dbda7c659e88a5a70144a5",
          "0xad561c0ed289155dbb63654bff07d399f36ede48f77856f79d1b941d3d53bbc3",
          "0x88360ff2115593081ee9e1aecfd7f2a74ab6404c50b8ef7b9978b5402c388f32",
          "0x38c816f2f5b957cc2f574db75ca65baefa38a951b0fdb0651d3d7ed924ea40f5",
          "0x72ba12d0ef254c62fea23a4517783281f4c29da432a6e832810a660b2fe8fee1",
          "0x990faf51dd70ec96d4b552534edccf649e13c14d396c6da9f093187b35acb2be",
          "0xc14aa2e0251d24af28726b88cfdea85c786947b62aa6a1e220b8926b32f5294c",
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
