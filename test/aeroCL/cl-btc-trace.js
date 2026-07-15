// Step-by-step trace of a small wrapper.deposit on the BTC vault. Logs every relevant balance
// transition so we can prove where value goes / doesn't go.
const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const Strategy = artifacts.require("AerodromeCLStrategyMainnet_tBTC_cbBTC1");
const IERC721 = artifacts.require("IERC721");
const IERC20 = artifacts.require("IERC20Upgradeable");
const CLWrapper = artifacts.require("CLWrapper");

const BN = web3.utils.toBN;
const Q192 = BN("2").pow(BN("192"));

describe("BTC wrapper.deposit step-by-step trace", function() {
  this.timeout(2000000);

  let governance;
  let underlyingWhale;
  const posId = 19450559;
  const posManager = "0x827922686190790b37229fd06084350E74485b72";
  let vault, controller, strategy;
  let token0, token1; // tBTC, cbBTC
  let wrapper;
  let user;

  before(async function() {
    governance = addresses.Governance;
    const accs = await web3.eth.getAccounts();
    user = accs[7];

    const nft = await IERC721.at(posManager);
    underlyingWhale = await nft.ownerOf(posId);
    await impersonates([governance, underlyingWhale]);
    for (const a of [governance, underlyingWhale, user]) {
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

    await vault.setLanePause(false, false, false, false, { from: governance });
    await vault.setRebalanceConfig(0, 0, governance, { from: governance });

    wrapper = await CLWrapper.new(addresses.Storage, vault.address, true, { from: governance });
  });

  // valueInToken0 expressed at spot using sqrt² / 2^192. Both inputs are RAW units.
  function valInT0(t0, t1, sqrt) {
    const a0 = BN(t0);
    const a1 = BN(t1);
    if (a1.isZero()) return a0;
    // a1_in_t0 = a1 * 2^192 / sqrt²
    const sq = sqrt.mul(sqrt);
    return a0.add(a1.mul(Q192).div(sq));
  }

  it("now reverts with WrapperSwapBelowPrecision instead of silently losing 25% (asset=tBTC, 1/1000 size)", async function() {
    // Move governance to fund user; the deposit itself must revert.
    const slice = BN(await vault.balanceOf(governance)).div(BN("1000"));
    await vault.withdraw(slice.toString(), 0, 0, { from: governance });
    const dt0 = BN(await token0.balanceOf(governance));
    if (dt0.gt(BN("0"))) await token0.transfer(user, dt0.toString(), { from: governance });
    const Xtbtc = BN(await token0.balanceOf(user));
    await token0.approve(wrapper.address, Xtbtc.toString(), { from: user });
    let msg = "";
    try {
      await wrapper.methods["deposit(uint256,address,uint256)"](Xtbtc.toString(), user, "0", { from: user });
    } catch (e) {
      msg = String(e.message || e);
    }
    assert.equal(msg.includes("WrapperSwapBelowPrecision"), true,
      "expected the swap-precision guard to revert this deposit; got: " + msg);
    // user balance should be unchanged.
    assert.equal((await token0.balanceOf(user)).toString(), Xtbtc.toString(),
      "user balance must be intact after revert");
  });

  it("traces a deposit large enough to clear the precision guard (asset=tBTC, 1/10 size)", async function() {
    // 1. Fund user with a 1/10 NAV slice (~$1.6 in this fork — large enough to clear the
    //    swap-precision guard).
    const slice = BN(await vault.balanceOf(governance)).div(BN("10"));
    await vault.withdraw(slice.toString(), 0, 0, { from: governance });
    const dt0 = BN(await token0.balanceOf(governance));
    const dt1 = BN(await token1.balanceOf(governance));
    if (dt0.gt(BN("0"))) await token0.transfer(user, dt0.toString(), { from: governance });
    if (dt1.gt(BN("0"))) await token1.transfer(governance, dt1.toString(), { from: governance });

    const sqrtPre = BN(await vault.getSqrtPriceX96());
    const Xtbtc = BN(await token0.balanceOf(user));
    console.log("\n=== TRACE: wrapper.deposit at 1/1000 size, asset=tBTC ===");
    console.log("sqrtPriceX96               :", sqrtPre.toString());
    console.log("Pre-trace user tBTC raw    :", Xtbtc.toString());
    console.log("Pre-trace user cbBTC raw   :", (await token1.balanceOf(user)).toString());

    const userPreVal = valInT0(Xtbtc, BN(await token1.balanceOf(user)), sqrtPre);
    console.log("Pre-trace user value (tBTC):", userPreVal.toString());

    // 2. Approve and deposit. We don't snapshot wrapper-internal balances mid-deposit (no events
    //    for that), but we can log everything before and after.
    await token0.approve(wrapper.address, Xtbtc.toString(), { from: user });

    const wrapperT0Pre = BN(await token0.balanceOf(wrapper.address));
    const wrapperT1Pre = BN(await token1.balanceOf(wrapper.address));
    console.log("Pre-deposit wrapper tBTC   :", wrapperT0Pre.toString());
    console.log("Pre-deposit wrapper cbBTC  :", wrapperT1Pre.toString());

    const userSharesBefore = BN(await vault.balanceOf(user));
    const tx = await wrapper.methods["deposit(uint256,address,uint256)"](Xtbtc.toString(), user, "0", { from: user });
    const minted = BN(await vault.balanceOf(user)).sub(userSharesBefore);

    const userT0Post = BN(await token0.balanceOf(user));
    const userT1Post = BN(await token1.balanceOf(user));
    const wrapperT0Post = BN(await token0.balanceOf(wrapper.address));
    const wrapperT1Post = BN(await token1.balanceOf(wrapper.address));
    const sqrtPost = BN(await vault.getSqrtPriceX96());

    console.log("\n--- post-deposit ---");
    console.log("Shares minted to user      :", minted.toString());
    console.log("User tBTC after            :", userT0Post.toString());
    console.log("User cbBTC after           :", userT1Post.toString());
    console.log("Wrapper tBTC after         :", wrapperT0Post.toString());
    console.log("Wrapper cbBTC after        :", wrapperT1Post.toString());
    console.log("sqrtPriceX96 after         :", sqrtPost.toString());

    // 3. Compute user's total value post-deposit, valuing shares at PPS-in-tBTC.
    const ppsInT0Raw = BN(await vault.getPricePerFullShare()); // 1e18-scaled per-share value
    // wrapper.totalAssets / vault.totalSupply is the same metric expressed in asset units.
    const navInT0 = BN(await wrapper.totalAssets());
    const supply = BN(await vault.totalSupply());
    const userSharesValueInT0 = supply.gt(BN("0")) ? minted.mul(navInT0).div(supply) : BN("0");

    const userPostTokenVal = valInT0(userT0Post, userT1Post, sqrtPost);
    const userTotalPost = userPostTokenVal.add(userSharesValueInT0);

    console.log("\n--- value preservation ---");
    console.log("PPS (1e18-scaled)          :", ppsInT0Raw.toString());
    console.log("vault NAV in tBTC raw      :", navInT0.toString());
    console.log("vault totalSupply          :", supply.toString());
    console.log("user shares value (tBTC)   :", userSharesValueInT0.toString());
    console.log("user token-balance value   :", userPostTokenVal.toString());
    console.log("user TOTAL value (tBTC)    :", userTotalPost.toString());
    console.log("delta (post - pre)         :", userTotalPost.sub(userPreVal).toString());
    const lossBps = userPreVal.gt(BN("0")) && userPreVal.gte(userTotalPost)
      ? userPreVal.sub(userTotalPost).mul(BN("10000")).div(userPreVal).toNumber()
      : 0;
    console.log("economic loss (bps of pre) :", lossBps);

    // 4. Compare to convertToShares-based "haircut" metric the prior bench used.
    const cs = BN(await wrapper.convertToShares(Xtbtc.toString()));
    console.log("\n--- shares-haircut metric (the misleading one) ---");
    console.log("convertToShares(input)     :", cs.toString());
    console.log("minted                     :", minted.toString());
    if (cs.gt(BN("0"))) {
      const hairBps = cs.gte(minted) ? cs.sub(minted).mul(BN("10000")).div(cs).toNumber() : 0;
      console.log("shares haircut (bps)       :", hairBps);
    }
  });
});
