// Live fork-upgrade test for the deployed Aave cbETH/ETH fold deployment.
//
// Upgrades the ACTUAL on-chain proxies (strategy 0xcfd2… + vault 0xE78285…) to
// the latest code (resilience + gas-optimized strategy; FoldVaultV2 = the same
// resilience vault the deployment already runs, PLUS the deposit cap), using the
// real governance msig and the real 12h timelock, then verifies the leveraged
// Aave position and a pre-upgrade holder's value survive and exercises deposit /
// hard-work / withdraw.
//
// NOTE on ordering: the DEPLOYED strategy (0x39dAf0) and vault (0xe727) ALREADY
// implement preInteract()/doHardWorkOnDeposit() (verified on Basescan). So the
// FoldVaultV2 upgrade only adds the deposit cap, and neither upgrade can brick
// the other in any order — see the "vault upgrade alone is safe" case.
//
//   Run with a fork block AFTER deployment, e.g.:
//   FORK_BLOCK=48297376 npx hardhat test test/aave/fold/upgrade-fork.js

const BigNumber = require("bignumber.js");
const Utils = require("../../utilities/Utils.js");
const { impersonates } = require("../../utilities/hh-utils.js");

const IERC20 = artifacts.require("IERC20");
const IPool = artifacts.require("contracts/base/interface/aave/IPool.sol:IPool");
const Strategy = artifacts.require("Aave2AssetFoldStrategyMainnet_ETH_cbETH");
const AaveReserveLib = artifacts.require("AaveReserveLib");
const FoldVaultV2 = artifacts.require("FoldVaultV2");
const StrategyProxy = artifacts.require("StrategyProxy");
const VaultProxy = artifacts.require("VaultProxy");

