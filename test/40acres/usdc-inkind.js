// Utilities
const Utils = require("../utilities/Utils.js");
const { impersonates } = require("../utilities/hh-utils.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");
const IERC20 = artifacts.require("IERC20");
const VaultV2InKind = artifacts.require("VaultV2InKind");
const VaultProxy = artifacts.require("VaultProxy");
const IUpgradeableStrategy = artifacts.require("IUpgradeableStrategy");

const Strategy = artifacts.require("FortyAcresLendStrategyMainnet_USDC");

// Fork block close to the chain head so the test sees the real illiquid pool state.
const FORK_BLOCK = 48873800;

const existingVaultAddress = "0xC777031D50F632083Be7080e51E390709062263E";
const existingStrategyAddress = "0x1d59868D7767d703929393bDaB313302840f533c";
const poolAddress = "0xB99B6dF96d4d5448cC0a5B3e0ef7896df9507Cf5";
const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const fusdcWhale = "0xD092a3165c9f18D35854C4B6cdcB4e2f1775A8D4";
const usdcWhale = "0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A";

describe("Base Mainnet 40Acres in-kind redemption upgrade", function() {
  let accounts;
  let governance;
  let farmer1;
  let receiver;

  let underlying;
  let poolShare;
  let vault;
  let strategy;

  before(async function() {
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [{
        forking: {
          jsonRpcUrl: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`,
          blockNumber: FORK_BLOCK,
        },
      }],
    });

    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();
    farmer1 = accounts[1];
    receiver = accounts[2];

    await impersonates([governance, fusdcWhale, usdcWhale]);

    const etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18 });
    await web3.eth.sendTransaction({ from: etherGiver, to: fusdcWhale, value: 10e18 });
    await web3.eth.sendTransaction({ from: etherGiver, to: usdcWhale, value: 10e18 });

    underlying = await IERC20.at(usdcAddress);
    poolShare = await IERC20.at(poolAddress);
    vault = await VaultV2InKind.at(existingVaultAddress);
    strategy = await Strategy.at(existingStrategyAddress);
  });

  describe("Upgrade and in-kind redemption", function() {
    let preUpgrade = {};

    it("upgrades strategy and vault in place, preserving state", async function() {
      preUpgrade.totalSupply = new BigNumber(await vault.totalSupply());
      preUpgrade.sharePrice = new BigNumber(await vault.getPricePerFullShare());
      preUpgrade.strategy = await vault.strategy();
      preUpgrade.underlying = await vault.underlying();
      preUpgrade.whaleShares = new BigNumber(await vault.balanceOf(fusdcWhale));
      preUpgrade.strategyPoolShares = new BigNumber(await poolShare.balanceOf(existingStrategyAddress));
      preUpgrade.pendingFee = new BigNumber(await strategy.pendingFee());

      assert.equal(preUpgrade.strategy, existingStrategyAddress);
      assert.isTrue(preUpgrade.whaleShares.gt(0), "test whale must hold vault shares");

      // Strategy upgrade through its own proxy timelock
      const newStrategyImpl = await Strategy.new();
      const strategyAsUpgradable = await IUpgradeableStrategy.at(existingStrategyAddress);
      await strategyAsUpgradable.scheduleUpgrade(newStrategyImpl.address, { from: governance });
      await Utils.waitHours(13);
      await strategyAsUpgradable.upgrade({ from: governance });

      // Vault upgrade through the vault proxy timelock
      const newVaultImpl = await VaultV2InKind.new();
      await vault.scheduleUpgrade(newVaultImpl.address, { from: governance });
      await Utils.waitHours(13);
      const vaultAsProxy = await VaultProxy.at(existingVaultAddress);
      await vaultAsProxy.upgrade({ from: governance });

      assert.equal(await vaultAsProxy.implementation(), newVaultImpl.address);
      assert.equal((await vault.totalSupply()).toString(), preUpgrade.totalSupply.toFixed());
      assert.equal((await vault.getPricePerFullShare()).toString(), preUpgrade.sharePrice.toFixed());
      assert.equal(await vault.strategy(), preUpgrade.strategy);
      assert.equal(await vault.underlying(), preUpgrade.underlying);
      assert.equal(await vault.redeemInKindEnabled(), false);
      assert.equal(await vault.inKindToken(), poolAddress);
    });

    it("normal withdrawals still revert while the pool has no liquidity", async function() {
      const shares = new BigNumber(await vault.balanceOf(fusdcWhale));
      let reverted = false;
      try {
        await vault.methods["withdraw(uint256)"](shares.toFixed(), { from: fusdcWhale });
      } catch (e) {
        reverted = true;
      }
      assert.isTrue(reverted, "large withdrawal should revert against the illiquid pool");
    });

    it("redeemInKind reverts while not enabled", async function() {
      let reverted = false;
      try {
        await vault.redeemInKind(1000000, fusdcWhale, fusdcWhale, { from: fusdcWhale });
      } catch (e) {
        reverted = true;
        assert.include(e.message, "In-kind redemptions not enabled");
      }
      assert.isTrue(reverted);
    });

    it("deposits keep working after enabling in-kind redemptions", async function() {
      const depositAmount = new BigNumber(10000e6);
      await underlying.approve(vault.address, depositAmount.toFixed(), { from: usdcWhale });
      const sharesBefore = new BigNumber(await vault.balanceOf(usdcWhale));
      await vault.methods["deposit(uint256)"](depositAmount.toFixed(), { from: usdcWhale });
      const sharesAfter = new BigNumber(await vault.balanceOf(usdcWhale));
      assert.isTrue(sharesAfter.gt(sharesBefore), "deposit should mint shares while disabled");

      await vault.setRedeemInKindEnabled(true, { from: governance });
      assert.equal(await vault.redeemInKindEnabled(), true);

      await underlying.approve(vault.address, depositAmount.toFixed(), { from: usdcWhale });
      await vault.methods["deposit(uint256)"](depositAmount.toFixed(), { from: usdcWhale });
      assert.isTrue(
        new BigNumber(await vault.balanceOf(usdcWhale)).gt(sharesAfter),
        "deposit should mint shares while in-kind redemptions are enabled"
      );
    });

    it("deposit then immediate redeemInKind is break-even (no value extraction)", async function() {
      // Let some pool yield accrue so the cached share price is stale, then verify a
      // deposit + immediate in-kind round trip cannot capture that drift.
      await Utils.advanceNBlock(1800);
      const attacker = usdcWhale;
      const depositAmount = new BigNumber(100000e6);
      const IERC4626 = artifacts.require("contracts/base/interface/IERC4626.sol:IERC4626");
      const pool = await IERC4626.at(poolAddress);

      const usdcBefore = new BigNumber(await underlying.balanceOf(attacker));
      const poolBefore = new BigNumber(await poolShare.balanceOf(attacker));
      const sharesBefore = new BigNumber(await vault.balanceOf(attacker));

      // ERC-4626 preview must match execution exactly even with stale drift (sync-on-quote)
      const previewShares = new BigNumber(await vault.previewDeposit(depositAmount.toFixed()));

      await underlying.approve(vault.address, depositAmount.toFixed(), { from: attacker });
      await vault.methods["deposit(uint256)"](depositAmount.toFixed(), { from: attacker });
      const minted = new BigNumber(await vault.balanceOf(attacker)).minus(sharesBefore);
      // preview and deposit run in different blocks; the pool rate rises every second, so
      // allow a sub-ppm drift (same-tx exactness is covered by the mint() test below)
      assert.isTrue(
        minted.minus(previewShares).abs().lte(previewShares.dividedToIntegerBy(1000000)),
        "previewDeposit must match actual mint within 1e-6"
      );
      await vault.redeemInKind(minted.toFixed(), attacker, attacker, { from: attacker });

      const usdcDelta = new BigNumber(await underlying.balanceOf(attacker)).minus(usdcBefore);
      const poolDelta = new BigNumber(await poolShare.balanceOf(attacker)).minus(poolBefore);
      const poolValue = new BigNumber(await pool.previewRedeem(poolDelta.toFixed()));
      const totalValueOut = usdcDelta.plus(poolValue); // usdcDelta is negative (net spent)

      console.log("deposited:            ", depositAmount.toFixed());
      console.log("net USDC delta:       ", usdcDelta.toFixed());
      console.log("pool shares received: ", poolDelta.toFixed());
      console.log("pool share value:     ", poolValue.toFixed());
      console.log("round trip P&L:       ", totalValueOut.toFixed());

      assert.isTrue(
        totalValueOut.lte(new BigNumber(1e6)),
        "round trip must not profit more than dust (1 USDC)"
      );
      assert.isTrue(
        totalValueOut.gte(new BigNumber(-100e6)),
        "round trip should not lose more than fees/rounding"
      );
    });

    it("mint() mints exactly the requested shares while the switch is on", async function() {
      await Utils.advanceNBlock(1800);
      const requestedShares = new BigNumber(1000e6);
      const previewAssets = new BigNumber(await vault.previewMint(requestedShares.toFixed()));
      await underlying.approve(vault.address, previewAssets.plus(1e6).toFixed(), { from: usdcWhale });
      const sharesBefore = new BigNumber(await vault.balanceOf(usdcWhale));
      await vault.mint(requestedShares.toFixed(), usdcWhale, { from: usdcWhale });
      const minted = new BigNumber(await vault.balanceOf(usdcWhale)).minus(sharesBefore);
      console.log("requested shares: ", requestedShares.toFixed());
      console.log("minted shares:    ", minted.toFixed());
      assert.isTrue(
        minted.minus(requestedShares).abs().lte(1),
        "mint must deliver the requested share count (within 1 wei rounding)"
      );
    });

    it("redeemInKind pays out the exact pro-rata slice of pool shares and idle underlying", async function() {
      const whaleShares = new BigNumber(await vault.balanceOf(fusdcWhale));
      const redeemShares = whaleShares.dividedToIntegerBy(2);
      const supplyBefore = new BigNumber(await vault.totalSupply());
      const idleBefore = new BigNumber(await underlying.balanceOf(vault.address));
      const strategyPoolBefore = new BigNumber(await poolShare.balanceOf(existingStrategyAddress));
      const sharePriceBefore = new BigNumber(await vault.getPricePerFullShare());

      const preview = await vault.previewRedeemInKind(redeemShares.toFixed());
      const previewAssets = new BigNumber(preview.assetsOut);
      const previewPoolShares = new BigNumber(preview.poolSharesOut);
      assert.isTrue(previewPoolShares.gt(0), "preview should include pool shares");

      const usdcBefore = new BigNumber(await underlying.balanceOf(fusdcWhale));
      const poolBefore = new BigNumber(await poolShare.balanceOf(fusdcWhale));

      await vault.redeemInKind(redeemShares.toFixed(), fusdcWhale, fusdcWhale, { from: fusdcWhale });

      const usdcReceived = new BigNumber(await underlying.balanceOf(fusdcWhale)).minus(usdcBefore);
      const poolReceived = new BigNumber(await poolShare.balanceOf(fusdcWhale)).minus(poolBefore);

      console.log("shares redeemed:      ", redeemShares.toFixed());
      console.log("USDC received:        ", usdcReceived.toFixed());
      console.log("pool shares received: ", poolReceived.toFixed());
      console.log("preview USDC:         ", previewAssets.toFixed());
      console.log("preview pool shares:  ", previewPoolShares.toFixed());

      assert.equal(usdcReceived.toFixed(), previewAssets.toFixed(), "USDC payout should match preview");
      assert.equal(poolReceived.toFixed(), previewPoolShares.toFixed(), "pool share payout should match preview");

      // Exact idle pro-rata
      const expectedIdle = idleBefore.times(redeemShares).dividedToIntegerBy(supplyBefore);
      assert.equal(usdcReceived.toFixed(), expectedIdle.toFixed(), "idle USDC payout should be pro-rata");

      // Pool share payout should be close to the gross pro-rata slice, slightly below due to the fee carve-out
      const grossProRata = strategyPoolBefore.times(redeemShares).dividedToIntegerBy(supplyBefore);
      assert.isTrue(poolReceived.lte(grossProRata), "payout must not exceed gross pro-rata slice");
      assert.isTrue(
        poolReceived.gte(grossProRata.times(995).dividedToIntegerBy(1000)),
        "payout should be within 0.5% of gross pro-rata slice"
      );

      // Shares burned
      assert.equal(
        new BigNumber(await vault.balanceOf(fusdcWhale)).toFixed(),
        whaleShares.minus(redeemShares).toFixed()
      );
      assert.equal(
        new BigNumber(await vault.totalSupply()).toFixed(),
        supplyBefore.minus(redeemShares).toFixed()
      );

      // Remaining holders must not be diluted
      const sharePriceAfter = new BigNumber(await vault.getPricePerFullShare());
      console.log("share price before:   ", sharePriceBefore.toFixed());
      console.log("share price after:    ", sharePriceAfter.toFixed());
      assert.isTrue(
        sharePriceAfter.gte(sharePriceBefore.times(9999).dividedToIntegerBy(10000)),
        "share price should not drop by more than 0.01%"
      );
    });

    it("supports third-party redemption via allowance", async function() {
      const redeemShares = new BigNumber(1000e6);
      await vault.approve(farmer1, redeemShares.toFixed(), { from: fusdcWhale });

      const poolBefore = new BigNumber(await poolShare.balanceOf(receiver));
      await vault.redeemInKind(redeemShares.toFixed(), receiver, fusdcWhale, { from: farmer1 });
      const poolReceived = new BigNumber(await poolShare.balanceOf(receiver)).minus(poolBefore);
      assert.isTrue(poolReceived.gt(0), "receiver should get pool shares");
      assert.equal(
        new BigNumber(await vault.allowance(fusdcWhale, farmer1)).toFixed(),
        "0",
        "allowance should be spent"
      );

      // without allowance it must revert
      let reverted = false;
      try {
        await vault.redeemInKind(redeemShares.toFixed(), farmer1, fusdcWhale, { from: farmer1 });
      } catch (e) {
        reverted = true;
      }
      assert.isTrue(reverted, "redeeming someone else's shares without allowance must revert");
    });

    it("keeps enough pool shares to back pending fees", async function() {
      const pendingFee = new BigNumber(await strategy.pendingFee());
      const strategyPoolShares = new BigNumber(await poolShare.balanceOf(existingStrategyAddress));
      // previewWithdraw rounds up: the shares needed to cover the pending fee
      const IERC4626 = artifacts.require("contracts/base/interface/IERC4626.sol:IERC4626");
      const pool = await IERC4626.at(poolAddress);
      const feeShares = new BigNumber(await pool.previewWithdraw(pendingFee.toFixed()));
      console.log("pending fee:           ", pendingFee.toFixed());
      console.log("fee backing needed:    ", feeShares.toFixed());
      console.log("strategy pool shares:  ", strategyPoolShares.toFixed());
      assert.isTrue(strategyPoolShares.gte(feeShares), "strategy must retain fee backing");
    });

    it("full remaining redemption by the whale empties their position", async function() {
      const remaining = new BigNumber(await vault.balanceOf(fusdcWhale));
      assert.isTrue(remaining.gt(0));
      await vault.redeemInKind(remaining.toFixed(), fusdcWhale, fusdcWhale, { from: fusdcWhale });
      assert.equal(new BigNumber(await vault.balanceOf(fusdcWhale)).toFixed(), "0");
    });

    it("disabling the switch blocks redeemInKind while deposits keep working", async function() {
      await vault.setRedeemInKindEnabled(false, { from: governance });
      assert.equal(await vault.redeemInKindEnabled(), false);

      let reverted = false;
      try {
        await vault.redeemInKind(1000000, usdcWhale, usdcWhale, { from: usdcWhale });
      } catch (e) {
        reverted = true;
      }
      assert.isTrue(reverted, "redeemInKind must revert when disabled");

      const depositAmount = new BigNumber(1000e6);
      await underlying.approve(vault.address, depositAmount.toFixed(), { from: usdcWhale });
      const sharesBefore = new BigNumber(await vault.balanceOf(usdcWhale));
      await vault.methods["deposit(uint256)"](depositAmount.toFixed(), { from: usdcWhale });
      assert.isTrue(
        new BigNumber(await vault.balanceOf(usdcWhale)).gt(sharesBefore),
        "deposits should keep working after disabling"
      );

      // governance-only guard
      reverted = false;
      try {
        await vault.setRedeemInKindEnabled(true, { from: usdcWhale });
      } catch (e) {
        reverted = true;
      }
      assert.isTrue(reverted, "only governance can toggle in-kind redemptions");
    });
  });
});
