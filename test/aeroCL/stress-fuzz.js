const Utils = require("../utilities/Utils.js");
const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const Strategy = artifacts.require("AerodromeCLStrategyMainnet_cbETH_ETH1");
const IERC721 = artifacts.require("IERC721");
const IERC20 = artifacts.require("IERC20Upgradeable");

function bn(v) {
  return web3.utils.toBN(v.toString());
}

describe("CL stress fuzz (fork)", function() {
  let governance;
  let posId = 19447757;
  let posManager = "0x827922686190790b37229fd06084350E74485b72";
  let controller;
  let vault;
  let strategy;
  let token0;
  let token1;

  let seed = 0xC0FFEE42;
  function nextRand(max) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % max;
  }

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

  async function withdrawAndRedeposit(shareDivisor) {
    const sharesBefore = bn(await vault.balanceOf(governance));
    if (sharesBefore.lte(bn("10"))) {
      return;
    }
    const withdrawShares = sharesBefore.div(bn(shareDivisor.toString()));
    if (withdrawShares.isZero()) {
      return;
    }

    const t0Before = bn(await token0.balanceOf(governance));
    const t1Before = bn(await token1.balanceOf(governance));
    await vault.withdraw(withdrawShares.toString(), 0, 0, { from: governance });
    const amount0 = bn(await token0.balanceOf(governance)).sub(t0Before);
    const amount1 = bn(await token1.balanceOf(governance)).sub(t1Before);
    await token0.approve(vault.address, amount0.toString(), { from: governance });
    await token1.approve(vault.address, amount1.toString(), { from: governance });
    await vault.deposit(amount0.toString(), amount1.toString(), 0, governance, { from: governance });
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

    token0 = await IERC20.at(await vault.token0());
    token1 = await IERC20.at(await vault.token1());
    await vault.setRebalanceConfig(0, 0, governance, { from: governance });
    await assertCustodyInvariant();
  });

  it("should survive randomized mixed operations while preserving core invariants", async function() {
    const unit = bn("1000000000000000000");
    let baselineValue = bn(await vault.balanceOf(governance))
      .mul(bn(await vault.getPricePerFullShare()))
      .div(unit);

    for (let i = 0; i < 24; i++) {
      const action = nextRand(6);

      if (action === 0) {
        await controller.doHardWork(vault.address, { from: governance });
      } else if (action === 1) {
        try {
          await vault.rebalanceCurrentTick(1, { from: governance });
        } catch (e) {
          // Tick/state dependent.
        }
      } else if (action === 2) {
        await withdrawAndRedeposit(20 + nextRand(40));
      } else if (action === 3) {
        await withdrawAndRedeposit(2 + nextRand(3)); // near-full and half-ish withdraw cycles
      } else if (action === 4) {
        const rewardToken = await strategy.rewardToken();
        await strategy.setMinRewardToCompound(rewardToken, (1 + nextRand(100000)).toString(), { from: governance });
      } else {
        await Utils.advanceNBlock(200 + nextRand(2000));
      }

      const shares = bn(await vault.balanceOf(governance));
      const pps = bn(await vault.getPricePerFullShare());
      const currentValue = shares.mul(pps).div(unit);

      assert.equal(shares.gt(bn("0")), true, "share balance dropped to zero unexpectedly");
      assert.equal(pps.gt(bn("0")), true, "PPS must remain positive");
      await assertCustodyInvariant();

      const inflationTolerance = baselineValue.div(bn("1000")); // 0.1%
      assert.equal(
        currentValue.lte(baselineValue.add(inflationTolerance)),
        true,
        "Randomized loop created unexpected value inflation"
      );
      baselineValue = currentValue;
    }
  });

  it("should handle edge share amounts (1-share and near-full) without invariant break", async function() {
    const unit = bn("1000000000000000000");
    let initialValue = bn(await vault.balanceOf(governance))
      .mul(bn(await vault.getPricePerFullShare()))
      .div(unit);

    for (let i = 0; i < 6; i++) {
      const shares = bn(await vault.balanceOf(governance));
      if (shares.lte(bn("3"))) {
        break;
      }

      const tinyCandidates = [
        bn("1"),
        shares.div(bn("1000000")),
        shares.div(bn("10000")),
        shares.div(bn("100")),
      ];
      let tiny = bn("0");
      for (let j = 0; j < tinyCandidates.length; j++) {
        if (tinyCandidates[j].gt(bn("0"))) {
          tiny = tinyCandidates[j];
          break;
        }
      }
      if (tiny.isZero()) {
        break;
      }
      const t0BeforeTiny = bn(await token0.balanceOf(governance));
      const t1BeforeTiny = bn(await token1.balanceOf(governance));
      let withdrewTiny = false;
      for (let j = 0; j < tinyCandidates.length; j++) {
        const candidate = tinyCandidates[j];
        if (candidate.isZero()) {
          continue;
        }
        try {
          await vault.withdraw(candidate.toString(), 0, 0, { from: governance });
          tiny = candidate;
          withdrewTiny = true;
          break;
        } catch (e) {}
      }
      if (!withdrewTiny) {
        await controller.doHardWork(vault.address, { from: governance });
        await assertCustodyInvariant();
        continue;
      }
      const t0Tiny = bn(await token0.balanceOf(governance)).sub(t0BeforeTiny);
      const t1Tiny = bn(await token1.balanceOf(governance)).sub(t1BeforeTiny);
      await token0.approve(vault.address, t0Tiny.toString(), { from: governance });
      await token1.approve(vault.address, t1Tiny.toString(), { from: governance });
      try {
        await vault.deposit(t0Tiny.toString(), t1Tiny.toString(), 0, governance, { from: governance });
      } catch (e) {
        // dust amounts may round to zero shares — vault rejects with ErrZeroShares
        if (!String(e.message || e).includes("ErrZeroShares")) throw e;
      }

      const sharesMid = bn(await vault.balanceOf(governance));
      const nearFull = sharesMid.mul(bn("97")).div(bn("100"));
      if (nearFull.gt(bn("0"))) {
        const t0BeforeLarge = bn(await token0.balanceOf(governance));
        const t1BeforeLarge = bn(await token1.balanceOf(governance));
        await vault.withdraw(nearFull.toString(), 0, 0, { from: governance });
        const t0Large = bn(await token0.balanceOf(governance)).sub(t0BeforeLarge);
        const t1Large = bn(await token1.balanceOf(governance)).sub(t1BeforeLarge);
        await token0.approve(vault.address, t0Large.toString(), { from: governance });
        await token1.approve(vault.address, t1Large.toString(), { from: governance });
        await vault.deposit(t0Large.toString(), t1Large.toString(), 0, governance, { from: governance });
      }

      await controller.doHardWork(vault.address, { from: governance });
      await assertCustodyInvariant();
    }

    const finalValue = bn(await vault.balanceOf(governance))
      .mul(bn(await vault.getPricePerFullShare()))
      .div(unit);
    const tolerance = initialValue.div(bn("1000")); // 0.1%
    assert.equal(
      finalValue.lte(initialValue.add(tolerance)),
      true,
      "Edge-case churn produced unexpected value inflation"
    );
  });
});
