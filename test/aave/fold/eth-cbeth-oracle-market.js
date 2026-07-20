const BigNumber = require("bignumber.js");
const { expectRevert } = require("@openzeppelin/test-helpers");

const Utils = require("../../utilities/Utils.js");
const {
  impersonates,
  setupCoreProtocol,
} = require("../../utilities/hh-utils.js");

const addresses = require("../../test-config.js");

const IERC20 = artifacts.require("IERC20");
const IWETH = artifacts.require("contracts/base/interface/weth/IWETH.sol:IWETH");
const Vault = artifacts.require("VaultV2");
const Strategy = artifacts.require("Aave2AssetFoldStrategyMainnet_ETH_cbETH");
const MockAaveViewer = artifacts.require("MockAaveViewer");
const MockUniversalLiquidator = artifacts.require("MockUniversalLiquidator");
const IUniversalLiquidator = artifacts.require("contracts/base/interface/IUniversalLiquidator.sol:IUniversalLiquidator");

describe("Aave Fold cbETH-ETH oracle-market accounting", function() {
  let accounts;
  let governance;
  let farmer1;
  let farmer2;

  let weth;
  let underlying;
  let borrowDebtToken;

  let controller;
  let vault;
  let strategy;
  let mockLiquidator;
  let viewer;

  let snapshotId;

  const wethAddress = "0x4200000000000000000000000000000000000006";
  const cbethAddress = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
  const wethVarDebtToken = "0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E";
  const viewerAddress = "0x1e51654aB193bA165b7F7715C734dAF454f08148";

  const ONE = new BigNumber("1e18");
  const VIEWER_HEALTH = new BigNumber("2000000000000000000");
  const PRICE_TOLERANCE = new BigNumber("2000000000");
  const CLAIM_TOLERANCE = new BigNumber("5000000000000000");
  const FUNDING_AMOUNT = new BigNumber("8e18");
  const BASE_DEPOSIT = new BigNumber("2e18");
  const USER_DEPOSIT = new BigNumber("0.75e18");
  const USER_WITHDRAW_SHARES = new BigNumber("0.4e18");

  const ORACLE_CBETH_IN_WETH = new BigNumber("1.05e18");
  const MARKET_CBETH_EXPENSIVE = new BigNumber("1.08e18");
  const MARKET_CBETH_CHEAP = new BigNumber("1.02e18");
  const MARKET_CBETH_SLIGHTLY_EXPENSIVE = new BigNumber("1.052e18");
  const MARKET_CBETH_SLIGHTLY_CHEAP = new BigNumber("1.048e18");

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

  async function runIsolated(fn) {
    const id = await takeSnapshot();
    try {
      return await fn();
    } finally {
      await revertToSnapshot(id);
    }
  }

  function inversePrice(price) {
    return ONE.multipliedBy(ONE).div(price).integerValue(BigNumber.ROUND_FLOOR);
  }

  function priceDelta(result, phase = "interaction") {
    const afterKey = phase === "hardWork" ? "priceAfterHardWork" : "priceAfterInteraction";
    return new BigNumber(result[afterKey]).minus(result.priceBefore);
  }

  function assertPriceDeltaMatch(left, right, context, phase = "interaction") {
    const leftDelta = priceDelta(left, phase);
    const rightDelta = priceDelta(right, phase);
    const diff = leftDelta.minus(rightDelta).abs();
    assert(
      diff.lte(PRICE_TOLERANCE),
      `${context} (${phase}): ppfs delta mismatch ${diff.toFixed()} (${leftDelta.toFixed()} vs ${rightDelta.toFixed()})`
    );
  }

  function assertBnClose(left, right, tolerance, context) {
    const diff = new BigNumber(left).minus(right).abs();
    assert(diff.lte(tolerance), `${context}: diff ${diff.toFixed()} > ${tolerance.toFixed()}`);
  }

  async function installViewerCode() {
    const template = await MockAaveViewer.new();
    const code = await web3.eth.getCode(template.address);
    await hre.network.provider.request({
      method: "hardhat_setCode",
      params: [viewerAddress, code],
    });
    viewer = await MockAaveViewer.at(viewerAddress);
    await viewer.setHealth(VIEWER_HEALTH.toFixed());
  }

  async function setOraclePrice(cbethInWeth) {
    await viewer.setPrice(cbethAddress, wethAddress, cbethInWeth.toFixed());
    await viewer.setPrice(wethAddress, cbethAddress, inversePrice(cbethInWeth).toFixed());
  }

  async function setMarketPrice(cbethInWeth) {
    await mockLiquidator.setRate(cbethAddress, wethAddress, cbethInWeth.toFixed());
    await mockLiquidator.setRate(wethAddress, cbethAddress, inversePrice(cbethInWeth).toFixed());
  }

  async function syncAccounting(cbethOraclePrice, cbethMarketPrice) {
    await setOraclePrice(cbethOraclePrice);
    await setMarketPrice(cbethMarketPrice);
    await strategy.preInteract({ from: governance });
  }

  async function settleAtNeutral() {
    await syncAccounting(ORACLE_CBETH_IN_WETH, ORACLE_CBETH_IN_WETH);
    await controller.doHardWork(vault.address, { from: governance });
  }

  async function fundAccount(account, amount) {
    await weth.deposit({ from: account, value: amount.toFixed() });
  }

  async function seedMockLiquidator() {
    const realLiquidator = await IUniversalLiquidator.at(addresses.UniversalLiquidator);
    const seedSwap = new BigNumber("200e18");
    const seedWeth = new BigNumber("200e18");

    await underlying.approve(realLiquidator.address, seedSwap.toFixed(), { from: accounts[0] });
    await realLiquidator.swap(
      wethAddress,
      cbethAddress,
      seedSwap.toFixed(),
      1,
      mockLiquidator.address,
      { from: accounts[0] }
    );

    await underlying.transfer(mockLiquidator.address, seedWeth.toFixed(), { from: accounts[0] });
  }

  async function depositToVault(account, amount) {
    await underlying.approve(vault.address, amount.toFixed(), { from: account });
    await vault.deposit(amount.toFixed(), account, { from: account });
  }

  async function configureVault(slippageBps = 50) {
    await vault.setInvestOnDeposit(true, { from: governance });
    await vault.setCompoundOnWithdraw(false, { from: governance });
    await strategy.setSlippageBps(slippageBps, { from: governance });
    await strategy.setBorrowTargetFactorNumerator(9200, { from: governance });
    await strategy.setFold(true, { from: governance });
  }

  async function primeLeveragedVault() {
    await configureVault();
    await syncAccounting(ORACLE_CBETH_IN_WETH, ORACLE_CBETH_IN_WETH);
    await depositToVault(farmer1, BASE_DEPOSIT);

    const borrowed = new BigNumber(await borrowDebtToken.balanceOf(strategy.address));
    assert(borrowed.gt(0), "expected leveraged position to be open after deposit");
  }

  async function getPricePerShare() {
    return new BigNumber(await vault.getPricePerFullShare());
  }

  async function getHolderClaim(account) {
    const shares = new BigNumber(await vault.balanceOf(account));
    const ppfs = await getPricePerShare();
    return shares.multipliedBy(ppfs).div(ONE);
  }

  async function depositAndMeasure(cbethMarketPrice) {
    await primeLeveragedVault();
    await syncAccounting(ORACLE_CBETH_IN_WETH, cbethMarketPrice);

    const incumbentBefore = await getHolderClaim(farmer1);
    const priceBefore = await getPricePerShare();
    const sharesBefore = new BigNumber(await vault.balanceOf(farmer2));

    await depositToVault(farmer2, USER_DEPOSIT);

    const incumbentAfterInteraction = await getHolderClaim(farmer1);
    const priceAfterInteraction = await getPricePerShare();

    await settleAtNeutral();

    const incumbentAfterHardWork = await getHolderClaim(farmer1);
    const priceAfterHardWork = await getPricePerShare();
    const sharesAfter = new BigNumber(await vault.balanceOf(farmer2));

    return {
      incumbentBefore,
      incumbentAfterInteraction,
      incumbentAfterHardWork,
      priceBefore,
      priceAfterInteraction,
      priceAfterHardWork,
      mintedShares: sharesAfter.minus(sharesBefore),
    };
  }

  async function depositAfterUpkeepDelayAndMeasure(cbethMarketPrice) {
    await primeLeveragedVault();
    await Utils.waitTime(30 * 24 * 60 * 60);
    await syncAccounting(ORACLE_CBETH_IN_WETH, cbethMarketPrice);

    const incumbentBefore = await getHolderClaim(farmer1);
    const priceBefore = await getPricePerShare();

    await depositToVault(farmer2, USER_DEPOSIT);
    const incumbentAfterInteraction = await getHolderClaim(farmer1);
    const priceAfterInteraction = await getPricePerShare();

    await settleAtNeutral();

    const incumbentAfterHardWork = await getHolderClaim(farmer1);
    const priceAfterHardWork = await getPricePerShare();
    const sharesMinted = new BigNumber(await vault.balanceOf(farmer2));

    return {
      incumbentBefore,
      incumbentAfterInteraction,
      incumbentAfterHardWork,
      priceBefore,
      priceAfterInteraction,
      priceAfterHardWork,
      sharesMinted,
    };
  }

  async function withdrawLeveragedAndMeasure(cbethMarketPrice) {
    await primeLeveragedVault();
    await syncAccounting(ORACLE_CBETH_IN_WETH, cbethMarketPrice);

    const priceBefore = await getPricePerShare();
    const incumbentBefore = await getHolderClaim(farmer2);
    const wethBefore = new BigNumber(await underlying.balanceOf(farmer1));

    await vault.withdraw(USER_WITHDRAW_SHARES.toFixed(), { from: farmer1 });

    const priceAfterInteraction = await getPricePerShare();
    const incumbentAfterInteraction = await getHolderClaim(farmer2);
    const wethAfter = new BigNumber(await underlying.balanceOf(farmer1));

    await settleAtNeutral();

    const priceAfterHardWork = await getPricePerShare();
    const incumbentAfterHardWork = await getHolderClaim(farmer2);

    return {
      priceBefore,
      priceAfterInteraction,
      priceAfterHardWork,
      incumbentBefore,
      incumbentAfterInteraction,
      incumbentAfterHardWork,
      withdrawnUnderlying: wethAfter.minus(wethBefore),
    };
  }

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();
    farmer1 = accounts[1];
    farmer2 = accounts[2];

    await impersonates([governance]);
    await web3.eth.sendTransaction({ from: accounts[9], to: governance, value: web3.utils.toWei("10", "ether") });

    weth = await IWETH.at(wethAddress);
    underlying = await IERC20.at(wethAddress);
    borrowDebtToken = await IERC20.at(wethVarDebtToken);

    await fundAccount(accounts[0], new BigNumber("500e18"));
    await fundAccount(farmer1, FUNDING_AMOUNT);
    await fundAccount(farmer2, FUNDING_AMOUNT);

    const newVaultImpl = await Vault.new();
    [controller, vault, strategy] = await setupCoreProtocol({
      vaultImplementationOverride: newVaultImpl.address,
      existingVaultAddress: null,
      strategyArtifact: Strategy,
      strategyArtifactIsUpgradable: true,
      libraries: ["AaveReserveLib"],
      underlying,
      governance,
      liquidation: [
        { aeroCL: [wethAddress, cbethAddress] },
        { aeroCL: [cbethAddress, wethAddress] },
      ],
    });
    mockLiquidator = await MockUniversalLiquidator.new();
    await seedMockLiquidator();
    await installViewerCode();

    await controller.setUniversalLiquidator(mockLiquidator.address, { from: governance });
    await vault.setInvestOnDeposit(true, { from: governance });
    await vault.setCompoundOnWithdraw(false, { from: governance });

    snapshotId = await takeSnapshot();
  });

  beforeEach(async function() {
    await revertToSnapshot(snapshotId);
    snapshotId = await takeSnapshot();
  });

  it("makes the depositor bear deposit execution quality while keeping the incumbent claim bounded", async function() {
    const neutral = await runIsolated(() => depositAndMeasure(ORACLE_CBETH_IN_WETH));
    const adverse = await runIsolated(() => depositAndMeasure(MARKET_CBETH_SLIGHTLY_EXPENSIVE));
    const favorable = await runIsolated(() => depositAndMeasure(MARKET_CBETH_SLIGHTLY_CHEAP));

    assert(
      favorable.mintedShares.gt(neutral.mintedShares),
      `expected favorable market to mint more shares (${favorable.mintedShares.toFixed()} <= ${neutral.mintedShares.toFixed()})`
    );
    assert(
      neutral.mintedShares.gt(adverse.mintedShares),
      `expected adverse market to mint fewer shares (${neutral.mintedShares.toFixed()} <= ${adverse.mintedShares.toFixed()})`
    );

    assertBnClose(neutral.incumbentAfterInteraction, neutral.incumbentBefore, CLAIM_TOLERANCE, "neutral incumbent loss on interaction");
    assertBnClose(adverse.incumbentAfterInteraction, adverse.incumbentBefore, CLAIM_TOLERANCE, "adverse incumbent loss on interaction");
    assertBnClose(favorable.incumbentAfterInteraction, favorable.incumbentBefore, CLAIM_TOLERANCE, "favorable incumbent loss on interaction");
    assertBnClose(neutral.incumbentAfterInteraction, adverse.incumbentAfterInteraction, CLAIM_TOLERANCE, "adverse incumbent drift on interaction");
    assertBnClose(neutral.incumbentAfterInteraction, favorable.incumbentAfterInteraction, CLAIM_TOLERANCE, "favorable incumbent drift on interaction");

    assertBnClose(neutral.incumbentAfterHardWork, neutral.incumbentBefore, CLAIM_TOLERANCE, "neutral incumbent loss after hard work");
    assertBnClose(adverse.incumbentAfterHardWork, adverse.incumbentBefore, CLAIM_TOLERANCE, "adverse incumbent loss after hard work");
    assertBnClose(favorable.incumbentAfterHardWork, favorable.incumbentBefore, CLAIM_TOLERANCE, "favorable incumbent loss after hard work");
    assertBnClose(neutral.incumbentAfterHardWork, adverse.incumbentAfterHardWork, CLAIM_TOLERANCE, "adverse incumbent drift after hard work");
    assertBnClose(neutral.incumbentAfterHardWork, favorable.incumbentAfterHardWork, CLAIM_TOLERANCE, "favorable incumbent drift after hard work");
  });

  it("keeps incumbent accounting bounded when a new user deposits before scheduled upkeep", async function() {
    const neutral = await runIsolated(() => depositAfterUpkeepDelayAndMeasure(ORACLE_CBETH_IN_WETH));
    const favorable = await runIsolated(() => depositAfterUpkeepDelayAndMeasure(MARKET_CBETH_SLIGHTLY_CHEAP));
    const adverse = await runIsolated(() => depositAfterUpkeepDelayAndMeasure(MARKET_CBETH_SLIGHTLY_EXPENSIVE));

    assert(
      favorable.sharesMinted.gt(neutral.sharesMinted),
      `expected favorable deposit to mint more shares (${favorable.sharesMinted.toFixed()} <= ${neutral.sharesMinted.toFixed()})`
    );
    assert(
      neutral.sharesMinted.gt(adverse.sharesMinted),
      `expected adverse deposit to mint fewer shares (${neutral.sharesMinted.toFixed()} <= ${adverse.sharesMinted.toFixed()})`
    );

    assertBnClose(neutral.incumbentAfterInteraction, neutral.incumbentBefore, CLAIM_TOLERANCE, "neutral upkeep incumbent on interaction");
    assertBnClose(favorable.incumbentAfterInteraction, favorable.incumbentBefore, CLAIM_TOLERANCE, "favorable upkeep incumbent on interaction");
    assertBnClose(adverse.incumbentAfterInteraction, adverse.incumbentBefore, CLAIM_TOLERANCE, "adverse upkeep incumbent on interaction");

    assertBnClose(neutral.incumbentAfterHardWork, neutral.incumbentBefore, CLAIM_TOLERANCE, "neutral upkeep incumbent after hard work");
    assertBnClose(favorable.incumbentAfterHardWork, favorable.incumbentBefore, CLAIM_TOLERANCE, "favorable upkeep incumbent after hard work");
    assertBnClose(adverse.incumbentAfterHardWork, adverse.incumbentBefore, CLAIM_TOLERANCE, "adverse upkeep incumbent after hard work");
  });

  it("rejects deposits when adverse execution exceeds the default slippage guard", async function() {
    await primeLeveragedVault();
    await syncAccounting(ORACLE_CBETH_IN_WETH, MARKET_CBETH_EXPENSIVE);

    await expectRevert(
      depositToVault(farmer2, USER_DEPOSIT),
      "minOut"
    );
  });

  it("keeps leveraged withdrawal accounting isolated when execution is slightly adverse", async function() {
    const neutral = await runIsolated(() => withdrawLeveragedAndMeasure(ORACLE_CBETH_IN_WETH));
    const adverse = await runIsolated(() => withdrawLeveragedAndMeasure(MARKET_CBETH_SLIGHTLY_CHEAP));

    assertPriceDeltaMatch(neutral, adverse, "leveraged withdraw adverse", "interaction");
    assertPriceDeltaMatch(neutral, adverse, "leveraged withdraw adverse", "hardWork");
    assert(
      neutral.withdrawnUnderlying.gt(adverse.withdrawnUnderlying),
      `expected adverse market to return less underlying (${neutral.withdrawnUnderlying.toFixed()} <= ${adverse.withdrawnUnderlying.toFixed()})`
    );
    assertBnClose(neutral.incumbentAfterHardWork, adverse.incumbentAfterHardWork, CLAIM_TOLERANCE, "leveraged withdraw adverse incumbent after hard work");
  });

  it("keeps leveraged withdrawal accounting isolated when execution is slightly favorable", async function() {
    const neutral = await runIsolated(() => withdrawLeveragedAndMeasure(ORACLE_CBETH_IN_WETH));
    const favorable = await runIsolated(() => withdrawLeveragedAndMeasure(MARKET_CBETH_SLIGHTLY_EXPENSIVE));

    assertPriceDeltaMatch(neutral, favorable, "leveraged withdraw favorable", "interaction");
    assertPriceDeltaMatch(neutral, favorable, "leveraged withdraw favorable", "hardWork");
    assert(
      favorable.withdrawnUnderlying.gt(neutral.withdrawnUnderlying),
      `expected favorable market to return more underlying (${favorable.withdrawnUnderlying.toFixed()} <= ${neutral.withdrawnUnderlying.toFixed()})`
    );
    assertBnClose(neutral.incumbentAfterHardWork, favorable.incumbentAfterHardWork, CLAIM_TOLERANCE, "leveraged withdraw favorable incumbent after hard work");
  });

  it("rejects leveraged withdrawals when adverse execution exceeds the default slippage guard", async function() {
    await primeLeveragedVault();
    await syncAccounting(ORACLE_CBETH_IN_WETH, MARKET_CBETH_CHEAP);

    await expectRevert(
      vault.withdraw(USER_WITHDRAW_SHARES.toFixed(), { from: farmer1 }),
      "minOut"
    );
  });

  it("does not allow governance to widen slippage past the production safety envelope", async function() {
    await expectRevert(
      strategy.setSlippageBps(101, { from: governance }),
      "slip"
    );
  });
});