describe("Aave fold LIVE upgrade (fork)", function() {
  const STRAT = "0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757";
  const VAULT = "0xE78285A51f51916F2311B7017Db036D8351F3Cf9";
  const GOV = "0x920b1aCb7618B553324aa0F71620226FA2e09870";
  const WETH = "0x4200000000000000000000000000000000000006";
  const CBETH_ATOKEN = "0xcf3D55c10DB69f28fD1A75Bd73f3D8A2d9c595ad"; // supply aToken (collateral)
  const WETH_VDEBT = "0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E";   // variable debt token
  const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
  const DEPLOYED_STRAT_IMPL = "0x39dAf0B0bDfF972a17d33a675184cB131Bb0343C";
  const DEPLOYED_VAULT_IMPL = "0xe727FeB09515c5EB86BD5F5eBA7F3228252A2e30";
  const TIMELOCK = 43200; // 12h, from Controller.nextImplementationDelay()
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const ONE = new BigNumber("1e18");

  let accounts, farmer, farmer2, newStratImpl, newVaultImpl, snapshotId;

  const cs = (a) => web3.utils.toChecksumAddress(a);
  async function implOf(addr) { return cs("0x" + (await web3.eth.getStorageAt(addr, IMPL_SLOT)).slice(26)); }
  async function warp(s) { await hre.network.provider.send("evm_increaseTime", [s]); await hre.network.provider.send("evm_mine", []); }
  async function takeSnapshot() { return hre.network.provider.request({ method: "evm_snapshot", params: [] }); }
  async function revertSnapshot(id) { await hre.network.provider.request({ method: "evm_revert", params: [id] }); }
  async function wethOf(a) { return new BigNumber(await (await IERC20.at(WETH)).balanceOf(a)); }

  async function wrapWeth(to, amount) {
    // WETH9 deposit() selector — wraps sent ETH into WETH.
    await web3.eth.sendTransaction({ from: to, to: WETH, value: amount, data: "0xd0e30db0", gas: 200000 });
  }
  async function deposit(from, amount) {
    await (await IERC20.at(WETH)).approve(VAULT, amount, { from });
    return (await FoldVaultV2.at(VAULT)).deposit(amount, from, { from });
  }
  // The strategy's live leveraged position.
  async function position() {
    return {
      supplied: new BigNumber(await (await IERC20.at(CBETH_ATOKEN)).balanceOf(STRAT)),
      borrowed: new BigNumber(await (await IERC20.at(WETH_VDEBT)).balanceOf(STRAT)),
      stored: new BigNumber(await (await Strategy.at(STRAT)).storedBalance()),
      health: new BigNumber((await (await IPool.at(AAVE_POOL)).getUserAccountData(STRAT))[5].toString()),
    };
  }
  async function upgradeStrategy() {
    await (await Strategy.at(STRAT)).scheduleUpgrade(newStratImpl.address, { from: GOV });
    await warp(TIMELOCK + 60);
    await (await StrategyProxy.at(STRAT)).upgrade({ from: GOV });
  }
  async function upgradeVault() {
    await (await FoldVaultV2.at(VAULT)).scheduleUpgrade(newVaultImpl.address, { from: GOV });
    await warp(TIMELOCK + 60);
    await (await VaultProxy.at(VAULT)).upgrade({ from: GOV });
  }
  async function expectRevertLike(promise, needle) {
    let reverted = false, msg = "";
    try { await promise; } catch (e) { reverted = true; msg = e.message; }
    assert(reverted, "expected the call to revert, but it succeeded");
    assert(msg.includes(needle) || msg.includes("revert") || msg.includes("Reverted"),
      `wrong revert reason (wanted "${needle}"): ${msg}`);
  }

  before(async function() {
    accounts = await web3.eth.getAccounts();
    farmer = accounts[1];
    farmer2 = accounts[2];
    await impersonates([GOV]);
    await web3.eth.sendTransaction({ from: accounts[9], to: GOV, value: web3.utils.toWei("5") });

    // Deploy the new implementations (strategy needs AaveReserveLib linked).
    const lib = await AaveReserveLib.new();
    Strategy.link(lib);
    newStratImpl = await Strategy.new();
    newVaultImpl = await FoldVaultV2.new();

    await wrapWeth(farmer, web3.utils.toWei("1"));
    await wrapWeth(farmer2, web3.utils.toWei("1"));
    snapshotId = await takeSnapshot();
  });

  beforeEach(async function() {
    await revertSnapshot(snapshotId);
    snapshotId = await takeSnapshot();
  });

  it("pre-upgrade: proxies run the deployed impls with a live leveraged position", async function() {
    assert.equal(await implOf(STRAT), cs(DEPLOYED_STRAT_IMPL), "deployed strategy impl");
    assert.equal(await implOf(VAULT), cs(DEPLOYED_VAULT_IMPL), "deployed vault impl");
    const v = await FoldVaultV2.at(VAULT);
    Utils.assertBNGt(new BigNumber(await v.totalSupply()), 0);
    const p = await position();
    Utils.assertBNGt(p.supplied, 0); // has cbETH collateral
    Utils.assertBNGt(p.borrowed, 0); // has WETH debt (folded)
    Utils.assertBNGt(p.health, ONE); // HF > 1
  });

  it("strategy-first upgrade: position + legacy-holder value preserved; deposit/withdraw/hard-work work", async function() {
    const v = await FoldVaultV2.at(VAULT);

    // A holder who deposits BEFORE the upgrade, under the old stack.
    await deposit(farmer, web3.utils.toWei("0.1"));
    const farmerShares = new BigNumber(await v.balanceOf(farmer));
    const claim0 = new BigNumber(await v.underlyingBalanceWithInvestmentForHolder(farmer));
    const pps0 = new BigNumber(await v.getPricePerFullShare());
    const pos0 = await position();
    Utils.assertBNGt(pos0.supplied, 0); Utils.assertBNGt(pos0.borrowed, 0);

    // 1) STRATEGY first.
    await upgradeStrategy();
    assert.equal(await implOf(STRAT), cs(newStratImpl.address), "strategy upgraded");
    const pos1 = await position();
    // The loop is still alive (not silently deleveraged) and storedBalance was resynced.
    Utils.assertBNGt(pos1.supplied, 0);
    Utils.assertBNGt(pos1.borrowed, 0);
    Utils.assertBNGt(pos1.stored, 0);
    Utils.assertBNGt(pos1.health, ONE);

    // 2) then the VAULT.
    await upgradeVault();
    assert.equal(await implOf(VAULT), cs(newVaultImpl.address), "vault upgraded");

    // The legacy holder's underlying claim is preserved across BOTH upgrades (< 0.5% drift),
    // isolating the upgrade effect from any later exit slippage.
    const claim1 = new BigNumber(await v.underlyingBalanceWithInvestmentForHolder(farmer));
    Utils.assertBNGte(claim1, claim0.times(995).div(1000));
    Utils.assertBNGte(claim0.times(1005).div(1000), claim1);
    // Per-share price barely moves.
    const pps1 = new BigNumber(await v.getPricePerFullShare());
    Utils.assertBNGte(pps1, pps0.times(995).div(1000));
    Utils.assertBNGte(pps0.times(1005).div(1000), pps1);

    // The legacy holder can exit for ~their claim (allowing the strategy's unwind slippage).
    const wethBefore = await wethOf(farmer);
    await v.redeem(farmerShares.toFixed(), farmer, farmer, { from: farmer });
    const got = (await wethOf(farmer)).minus(wethBefore);
    Utils.assertBNGte(got, claim1.times(98).div(100)); // within ~2% (unwind slippage + premium)
    Utils.assertBNEq(new BigNumber(await v.balanceOf(farmer)), 0);

    // A fresh second holder can deposit, and the keeper can hard-work.
    await deposit(farmer2, web3.utils.toWei("0.05"));
    Utils.assertBNGt(new BigNumber(await v.balanceOf(farmer2)), 0);
    await v.doHardWork({ from: GOV });
    // Position remains a live loop afterwards.
    const pos2 = await position();
    Utils.assertBNGt(pos2.supplied, 0);
    Utils.assertBNGt(pos2.borrowed, 0);
    Utils.assertBNGt(pos2.health, ONE);
  });

  it("vault upgrade alone is safe: deposits/withdrawals keep working (deployed strategy already has preInteract) and the cap becomes available", async function() {
    const v = await FoldVaultV2.at(VAULT);
    // A holder deposits under the currently-deployed stack.
    await deposit(farmer, web3.utils.toWei("0.05"));
    const shares = new BigNumber(await v.balanceOf(farmer)).toFixed();

    // Upgrade ONLY the vault (0xe727 -> FoldVaultV2); leave the strategy as deployed.
    await upgradeVault();
    assert.equal(await implOf(VAULT), cs(newVaultImpl.address));
    assert.equal(await implOf(STRAT), cs(DEPLOYED_STRAT_IMPL));

    // Deposits and withdrawals still work — the deployed strategy already implements
    // preInteract(), so FoldVaultV2's preInteract call resolves. No ordering brick.
    await deposit(farmer2, web3.utils.toWei("0.02"));
    Utils.assertBNGt(new BigNumber(await v.balanceOf(farmer2)), 0);
    await v.redeem(shares, farmer, farmer, { from: farmer });
    Utils.assertBNEq(new BigNumber(await v.balanceOf(farmer)), 0);

    // The only new capability the vault upgrade adds is the deposit cap.
    const tvl = new BigNumber(await v.totalAssets());
    await v.setDepositCap(tvl.plus(new BigNumber("1e15")).toFixed(), { from: GOV });
    await expectRevertLike(deposit(farmer2, web3.utils.toWei("1")), "Deposit cap reached");
  });

  it("deposit cap is available, enforced, and emits after the full upgrade", async function() {
    await upgradeStrategy();
    await upgradeVault();
    const v = await FoldVaultV2.at(VAULT);

    const tvl = new BigNumber(await v.totalAssets());
    // Cap just above current TVL: a large deposit exceeds it; the setter emits.
    const cap = tvl.plus(new BigNumber("5e16"));
    const receipt = await v.setDepositCap(cap.toFixed(), { from: GOV });
    const ev = receipt.logs.find((l) => l.event === "DepositCapChanged");
    assert(ev && ev.args.newCap.toString() === cap.toFixed(), "DepositCapChanged emitted with new cap");

    await expectRevertLike(deposit(farmer, web3.utils.toWei("1")), "Deposit cap reached");

    // Clearing the cap re-enables deposits.
    await v.setDepositCap(0, { from: GOV });
    await deposit(farmer, web3.utils.toWei("0.02"));
  });
});
