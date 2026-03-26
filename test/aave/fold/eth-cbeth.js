const { expectRevert } = require("@openzeppelin/test-helpers");
const BigNumber = require("bignumber.js");

const Utils = require("../../utilities/Utils.js");
const {
  impersonates,
  setupCoreProtocol,
  depositVault,
} = require("../../utilities/hh-utils.js");

const addresses = require("../../test-config.js");

const IERC20 = artifacts.require("IERC20");
const IPool = artifacts.require("contracts/base/interface/aave/IPool.sol:IPool");
const Vault = artifacts.require("VaultV2");
const Strategy = artifacts.require("Aave2AssetFoldStrategyMainnet_ETH_cbETH");

describe("Base Mainnet Aave Fold cbETH-ETH", function() {
  let accounts;

  let underlying;
  let collateral;
  let supplyAToken;
  let borrowDebtToken;
  let aavePool;

  let governance;
  let farmer1;

  let farmerBalance;

  let controller;
  let vault;
  let strategy;

  let snapshotId;

  const underlyingWhale = "0xC48B1D6EF9AC4E6d46445aEbdbEB556CFeF1ee99";
  const weth = "0x4200000000000000000000000000000000000006";
  const cbeth = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
  const cbethAToken = "0xcf3D55c10DB69f28fD1A75Bd73f3D8A2d9c595ad";
  const wethVarDebtToken = "0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E";
  const aavePoolAddress = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
  const HEALTHY_MIN = new BigNumber("1000000000000000000");
  const DUST_TOLERANCE = new BigNumber("1000000000000");

  async function takeSnapshot() {
    return hre.network.provider.request({
      method: "evm_snapshot",
      params: [],
    });
  }

  async function revertToSnapshot(id) {
    await hre.network.provider.request({
      method: "evm_revert",
      params: [id],
    });
  }

  async function setupExternalContracts() {
    underlying = await IERC20.at(weth);
    collateral = await IERC20.at(cbeth);
    supplyAToken = await IERC20.at(cbethAToken);
    borrowDebtToken = await IERC20.at(wethVarDebtToken);
    aavePool = await IPool.at(aavePoolAddress);
  }

  async function setupBalance() {
    const etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: underlyingWhale, value: 10e18 });

    farmerBalance = await underlying.balanceOf(underlyingWhale);
    await underlying.transfer(farmer1, farmerBalance, { from: underlyingWhale });
  }

  async function getPosition() {
    const userData = await aavePool.getUserAccountData(strategy.address);
    return {
      borrowed: new BigNumber(await borrowDebtToken.balanceOf(strategy.address)),
      supplied: new BigNumber(await supplyAToken.balanceOf(strategy.address)),
      looseUnderlying: new BigNumber(await underlying.balanceOf(strategy.address)),
      looseCollateral: new BigNumber(await collateral.balanceOf(strategy.address)),
      health: new BigNumber(userData[5].toString()),
      liquidationThreshold: new BigNumber(userData[3].toString()),
      storedBalance: new BigNumber(await strategy.storedBalance()),
      pendingFee: new BigNumber(await strategy.pendingFee()),
    };
  }

  async function investHalfOfFarmerBalance() {
    const amount = new BigNumber(await underlying.balanceOf(farmer1))
      .div(2)
      .integerValue(BigNumber.ROUND_FLOOR)
      .minus(1);
    await depositVault(farmer1, underlying, vault, amount);
    await controller.doHardWork(vault.address, { from: governance });
    return amount;
  }

  function assertDustWithinTolerance(position) {
    Utils.assertBNGte(DUST_TOLERANCE, position.looseUnderlying);
    Utils.assertBNGte(DUST_TOLERANCE, position.looseCollateral);
  }

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();
    farmer1 = accounts[1];

    await impersonates([governance, underlyingWhale]);

    const etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18 });

    await setupExternalContracts();

    const newVaultImpl = await Vault.new();
    [controller, vault, strategy] = await setupCoreProtocol({
      vaultImplementationOverride: newVaultImpl.address,
      existingVaultAddress: null,
      strategyArtifact: Strategy,
      strategyArtifactIsUpgradable: true,
      underlying,
      governance,
      liquidation: [
        { aeroCL: [weth, cbeth] },
        { aeroCL: [cbeth, weth] },
      ],
    });

    await setupBalance();
    snapshotId = await takeSnapshot();
  });

  beforeEach(async function() {
    await revertToSnapshot(snapshotId);
    snapshotId = await takeSnapshot();
  });

  it("opens a leveraged position and stays above the target health", async function() {
    await investHalfOfFarmerBalance();

    const position = await getPosition();
    Utils.assertBNGt(position.borrowed, 0);
    Utils.assertBNGt(position.supplied, 0);
    Utils.assertBNGt(position.storedBalance, 0);
    Utils.assertBNGt(position.health, await strategy.targetHealth());
    assertDustWithinTolerance(position);

    const checker = await strategy.checker();
    assert.equal(checker[0], false, "healthy position should not trigger checker");
  });

  it("supports partial withdrawals without fully unwinding the position", async function() {
    await investHalfOfFarmerBalance();

    const farmerBefore = new BigNumber(await underlying.balanceOf(farmer1));
    const sharesToWithdraw = new BigNumber(await vault.balanceOf(farmer1))
      .div(4)
      .integerValue(BigNumber.ROUND_FLOOR);

    await vault.withdraw(sharesToWithdraw.toFixed(), { from: farmer1 });

    const farmerAfter = new BigNumber(await underlying.balanceOf(farmer1));
    const position = await getPosition();

    Utils.assertBNGt(farmerAfter, farmerBefore);
    Utils.assertBNGt(position.borrowed, 0);
    Utils.assertBNGt(position.health, HEALTHY_MIN);
  });

  it("can unwind the whole position back to the vault", async function() {
    await investHalfOfFarmerBalance();

    await strategy.withdrawAllToVault({ from: governance });

    const position = await getPosition();
    Utils.assertBNEq(position.borrowed, 0);
    Utils.assertBNGte(DUST_TOLERANCE, position.supplied);
    Utils.assertBNGte(DUST_TOLERANCE, position.looseCollateral);
  });

  it("deleverages when governance lowers the borrow target", async function() {
    await investHalfOfFarmerBalance();

    const before = await getPosition();
    await strategy.setBorrowTargetFactorNumerator(8000, { from: governance });

    const checkerBefore = await strategy.checker();
    assert.equal(checkerBefore[0], true, "stricter borrow target should require maintenance");

    await controller.doHardWork(vault.address, { from: governance });

    const after = await getPosition();
    Utils.assertBNGt(before.borrowed, after.borrowed);
    Utils.assertBNGt(after.health, before.health);

    const checkerAfter = await strategy.checker();
    assert.equal(checkerAfter[0], false, "position should be back in bounds after deleveraging");
  });

  it("setFold(false) fully unwinds debt and keeps future hard work unlevered", async function() {
    await investHalfOfFarmerBalance();

    await strategy.setFold(false, { from: governance });

    let position = await getPosition();
    Utils.assertBNEq(position.borrowed, 0);
    assert.equal(await strategy.fold(), false, "fold should be disabled");

    const extraDeposit = new BigNumber(await underlying.balanceOf(farmer1))
      .div(10)
      .integerValue(BigNumber.ROUND_FLOOR)
      .minus(1);
    await depositVault(farmer1, underlying, vault, extraDeposit);
    await controller.doHardWork(vault.address, { from: governance });

    position = await getPosition();
    Utils.assertBNEq(position.borrowed, 0);
    Utils.assertBNGt(position.supplied, 0);
  });

  it("keeps a simple round trip within a bounded loss envelope", async function() {
    const farmerStart = new BigNumber(await underlying.balanceOf(farmer1));
    await investHalfOfFarmerBalance();

    await vault.withdraw(new BigNumber(await vault.balanceOf(farmer1)).div(2).toFixed(), { from: farmer1 });
    await vault.withdraw(new BigNumber(await vault.balanceOf(farmer1)).toFixed(), { from: farmer1 });

    const farmerEnd = new BigNumber(await underlying.balanceOf(farmer1));
    const minExpected = farmerStart.multipliedBy(98).div(100).integerValue(BigNumber.ROUND_FLOOR);
    Utils.assertBNGte(farmerEnd, minExpected);
  });

  it("enforces governance guard rails on the key tuning parameters", async function() {
    await expectRevert(
      strategy.setBorrowTargetFactorNumerator(9299, { from: governance }),
      "Bor"
    );
    await expectRevert(
      strategy.setSlippageBps(501, { from: governance }),
      "slip"
    );
    await expectRevert(
      strategy.salvage(governance, weth, 1, { from: governance }),
      "!salv"
    );
  });
});
