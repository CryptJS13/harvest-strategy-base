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
const IVault = artifacts.require("IVault");

const Strategy = artifacts.require("FortyAcresLendStrategyMainnet_USDC");

describe("Base Mainnet 40Acres Lend upgrade", function() {
  let accounts;

  let underlying;
  let governance;
  let farmer1;
  let farmerBalance;
  let controller;
  let vault;
  let strategy;
  let oldStrategyAddress;

  const existingVaultAddress = "0xC777031D50F632083Be7080e51E390709062263E";
  const underlyingWhale = "0x5750F0c01f82d366a25DE5B24B228a8EB870a406";

  async function setupExternalContracts() {
    underlying = await IERC20.at("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    console.log("Fetching Underlying at: ", underlying.address);
  }

  async function setupBalance() {
    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: underlyingWhale, value: 10e18 });

    farmerBalance = await underlying.balanceOf(underlyingWhale);
    await underlying.transfer(farmer1, farmerBalance, { from: underlyingWhale });
  }

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();
    farmer1 = accounts[1];

    await impersonates([governance, underlyingWhale]);

    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18 });

    await setupExternalContracts();

    vault = await IVault.at(existingVaultAddress);
    oldStrategyAddress = await vault.strategy();
    console.log("Existing strategy: ", oldStrategyAddress);

    [controller, vault, strategy] = await setupCoreProtocol({
      "existingVaultAddress": existingVaultAddress,
      "upgradeStrategy": true,
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "underlying": underlying,
      "governance": governance,
    });

    await setupBalance();
  });

  describe("Happy path", function() {
    it("upgrades in place and does not revert on fee handling when liquidity is constrained", async function() {
      const upgradedStrategyAddress = await vault.strategy();
      assert.equal(upgradedStrategyAddress, oldStrategyAddress, "strategy proxy address changed");
      assert.equal(strategy.address, oldStrategyAddress, "returned strategy is not the live proxy");

      const oldSharePrice = new BigNumber(await vault.getPricePerFullShare());
      await depositVault(farmer1, underlying, vault, farmerBalance);

      await controller.doHardWork(vault.address, { from: governance });
      await Utils.advanceNBlock(3600);
      await controller.doHardWork(vault.address, { from: governance });

      const newSharePrice = new BigNumber(await vault.getPricePerFullShare());
      const pendingFee = new BigNumber(await strategy.pendingFee());
      console.log("old shareprice: ", oldSharePrice.toFixed());
      console.log("new shareprice: ", newSharePrice.toFixed());
      console.log("pending fee: ", pendingFee.toFixed());

      assert.isTrue(
        newSharePrice.gte(oldSharePrice),
        "share price should not go down after upgrade hard work"
      );
      assert.isTrue(
        pendingFee.gt(0),
        "pending fee should stay accrued instead of reverting hard work"
      );
    });
  });
});
