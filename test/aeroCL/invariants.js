const Utils = require("../utilities/Utils.js");
const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const Strategy = artifacts.require("AerodromeCLStrategyMainnet_cbETH_ETH1");
const IERC721 = artifacts.require("IERC721");
const IERC20 = artifacts.require("IERC20Upgradeable");

function bn(v) {
  return web3.utils.toBN(v.toString());
}

describe("CL invariants", function() {
  let governance;
  let posId = 19447757;
  let posManager = "0x827922686190790b37229fd06084350E74485b72";
  let controller;
  let vault;
  let strategy;

  async function assertCustodyInvariant() {
    const currentPosId = await vault.posId();
    const nft = await IERC721.at(posManager);
    const owner = await nft.ownerOf(currentPosId);
    const strategyAddr = await vault.strategy();
    const strat = await Strategy.at(strategyAddr);
    const gauge = await strat.rewardPool();
    const valid =
      owner.toLowerCase() === vault.address.toLowerCase() ||
      owner.toLowerCase() === strategyAddr.toLowerCase() ||
      owner.toLowerCase() === gauge.toLowerCase();
    assert.equal(valid, true, "NFT custody invariant violated");
  }

  before(async function() {
    governance = addresses.Governance;

    const nft = await IERC721.at(posManager);
    const owner = await nft.ownerOf(posId);

    await impersonates([governance, owner]);
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [governance, "0x8AC7230489E80000"],
    });
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [owner, "0x8AC7230489E80000"],
    });

    if (owner.toLowerCase() !== governance.toLowerCase()) {
      await nft.transferFrom(owner, governance, posId, { from: owner });
    }

    [controller, vault, strategy] = await setupCoreProtocol({
      CLVault: true,
      CLSetup: { posId, posManager, targetWidth: 1 },
      existingVaultAddress: null,
      strategyArtifact: Strategy,
      strategyArtifactIsUpgradable: true,
      governance,
    });

    await vault.setRebalanceConfig(0, 0, governance, { from: governance });
    await assertCustodyInvariant();
  });

  it("should preserve custody invariant across hardwork/rebalance cycles", async function() {
    for (let i = 0; i < 6; i++) {
      await controller.doHardWork(vault.address, { from: governance });
      try {
        await vault.rebalanceCurrentTick(1, { from: governance });
      } catch (e) {
        // No-op/market-state-dependent failures are acceptable; custody must still remain valid.
      }
      await assertCustodyInvariant();
      await Utils.advanceNBlock(500);
    }
  });

  it("should not mint free value through withdraw/redeposit churn", async function() {
    const token0 = await IERC20.at(await vault.token0());
    const token1 = await IERC20.at(await vault.token1());

    let pps = bn(await vault.getPricePerFullShare());
    let balance = bn(await vault.balanceOf(governance));
    let baselineValue = balance.mul(pps).div(bn("1000000000000000000"));

    for (let i = 0; i < 8; i++) {
      const sharesBefore = bn(await vault.balanceOf(governance));
      const withdrawShares = sharesBefore.div(bn((30 + i).toString()));
      if (withdrawShares.isZero()) {
        break;
      }

      const t0Before = bn(await token0.balanceOf(governance));
      const t1Before = bn(await token1.balanceOf(governance));

      await vault.withdraw(withdrawShares.toString(), 0, 0, { from: governance });

      const t0Amount = bn(await token0.balanceOf(governance)).sub(t0Before);
      const t1Amount = bn(await token1.balanceOf(governance)).sub(t1Before);
      await token0.approve(vault.address, t0Amount.toString(), { from: governance });
      await token1.approve(vault.address, t1Amount.toString(), { from: governance });
      await vault.deposit(t0Amount.toString(), t1Amount.toString(), 0, governance, { from: governance });

      pps = bn(await vault.getPricePerFullShare());
      balance = bn(await vault.balanceOf(governance));
      const currentValue = balance.mul(pps).div(bn("1000000000000000000"));
      const tolerance = baselineValue.div(bn("200000")); // 0.0005%
      assert.equal(
        currentValue.lte(baselineValue.add(tolerance)),
        true,
        "Churn increased account value beyond tolerance"
      );
      baselineValue = currentValue;
    }
  });
});
