// Integration tests for CLWrapper (single-asset ERC4626-style wrapper around CLVault).
// Covers both token0 and token1 orientations against the live Aerodrome cbETH/ETH1 pool.
const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const Strategy = artifacts.require("AerodromeCLStrategyMainnet_cbETH_ETH1");
const IERC721 = artifacts.require("IERC721");
const IERC20 = artifacts.require("IERC20Upgradeable");
const CLWrapper = artifacts.require("CLWrapper");

const BN = web3.utils.toBN;

describe("CLWrapper (cbETH/ETH1)", function() {
  this.timeout(2000000);

  let governance;
  const posId = 19447757;
  const posManager = "0x827922686190790b37229fd06084350E74485b72";
  let underlyingWhale = "0x6a74649aCFD7822ae8Fb78463a9f2192752E5Aa2";

  let controller;
  let vault;
  let strategy;
  let token0;
  let token1;
  let user1;
  let user2;

  before(async function() {
    governance = addresses.Governance;
    const accounts = await web3.eth.getAccounts();
    user1 = accounts[2];
    user2 = accounts[3];

    const nft = await IERC721.at(posManager);
    underlyingWhale = await nft.ownerOf(posId);

    await impersonates([governance, underlyingWhale]);
    for (const a of [governance, underlyingWhale, user1, user2]) {
      await hre.network.provider.request({
        method: "hardhat_setBalance",
        params: [a, "0x8AC7230489E80000"],
      });
    }

    if (underlyingWhale.toLowerCase() !== governance.toLowerCase()) {
      await nft.transferFrom(underlyingWhale, governance, posId, { from: underlyingWhale });
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

    // Open all lanes; cooldown 0; executor = governance.
    await vault.setLanePause(false, false, false, false, { from: governance });
    await vault.setRebalanceConfig(0, 0, governance, { from: governance });
  });

  // ---- helpers ----

  // Withdraw a slice of governance shares to liquidate the position into idle tokens, then move
  // the proceeds to `to`. Returns (dt0, dt1).
  async function fundUser(to, divisor) {
    const govShares = BN(await vault.balanceOf(governance));
    const slice = govShares.div(BN(divisor));
    if (slice.isZero()) throw new Error("share slice is zero");
    const t0Before = BN(await token0.balanceOf(governance));
    const t1Before = BN(await token1.balanceOf(governance));
    await vault.withdraw(slice.toString(), 0, 0, { from: governance });
    const dt0 = BN(await token0.balanceOf(governance)).sub(t0Before);
    const dt1 = BN(await token1.balanceOf(governance)).sub(t1Before);
    if (to.toLowerCase() !== governance.toLowerCase()) {
      if (dt0.gt(BN("0"))) await token0.transfer(to, dt0.toString(), { from: governance });
      if (dt1.gt(BN("0"))) await token1.transfer(to, dt1.toString(), { from: governance });
    }
    return { dt0, dt1 };
  }

  // ============================================================================================
  // token0 wrapper orientation
  // ============================================================================================

  describe("[asset = token0]", function() {
    let wrapper;

    before(async function() {
      wrapper = await CLWrapper.new(addresses.Storage, vault.address, true, { from: governance });
    });

    it("constructor wires asset/vault correctly", async function() {
      assert.equal((await wrapper.asset()).toLowerCase(), (await vault.token0()).toLowerCase());
      assert.equal((await wrapper.vault()).toLowerCase(), vault.address.toLowerCase());
    });

    it("totalAssets > 0 in steady state", async function() {
      const ta = BN(await wrapper.totalAssets());
      assert.equal(ta.gt(BN("0")), true, "expected non-zero NAV in token0 units");
    });

    it("deposit (single-arg) mints vault shares to receiver", async function() {
      // Fund user1 with token0 only.
      const { dt0 } = await fundUser(user1, 100);
      const t0Bal = BN(await token0.balanceOf(user1));
      assert.equal(t0Bal.gt(BN("0")), true);

      await token0.approve(wrapper.address, t0Bal.toString(), { from: user1 });
      const sharesBefore = BN(await vault.balanceOf(user1));
      const tx = await wrapper.methods["deposit(uint256,address)"](t0Bal.toString(), user1, { from: user1 });
      const sharesAfter = BN(await vault.balanceOf(user1));
      assert.equal(sharesAfter.gt(sharesBefore), true, "vault shares must mint to receiver");

      // Sanity: wrapper kept no leftover dust.
      assert.equal((await token0.balanceOf(wrapper.address)).toString(), "0");
      assert.equal((await token1.balanceOf(wrapper.address)).toString(), "0");
    });

    it("redeem (single-arg) returns asset to receiver", async function() {
      const userShares = BN(await vault.balanceOf(user1));
      assert.equal(userShares.gt(BN("0")), true, "user1 must hold shares from prior deposit");

      // user1 approves wrapper to pull their vault shares.
      await vault.approve(wrapper.address, userShares.toString(), { from: user1 });

      const t0Before = BN(await token0.balanceOf(user1));
      await wrapper.methods["redeem(uint256,address,address)"](userShares.toString(), user1, user1, { from: user1 });
      const t0After = BN(await token0.balanceOf(user1));
      const got0 = t0After.sub(t0Before);
      assert.equal(got0.gt(BN("0")), true, "expected token0 proceeds from redeem");

      // Wrapper should have no leftover dust.
      assert.equal((await token0.balanceOf(wrapper.address)).toString(), "0");
      assert.equal((await token1.balanceOf(wrapper.address)).toString(), "0");

      // user1 should have no shares left.
      assert.equal((await vault.balanceOf(user1)).toString(), "0");
    });

    it("deposit honours user-supplied minSharesOut (3-arg overload)", async function() {
      const { dt0 } = await fundUser(user1, 100);
      const t0Bal = BN(await token0.balanceOf(user1));
      await token0.approve(wrapper.address, t0Bal.toString(), { from: user1 });

      // Grossly inflated minSharesOut → must revert.
      const huge = BN("10").pow(BN("30"));
      let reverted = false;
      try {
        await wrapper.methods["deposit(uint256,address,uint256)"](t0Bal.toString(), user1, huge.toString(), { from: user1 });
      } catch (e) {
        reverted = true;
      }
      assert.equal(reverted, true, "expected revert on impossible minSharesOut");

      // Now do the same with minSharesOut=0 — must succeed.
      await wrapper.methods["deposit(uint256,address,uint256)"](t0Bal.toString(), user1, "0", { from: user1 });
      const u1Shares = BN(await vault.balanceOf(user1));
      assert.equal(u1Shares.gt(BN("0")), true);
    });

    it("redeem honours user-supplied minAssetsOut (4-arg overload)", async function() {
      const u1Shares = BN(await vault.balanceOf(user1));
      assert.equal(u1Shares.gt(BN("0")), true, "need shares for the test");

      await vault.approve(wrapper.address, u1Shares.toString(), { from: user1 });
      const huge = BN("10").pow(BN("30"));
      let reverted = false;
      try {
        await wrapper.methods["redeem(uint256,address,address,uint256)"](u1Shares.toString(), user1, user1, huge.toString(), { from: user1 });
      } catch (e) {
        reverted = true;
      }
      assert.equal(reverted, true, "expected revert on impossible minAssetsOut");

      // Loose mins → succeed.
      await wrapper.methods["redeem(uint256,address,address,uint256)"](u1Shares.toString(), user1, user1, "0", { from: user1 });
      assert.equal((await vault.balanceOf(user1)).toString(), "0");
    });
  });

  // ============================================================================================
  // token1 wrapper orientation (sanity)
  // ============================================================================================

  describe("[asset = token1]", function() {
    let wrapper;

    before(async function() {
      wrapper = await CLWrapper.new(addresses.Storage, vault.address, false, { from: governance });
    });

    it("constructor wires asset/vault correctly", async function() {
      assert.equal((await wrapper.asset()).toLowerCase(), (await vault.token1()).toLowerCase());
    });

    it("deposit + redeem round-trip works for token1 asset", async function() {
      // Fund user2 with token1 only.
      const { dt1 } = await fundUser(user2, 50);
      const t1Bal = BN(await token1.balanceOf(user2));
      assert.equal(t1Bal.gt(BN("0")), true);

      await token1.approve(wrapper.address, t1Bal.toString(), { from: user2 });
      await wrapper.methods["deposit(uint256,address)"](t1Bal.toString(), user2, { from: user2 });
      const u2Shares = BN(await vault.balanceOf(user2));
      assert.equal(u2Shares.gt(BN("0")), true, "expected vault shares from token1 deposit");

      // Redeem.
      await vault.approve(wrapper.address, u2Shares.toString(), { from: user2 });
      const t1Before = BN(await token1.balanceOf(user2));
      await wrapper.methods["redeem(uint256,address,address)"](u2Shares.toString(), user2, user2, { from: user2 });
      const got1 = BN(await token1.balanceOf(user2)).sub(t1Before);
      assert.equal(got1.gt(BN("0")), true, "expected token1 proceeds from token1-orientation redeem");
      assert.equal((await vault.balanceOf(user2)).toString(), "0");
    });
  });
});
