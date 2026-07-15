// Wrapper haircut benchmark — for each (vault, asset side, deposit size) tuple, prints:
//   - pool fee (bps)
//   - non-asset weight (wOther) at current spot
//   - preview haircut bps     = (convertToShares - previewDeposit) / convertToShares × 10000
//   - real haircut bps        = (convertToShares - actualMinted)  / convertToShares × 10000
//   - real round-trip loss    = (input asset value - output asset value) / input × 10000
//
// Runs on cbETH/ETH1 (ETH-based) and tBTC/cbBTC1 (BTC-based) at FORK_BLOCK=32897925.
const { impersonates, setupCoreProtocol } = require("../utilities/hh-utils.js");
const addresses = require("../test-config.js");

const cbEthEthStrategy = artifacts.require("AerodromeCLStrategyMainnet_cbETH_ETH1");
const tbtcCbbtcStrategy = artifacts.require("AerodromeCLStrategyMainnet_tBTC_cbBTC1");
const IERC721 = artifacts.require("IERC721");
const IERC20 = artifacts.require("IERC20Upgradeable");
const CLWrapper = artifacts.require("CLWrapper");

const BN = web3.utils.toBN;

async function harness(label, posId, posManager, strategyArtifact) {
  describe(label, function() {
    this.timeout(2000000);
    let governance;
    let underlyingWhale;
    let vault, controller, strategy;
    let wrapperT0, wrapperT1;
    let token0, token1;
    let user;

    const rows = []; // collected per measurement

    before(async function() {
      governance = addresses.Governance;
      const accs = await web3.eth.getAccounts();
      user = accs[5];

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
        strategyArtifact,
        strategyArtifactIsUpgradable: true,
        governance,
      });

      token0 = await IERC20.at(await vault.token0());
      token1 = await IERC20.at(await vault.token1());

      await vault.setLanePause(false, false, false, false, { from: governance });
      await vault.setRebalanceConfig(0, 0, governance, { from: governance });

      wrapperT0 = await CLWrapper.new(addresses.Storage, vault.address, true, { from: governance });
      wrapperT1 = await CLWrapper.new(addresses.Storage, vault.address, false, { from: governance });
    });

    async function fundUserAsset(wrapper, divisor) {
      const govShares = BN(await vault.balanceOf(governance));
      const slice = govShares.div(BN(divisor));
      if (slice.isZero()) return BN("0");
      const t0Before = BN(await token0.balanceOf(governance));
      const t1Before = BN(await token1.balanceOf(governance));
      await vault.withdraw(slice.toString(), 0, 0, { from: governance });
      const dt0 = BN(await token0.balanceOf(governance)).sub(t0Before);
      const dt1 = BN(await token1.balanceOf(governance)).sub(t1Before);
      const isToken0 = await wrapper.asset() === await vault.token0();
      // Convert all to the asset side: swap the non-asset side for asset via the same wrapper's
      // UL would require deposit-then-redeem dance. Simpler: just give them whichever side we
      // got. For the haircut benchmark we only need the asset side balance, so dump the other.
      if (isToken0 && dt1.gt(BN("0"))) {
        await token1.transfer(addresses.Governance, dt1.toString(), { from: governance });
      }
      if (!isToken0 && dt0.gt(BN("0"))) {
        await token0.transfer(addresses.Governance, dt0.toString(), { from: governance });
      }
      const userT0Before = BN(await token0.balanceOf(user));
      const userT1Before = BN(await token1.balanceOf(user));
      if (isToken0 && dt0.gt(BN("0"))) await token0.transfer(user, dt0.toString(), { from: governance });
      if (!isToken0 && dt1.gt(BN("0"))) await token1.transfer(user, dt1.toString(), { from: governance });
      if (isToken0) return BN(await token0.balanceOf(user)).sub(userT0Before);
      return BN(await token1.balanceOf(user)).sub(userT1Before);
    }

    async function measure(wrapperLabel, wrapper, divisor) {
      const isToken0 = await wrapper.asset() === await vault.token0();
      const assetTok = isToken0 ? token0 : token1;
      const sizeAsset = await fundUserAsset(wrapper, divisor);
      if (sizeAsset.isZero()) return;

      const navBefore = BN(await wrapper.totalAssets());
      const fracBps = sizeAsset.mul(BN("10000")).div(navBefore.gt(BN("0")) ? navBefore : BN("1")).toNumber();

      const cs = BN(await wrapper.convertToShares(sizeAsset.toString()));
      const pd = BN(await wrapper.previewDeposit(sizeAsset.toString()));

      await assetTok.approve(wrapper.address, sizeAsset.toString(), { from: user });
      const userSharesBefore = BN(await vault.balanceOf(user));
      let minted = BN("0");
      let depositErr = null;
      try {
        await wrapper.methods["deposit(uint256,address,uint256)"](sizeAsset.toString(), user, "0", { from: user });
        minted = BN(await vault.balanceOf(user)).sub(userSharesBefore);
      } catch (e) {
        depositErr = String(e.message || e).split("\n")[0];
      }

      let got = BN("0");
      let redeemErr = null;
      if (minted.gt(BN("0"))) {
        await vault.approve(wrapper.address, minted.toString(), { from: user });
        const t0Before = BN(await token0.balanceOf(user));
        const t1Before = BN(await token1.balanceOf(user));
        try {
          await wrapper.methods["redeem(uint256,address,address,uint256)"](minted.toString(), user, user, "0", { from: user });
          const dt0 = BN(await token0.balanceOf(user)).sub(t0Before);
          const dt1 = BN(await token1.balanceOf(user)).sub(t1Before);
          got = isToken0 ? dt0 : dt1;
          const otherTok = isToken0 ? token1 : token0;
          const otherDust = isToken0 ? dt1 : dt0;
          if (otherDust.gt(BN("0"))) await otherTok.transfer(governance, otherDust.toString(), { from: user });
        } catch (e) {
          redeemErr = String(e.message || e).split("\n")[0];
        }
      }

      // Dump the user's leftover asset back to governance so it doesn't contaminate the next
      // iteration's NAV measurement.
      const userAssetLeftover = BN(await assetTok.balanceOf(user));
      if (userAssetLeftover.gt(BN("0"))) await assetTok.transfer(governance, userAssetLeftover.toString(), { from: user });

      const previewBps = cs.gt(BN("0")) ? cs.sub(pd).mul(BN("10000")).div(cs).toNumber() : 0;
      const realDepositBps = cs.gt(BN("0")) && cs.gte(minted)
        ? cs.sub(minted).mul(BN("10000")).div(cs).toNumber()
        : 0;
      const roundTripLossBps = sizeAsset.gt(BN("0")) && sizeAsset.gte(got)
        ? sizeAsset.sub(got).mul(BN("10000")).div(sizeAsset).toNumber()
        : 0;

      // Get pool fee + weights for context.
      const poolAddr = await wrapper.pool();
      const helperAddr = await vault.rebalanceHelper();
      const helper = await artifacts.require("CLRebalanceHelper").at(helperAddr);
      const feeHun = parseInt(await helper.poolFee(poolAddr));
      const feeBps = feeHun / 100;
      const weights = await vault.getCurrentTokenWeights();
      const w0 = parseFloat(weights[0].toString()) / 1e18;
      const w1 = parseFloat(weights[1].toString()) / 1e18;
      const wOther = isToken0 ? w1 : w0;

      rows.push({
        side: wrapperLabel,
        sizeOfNavBps: fracBps,
        sizeAsset: sizeAsset.toString(),
        poolFeeBps: feeBps,
        wOther: wOther.toFixed(4),
        previewHaircutBps: depositErr ? "ERR" : previewBps,
        realDepositHaircutBps: depositErr ? "deposit revert" : realDepositBps,
        roundTripLossBps: depositErr ? "—" : (redeemErr ? "redeem revert" : roundTripLossBps),
        depositErr,
        redeemErr,
      });
    }

    it("walks deposit sizes for both asset orientations", async function() {
      // Sizes in % of NAV: 0.01%, 0.1%, 1%, 10%, 25%
      const divisors = [10000, 1000, 100, 10, 4];
      for (const d of divisors) {
        await measure("asset=token0", wrapperT0, d);
        await measure("asset=token1", wrapperT1, d);
      }
    });

    after(function() {
      console.log("\n========================================");
      console.log("Haircut benchmark: " + label);
      console.log("========================================");
      console.log(
        "side          | size%NAV | poolFee | wOther | previewHaircut | realDepositHaircut | roundTripLoss"
      );
      console.log(
        "--------------|----------|---------|--------|----------------|--------------------|---------------"
      );
      for (const r of rows) {
        const sizePct = (r.sizeOfNavBps / 100).toFixed(3) + "%";
        console.log(
          r.side.padEnd(13) + " | " +
          sizePct.padStart(8) + " | " +
          (r.poolFeeBps + "bp").padStart(7) + " | " +
          r.wOther.padStart(6) + " | " +
          (r.previewHaircutBps + " bps").padStart(14) + " | " +
          (r.realDepositHaircutBps + " bps").padStart(18) + " | " +
          (r.roundTripLossBps + " bps").padStart(13)
        );
      }
      console.log("========================================\n");
    });
  });
}

harness("ETH-based [cbETH/ETH1]", 19447757, "0x827922686190790b37229fd06084350E74485b72", cbEthEthStrategy);
harness("BTC-based [tBTC/cbBTC1]", 19450559, "0x827922686190790b37229fd06084350E74485b72", tbtcCbbtcStrategy);
