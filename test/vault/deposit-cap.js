// Deposit-cap tests for the shared VaultV1/VaultV2.
//
// Run against the cbETH fold market's fork block, like the other aave/fold
// tests:  FORK_BLOCK=44729683 npx hardhat test test/vault/deposit-cap.js
//
// The cap is denominated in the underlying asset, set by governance with no
// timelock, and 0 means uncapped. Enforced in _deposit against
// underlyingBalanceWithInvestment() (the vault's live TVL). We drive it through
// a real VaultV2 + fold strategy: most cases run with investOnDeposit=false so
// TVL == the vault's idle balance and the boundary is exact; one case invests a
// leveraged position to confirm the cap counts invested balance too.

const BigNumber = require("bignumber.js");

const Utils = require("../utilities/Utils.js");
const {
  impersonates,
  setupCoreProtocol,
  depositVault,
} = require("../utilities/hh-utils.js");

const addresses = require("../test-config.js");

const IERC20 = artifacts.require("IERC20");
const Vault = artifacts.require("FoldVaultV2");
const Strategy = artifacts.require("Aave2AssetFoldStrategyMainnet_ETH_cbETH");

const MAX_UINT = new BigNumber(2).pow(256).minus(1);

describe("Vault deposit cap", function() {
  let accounts;
  let underlying;
  let governance;
  let farmer1;
  let farmerBalance;
  let controller;
  let vault;
  let snapshotId;

  const underlyingWhale = "0xC48B1D6EF9AC4E6d46445aEbdbEB556CFeF1ee99";
  const weth = "0x4200000000000000000000000000000000000006";
  const cbeth = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";

  async function takeSnapshot() {
    return hre.network.provider.request({ method: "evm_snapshot", params: [] });
  }
  async function revertToSnapshot(id) {
    await hre.network.provider.request({ method: "evm_revert", params: [id] });
  }

  async function approveAndDeposit(amount) {
    await underlying.approve(vault.address, amount.toFixed(), { from: farmer1 });
    return vault.deposit(amount.toFixed(), farmer1, { from: farmer1 });
  }

  async function expectRevertLike(promise, needle) {
    let reverted = false, msg = "";
    try { await promise; } catch (e) { reverted = true; msg = e.message; }
    assert(reverted, "expected the call to revert, but it succeeded");
    assert(
      msg.includes(needle) || msg.includes("revert") || msg.includes("Reverted"),
      `wrong revert reason (wanted "${needle}"): ${msg}`
    );
  }

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();
    farmer1 = accounts[1];

    await impersonates([governance, underlyingWhale]);

    const etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18 });

    underlying = await IERC20.at(weth);

    const newVaultImpl = await Vault.new();
    [controller, vault] = await setupCoreProtocol({
      vaultImplementationOverride: newVaultImpl.address,
      existingVaultAddress: null,
      strategyArtifact: Strategy,
      strategyArtifactIsUpgradable: true,
      libraries: ["AaveReserveLib"],
      underlying,
      governance,
      liquidation: [
        { aeroCL: [weth, cbeth] },
        { aeroCL: [cbeth, weth] },
      ],
    });
    // setupCoreProtocol returns a VaultV2-typed handle; re-wrap as FoldVaultV2
    // to reach the deposit-cap functions (same proxy, richer ABI).
    vault = await Vault.at(vault.address);

    // Deterministic TVL (== idle vault balance) for the boundary cases; the
    // invested case flips this on itself.
    await vault.setInvestOnDeposit(false, { from: governance });
    await vault.setCompoundOnWithdraw(false, { from: governance });

    await web3.eth.sendTransaction({ from: etherGiver, to: underlyingWhale, value: 10e18 });
    farmerBalance = new BigNumber(await underlying.balanceOf(underlyingWhale));
    await underlying.transfer(farmer1, farmerBalance.toFixed(), { from: underlyingWhale });

    snapshotId = await takeSnapshot();
  });

  beforeEach(async function() {
    await revertToSnapshot(snapshotId);
    snapshotId = await takeSnapshot();
  });

  it("defaults to uncapped (cap == 0)", async function() {
    Utils.assertBNEq(await vault.depositCap(), 0);
    await approveAndDeposit(farmerBalance.div(2).integerValue(BigNumber.ROUND_FLOOR));
    Utils.assertBNGt(await vault.totalAssets(), 0);
  });

  it("only governance can set the cap", async function() {
    const cap = new BigNumber("100e18");
    await expectRevertLike(vault.setDepositCap(cap.toFixed(), { from: farmer1 }), "governance");
    await vault.setDepositCap(cap.toFixed(), { from: governance });
    Utils.assertBNEq(await vault.depositCap(), cap);
  });

  it("enforces the cap: deposit up to the cap succeeds, over reverts", async function() {
    const tvl0 = new BigNumber(await vault.totalAssets());
    const room = farmerBalance.div(4).integerValue(BigNumber.ROUND_FLOOR);
    await vault.setDepositCap(tvl0.plus(room).toFixed(), { from: governance });

    // Fills the cap exactly (TVL == cap afterwards).
    await approveAndDeposit(room);
    Utils.assertBNEq(await vault.totalAssets(), tvl0.plus(room));

    // Any further deposit exceeds the cap and reverts (the cap check runs before
    // funds are pulled, so the amount need not be within the farmer's balance).
    await expectRevertLike(approveAndDeposit(farmerBalance), "Deposit cap reached");
  });

  it("a cap of 0 re-disables the limit", async function() {
    // Deposit under no cap.
    await approveAndDeposit(farmerBalance.div(2).integerValue(BigNumber.ROUND_FLOOR));
    // Set a cap below current TVL: new deposits blocked (existing stay).
    await vault.setDepositCap(new BigNumber("1").toFixed(), { from: governance });
    await expectRevertLike(approveAndDeposit(new BigNumber("1e15")), "Deposit cap reached");
    // Clear the cap: deposits work again.
    await vault.setDepositCap(0, { from: governance });
    await approveAndDeposit(farmerBalance.div(4).integerValue(BigNumber.ROUND_FLOOR));
  });

  it("maxDeposit / maxMint reflect the cap", async function() {
    await approveAndDeposit(farmerBalance.div(4).integerValue(BigNumber.ROUND_FLOOR));
    const tvl = new BigNumber(await vault.totalAssets());

    // Uncapped -> unlimited.
    await vault.setDepositCap(0, { from: governance });
    Utils.assertBNEq(await vault.maxDeposit(farmer1), MAX_UINT);
    Utils.assertBNEq(await vault.maxMint(farmer1), MAX_UINT);

    // Capped above TVL -> remaining room, and maxMint == convertToShares(room).
    const cap = tvl.plus(new BigNumber("1e18"));
    await vault.setDepositCap(cap.toFixed(), { from: governance });
    Utils.assertBNEq(await vault.maxDeposit(farmer1), cap.minus(tvl));
    Utils.assertBNEq(
      await vault.maxMint(farmer1),
      new BigNumber(await vault.convertToShares(cap.minus(tvl).toFixed()))
    );

    // Capped below TVL -> no room.
    await vault.setDepositCap(tvl.minus(new BigNumber("1e15")).toFixed(), { from: governance });
    Utils.assertBNEq(await vault.maxDeposit(farmer1), 0);
    Utils.assertBNEq(await vault.maxMint(farmer1), 0);
  });

  it("counts invested (leveraged) balance toward the cap", async function() {
    await vault.setInvestOnDeposit(true, { from: governance });
    const d1 = farmerBalance.div(3).integerValue(BigNumber.ROUND_FLOOR);
    await approveAndDeposit(d1);
    await controller.doHardWork(vault.address, { from: governance });

    const tvl = new BigNumber(await vault.totalAssets());
    Utils.assertBNGt(tvl, 0);

    // Cap just above the invested TVL: a big deposit exceeds it, a small one fits.
    await vault.setDepositCap(tvl.plus(new BigNumber("1e18")).toFixed(), { from: governance });
    await expectRevertLike(approveAndDeposit(farmerBalance), "Deposit cap reached");
    await approveAndDeposit(new BigNumber("1e17"));
  });
});
