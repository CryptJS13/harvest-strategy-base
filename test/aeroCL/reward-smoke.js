const Utils = require("../utilities/Utils.js");
const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const Strategy = artifacts.require("AerodromeCLStrategyMainnet_cbETH_ETH1");
const IERC721 = artifacts.require("IERC721");

describe("CL reward smoke", function () {
  let governance;
  let underlyingWhale = "0x6a74649aCFD7822ae8Fb78463a9f2192752E5Aa2";
  const posId = 19447757;
  const posManager = "0x827922686190790b37229fd06084350E74485b72";
  let controller;
  let vault;

  before(async function () {
    governance = addresses.Governance;

    const nftToken = await IERC721.at(posManager);
    underlyingWhale = await nftToken.ownerOf(posId);

    await impersonates([governance, underlyingWhale]);
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [governance, "0x8AC7230489E80000"],
    });
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [underlyingWhale, "0x8AC7230489E80000"],
    });

    if (underlyingWhale.toLowerCase() !== governance.toLowerCase()) {
      await nftToken.transferFrom(underlyingWhale, governance, posId, { from: underlyingWhale });
    }

    [controller, vault] = await setupCoreProtocol({
      CLVault: true,
      CLSetup: { posId, posManager, targetWidth: 1 },
      existingVaultAddress: null,
      strategyArtifact: Strategy,
      strategyArtifactIsUpgradable: true,
      governance,
    });
  });

  it("should increase share value after staking interval and compound", async function () {
    const oldPps = web3.utils.toBN(await vault.getPricePerFullShare());
    const oldShares = web3.utils.toBN(await vault.balanceOf(governance));
    const oldValue = oldShares.mul(oldPps);

    await controller.doHardWork(vault.address, { from: governance }); // stake path
    await Utils.advanceNBlock(2000); // accrue emissions
    await controller.doHardWork(vault.address, { from: governance }); // claim + compound + restake

    const newPps = web3.utils.toBN(await vault.getPricePerFullShare());
    const newShares = web3.utils.toBN(await vault.balanceOf(governance));
    const newValue = newShares.mul(newPps);

    assert.equal(newValue.gt(oldValue), true, "Expected positive value growth from gauge rewards");
  });
});
