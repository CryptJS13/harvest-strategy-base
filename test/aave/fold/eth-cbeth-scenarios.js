const BigNumber = require("bignumber.js");

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

describe("Aave Fold cbETH-ETH scenario runs", function() {
  let accounts;
  let governance;
  let users;

  let weth;
  let underlying;
  let controller;
  let vault;
  let strategy;
  let mockLiquidator;
  let viewer;

  let snapshotId;

  const wethAddress = "0x4200000000000000000000000000000000000006";
  const cbethAddress = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
  const viewerAddress = "0x1e51654aB193bA165b7F7715C734dAF454f08148";

  const ONE = new BigNumber("1e18");
  const VIEWER_HEALTH = new BigNumber("2000000000000000000");
  const FUNDING_AMOUNT = new BigNumber("10e18");
  const BASE_DEPOSIT = new BigNumber("2e18");
  const USER_DEPOSIT = new BigNumber("0.75e18");
  const SHORT_DEPOSIT = new BigNumber("0.60e18");

  const ORACLE_CBETH_IN_WETH = new BigNumber("1.05e18");
  const MARKET_CBETH_EXPENSIVE = new BigNumber("1.08e18");
  const MARKET_CBETH_CHEAP = new BigNumber("1.02e18");
  const MARKET_CBETH_MODERATELY_EXPENSIVE = new BigNumber("1.06e18");
  const MARKET_CBETH_MODERATELY_CHEAP = new BigNumber("1.04e18");
  const MARKET_CBETH_SLIGHTLY_EXPENSIVE = new BigNumber("1.052e18");
  const MARKET_CBETH_SLIGHTLY_CHEAP = new BigNumber("1.048e18");

  const BORROW_TARGET = 9200;
  const CBETH_RATE = 0.025;
  const BORROW_RATE = 0.02;
  const SUPPLY_MULTIPLE = 1 / (1 - BORROW_TARGET / 10000);
  const DEBT_MULTIPLE = (BORROW_TARGET / 10000) / (1 - BORROW_TARGET / 10000);
  const ANNUAL_CARRY = SUPPLY_MULTIPLE * CBETH_RATE - DEBT_MULTIPLE * BORROW_RATE;
  const MONTHLY_CARRY = Math.pow(1 + ANNUAL_CARRY, 1 / 12) - 1;

  function bn(value) {
    return new BigNumber(value.toString());
  }

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
    await strategy.setBorrowTargetFactorNumerator(BORROW_TARGET, { from: governance });
    await strategy.setFold(true, { from: governance });
  }

  async function investVaultAtNeutral() {
    await syncAccounting(ORACLE_CBETH_IN_WETH, ORACLE_CBETH_IN_WETH);
    await controller.doHardWork(vault.address, { from: governance });
  }

  async function settleAfterInteraction() {
    await investVaultAtNeutral();
  }

  async function openBasePosition() {
    await syncAccounting(ORACLE_CBETH_IN_WETH, ORACLE_CBETH_IN_WETH);
    await depositToVault(users.alice, BASE_DEPOSIT);
  }

  async function enterAndInvest(account, amount, marketPrice = ORACLE_CBETH_IN_WETH) {
    const sharesBefore = bn(await vault.balanceOf(account));
    await syncAccounting(ORACLE_CBETH_IN_WETH, marketPrice);
    await depositToVault(account, amount);
    const sharesAfter = bn(await vault.balanceOf(account));
    return sharesAfter.minus(sharesBefore);
  }

  async function withdrawAll(account, marketPrice) {
    await syncAccounting(ORACLE_CBETH_IN_WETH, marketPrice);
    const shares = bn(await vault.balanceOf(account));
    const ppfsBefore = bn(await vault.getPricePerFullShare());
    const wethBefore = bn(await underlying.balanceOf(account));
    await vault.withdraw(shares.toFixed(), { from: account });
    const wethAfter = bn(await underlying.balanceOf(account));
    return {
      sharesBurned: shares,
      ppfsBefore,
      actualReceived: wethAfter.minus(wethBefore),
    };
  }

  async function advanceMonth(state) {
    state.month += 1;
    state.assumedPpfs = state.assumedPpfs.multipliedBy(1 + MONTHLY_CARRY);
    await Utils.waitTime(30 * 24 * 60 * 60);
    await investVaultAtNeutral();
  }

  function modeledWithdrawalValue(withdrawResult, assumedPpfs) {
    return withdrawResult.actualReceived.multipliedBy(assumedPpfs).div(withdrawResult.ppfsBefore);
  }

  function pctGain(finalValue, costBasis) {
    return finalValue.minus(costBasis).multipliedBy(10000).div(costBasis).toNumber() / 100;
  }

  async function runAnnualScenario() {
    const state = {
      month: 0,
      assumedPpfs: ONE,
      entries: {},
      exits: {},
      costBasis: {},
    };

    state.costBasis.alice = BASE_DEPOSIT;
    state.costBasis.bob = USER_DEPOSIT;
    state.costBasis.carol = USER_DEPOSIT;
    state.costBasis.dan = USER_DEPOSIT;
    state.costBasis.erin = SHORT_DEPOSIT;

    state.entries.alice = {
      month: 0,
      market: "neutral",
      shares: bn(await vault.balanceOf(users.alice)),
    };

    await advanceMonth(state);

    state.entries.bob = {
      month: state.month,
      market: "favorable",
      shares: await enterAndInvest(users.bob, USER_DEPOSIT, MARKET_CBETH_SLIGHTLY_CHEAP),
    };
    await settleAfterInteraction();
    state.entries.carol = {
      month: state.month,
      market: "adverse",
      shares: await enterAndInvest(users.carol, USER_DEPOSIT, MARKET_CBETH_SLIGHTLY_EXPENSIVE),
    };
    await settleAfterInteraction();
    state.entries.dan = {
      month: state.month,
      market: "neutral",
      shares: await enterAndInvest(users.dan, USER_DEPOSIT, ORACLE_CBETH_IN_WETH),
    };
    await settleAfterInteraction();

    for (let i = 0; i < 5; i++) {
      await advanceMonth(state);
    }

    state.entries.erin = {
      month: state.month,
      market: "favorable-short",
      shares: await enterAndInvest(users.erin, SHORT_DEPOSIT, MARKET_CBETH_SLIGHTLY_CHEAP),
    };
    await settleAfterInteraction();

    for (let i = 0; i < 6; i++) {
      await advanceMonth(state);
    }

    state.exits.alice = await withdrawAll(users.alice, ORACLE_CBETH_IN_WETH);
    await settleAfterInteraction();
    state.exits.bob = await withdrawAll(users.bob, MARKET_CBETH_SLIGHTLY_EXPENSIVE);
    await settleAfterInteraction();
    state.exits.carol = await withdrawAll(users.carol, MARKET_CBETH_SLIGHTLY_CHEAP);
    await settleAfterInteraction();
    state.exits.dan = await withdrawAll(users.dan, ORACLE_CBETH_IN_WETH);
    await settleAfterInteraction();
    state.exits.erin = await withdrawAll(users.erin, MARKET_CBETH_SLIGHTLY_CHEAP);

    const report = ["alice", "bob", "carol", "dan", "erin"].map((name) => {
      const modeledExit = modeledWithdrawalValue(state.exits[name], state.assumedPpfs);
      return {
        user: name,
        entryMonth: state.entries[name].month,
        exitMonth: state.month,
        entryMarket: state.entries[name].market,
        exitMarket: name === "bob" ? "favorable" : name === "carol" || name === "erin" ? "adverse" : "neutral",
        shares: state.entries[name].shares.div(ONE).toFixed(6),
        modeledExitWeth: modeledExit.div(ONE).toFixed(6),
        modeledReturnPct: pctGain(modeledExit, state.costBasis[name]).toFixed(2),
      };
    });

    return {
      month: state.month,
      assumedPpfs: state.assumedPpfs,
      annualCarryPct: (ANNUAL_CARRY * 100).toFixed(2),
      report,
    };
  }

  async function runRoundTripBranch(entryMarketPrice, exitMarketPrice, slippageBps = 50, amount = USER_DEPOSIT) {
    await configureVault(slippageBps);
    await openBasePosition();

    for (let i = 0; i < 3; i++) {
      await Utils.waitTime(30 * 24 * 60 * 60);
      await investVaultAtNeutral();
    }

    const bobBefore = bn(await underlying.balanceOf(users.bob));
    await enterAndInvest(users.bob, amount, entryMarketPrice);
    await settleAfterInteraction();

    await Utils.waitTime(30 * 24 * 60 * 60);
    await investVaultAtNeutral();

    await withdrawAll(users.bob, exitMarketPrice);
    await settleAfterInteraction();
    const bobAfter = bn(await underlying.balanceOf(users.bob));

    const aliceShares = bn(await vault.balanceOf(users.alice));
    const aliceBefore = bn(await underlying.balanceOf(users.alice));
    await syncAccounting(ORACLE_CBETH_IN_WETH, ORACLE_CBETH_IN_WETH);
    await vault.withdraw(aliceShares.toFixed(), { from: users.alice });
    const aliceAfter = bn(await underlying.balanceOf(users.alice));

    return {
      bobPnl: bobAfter.minus(bobBefore),
      aliceReceived: aliceAfter.minus(aliceBefore),
      vaultPpfsAfter: bn(await vault.getPricePerFullShare()),
    };
  }

  async function runRepeatedCycles(entryMarketPrice, exitMarketPrice, cycles, slippageBps = 50, amount = USER_DEPOSIT) {
    await configureVault(slippageBps);
    await openBasePosition();

    let bobPnl = new BigNumber(0);
    for (let i = 0; i < cycles; i++) {
      await Utils.waitTime(30 * 24 * 60 * 60);
      await investVaultAtNeutral();

      const bobBefore = bn(await underlying.balanceOf(users.bob));
      await enterAndInvest(users.bob, amount, entryMarketPrice);
      await settleAfterInteraction();
      await withdrawAll(users.bob, exitMarketPrice);
      await settleAfterInteraction();
      const bobAfter = bn(await underlying.balanceOf(users.bob));
      bobPnl = bobPnl.plus(bobAfter.minus(bobBefore));
    }

    const aliceShares = bn(await vault.balanceOf(users.alice));
    const aliceBefore = bn(await underlying.balanceOf(users.alice));
    await syncAccounting(ORACLE_CBETH_IN_WETH, ORACLE_CBETH_IN_WETH);
    await vault.withdraw(aliceShares.toFixed(), { from: users.alice });
    const aliceAfter = bn(await underlying.balanceOf(users.alice));

    return {
      bobPnl,
      aliceReceived: aliceAfter.minus(aliceBefore),
    };
  }

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();
    users = {
      alice: accounts[1],
      bob: accounts[2],
      carol: accounts[3],
      dan: accounts[4],
      erin: accounts[5],
    };

    await impersonates([governance]);
    await web3.eth.sendTransaction({ from: accounts[9], to: governance, value: web3.utils.toWei("10", "ether") });

    weth = await IWETH.at(wethAddress);
    underlying = await IERC20.at(wethAddress);

    for (const account of [accounts[0], ...Object.values(users)]) {
      await fundAccount(account, account === accounts[0] ? new BigNumber("500e18") : FUNDING_AMOUNT);
    }

    const newVaultImpl = await Vault.new();
    [controller, vault, strategy] = await setupCoreProtocol({
      vaultImplementationOverride: newVaultImpl.address,
      existingVaultAddress: null,
      strategyArtifact: Strategy,
      strategyArtifactIsUpgradable: true,
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

  it("keeps a single-cycle favorable withdrawal branch close to neutral for incumbents inside the production envelope", async function() {
    const neutral = await runIsolated(() => runRoundTripBranch(ORACLE_CBETH_IN_WETH, ORACLE_CBETH_IN_WETH));
    const favorable = await runIsolated(() => runRoundTripBranch(MARKET_CBETH_SLIGHTLY_CHEAP, MARKET_CBETH_SLIGHTLY_EXPENSIVE));

    assert(
      favorable.bobPnl.gt(neutral.bobPnl),
      "favorable round trip should outperform neutral"
    );
    const aliceDiff = favorable.aliceReceived.minus(neutral.aliceReceived).abs();
    assert(aliceDiff.lte(new BigNumber("1000000000000000")), `incumbent drift too large ${aliceDiff.toFixed()}`);
  });

  it("keeps incumbent drift small when withdrawal divergence stays inside the default slippage guard", async function() {
    const neutral = await runIsolated(() => runRoundTripBranch(ORACLE_CBETH_IN_WETH, ORACLE_CBETH_IN_WETH));
    const favorable = await runIsolated(() => runRoundTripBranch(MARKET_CBETH_SLIGHTLY_CHEAP, MARKET_CBETH_SLIGHTLY_EXPENSIVE));
    const adverse = await runIsolated(() => runRoundTripBranch(MARKET_CBETH_SLIGHTLY_EXPENSIVE, MARKET_CBETH_SLIGHTLY_CHEAP));

    const aliceFavDiff = favorable.aliceReceived.minus(neutral.aliceReceived).abs();
    const aliceAdvDiff = adverse.aliceReceived.minus(neutral.aliceReceived).abs();
    assert(aliceFavDiff.lte(new BigNumber("2000000000000000")), `favorable drift too large ${aliceFavDiff.toFixed()}`);
    assert(aliceAdvDiff.lte(new BigNumber("2000000000000000")), `adverse drift too large ${aliceAdvDiff.toFixed()}`);
  });

  it("keeps repeated favorable withdrawal cycles bounded for incumbents inside the production envelope", async function() {
    const neutral = await runIsolated(() => runRepeatedCycles(ORACLE_CBETH_IN_WETH, ORACLE_CBETH_IN_WETH, 4));
    const favorable = await runIsolated(() => runRepeatedCycles(MARKET_CBETH_SLIGHTLY_CHEAP, MARKET_CBETH_SLIGHTLY_EXPENSIVE, 4));

    assert(favorable.bobPnl.gt(neutral.bobPnl), "favorable repeated branch should outperform neutral");
    const aliceDiff = favorable.aliceReceived.minus(neutral.aliceReceived).abs();
    assert(aliceDiff.lte(new BigNumber("3000000000000000")), `repeated incumbent drift too large ${aliceDiff.toFixed()}`);
  });

  it("keeps incumbent drift bounded across the full allowed slippage range", async function() {
    const cases = [
      {
        slippageBps: 0,
        exit: ORACLE_CBETH_IN_WETH,
        maxDrift: new BigNumber("1000000000000"),
      },
      {
        slippageBps: 25,
        exit: MARKET_CBETH_SLIGHTLY_EXPENSIVE,
        maxDrift: new BigNumber("2000000000000000"),
      },
      {
        slippageBps: 50,
        exit: MARKET_CBETH_SLIGHTLY_EXPENSIVE,
        maxDrift: new BigNumber("2000000000000000"),
      },
      {
        slippageBps: 100,
        exit: MARKET_CBETH_MODERATELY_EXPENSIVE,
        maxDrift: new BigNumber("6000000000000000"),
      },
    ];

    for (const testCase of cases) {
      const neutral = await runIsolated(() => runRoundTripBranch(ORACLE_CBETH_IN_WETH, ORACLE_CBETH_IN_WETH, testCase.slippageBps));
      const branch = await runIsolated(() => runRoundTripBranch(testCase.exit === ORACLE_CBETH_IN_WETH ? ORACLE_CBETH_IN_WETH : MARKET_CBETH_SLIGHTLY_CHEAP, testCase.exit, testCase.slippageBps));
      const aliceDiff = branch.aliceReceived.minus(neutral.aliceReceived).abs();
      assert(aliceDiff.lte(testCase.maxDrift), `slippage ${testCase.slippageBps} drift too large ${aliceDiff.toFixed()}`);
    }
  });

  it("keeps incumbent drift bounded across attacker sizes inside the default envelope", async function() {
    const cases = [
      { label: "small", amount: new BigNumber("0.25e18"), maxDrift: new BigNumber("1500000000000000") },
      { label: "base", amount: USER_DEPOSIT, maxDrift: new BigNumber("2000000000000000") },
      { label: "large", amount: new BigNumber("2e18"), maxDrift: new BigNumber("5000000000000000") },
      { label: "xlarge", amount: new BigNumber("4e18"), maxDrift: new BigNumber("12000000000000000") },
    ];

    for (const testCase of cases) {
      const neutral = await runIsolated(() => runRoundTripBranch(ORACLE_CBETH_IN_WETH, ORACLE_CBETH_IN_WETH, 50, testCase.amount));
      const favorable = await runIsolated(() => runRoundTripBranch(MARKET_CBETH_SLIGHTLY_CHEAP, MARKET_CBETH_SLIGHTLY_EXPENSIVE, 50, testCase.amount));
      const aliceDiff = favorable.aliceReceived.minus(neutral.aliceReceived).abs();
      assert(favorable.bobPnl.gt(neutral.bobPnl), `${testCase.label} favorable branch should outperform neutral`);
      assert(aliceDiff.lte(testCase.maxDrift), `${testCase.label} drift too large ${aliceDiff.toFixed()}`);
    }
  });

  it("keeps longer repeated favorable withdrawal cycles bounded inside the default envelope", async function() {
    const neutral = await runIsolated(() => runRepeatedCycles(ORACLE_CBETH_IN_WETH, ORACLE_CBETH_IN_WETH, 8));
    const favorable = await runIsolated(() => runRepeatedCycles(MARKET_CBETH_SLIGHTLY_CHEAP, MARKET_CBETH_SLIGHTLY_EXPENSIVE, 8));

    assert(favorable.bobPnl.gt(neutral.bobPnl), "long favorable branch should outperform neutral");
    const aliceDiff = favorable.aliceReceived.minus(neutral.aliceReceived).abs();
    assert(aliceDiff.lte(new BigNumber("7000000000000000")), `long repeated incumbent drift too large ${aliceDiff.toFixed()}`);
  });

  it("rejects oversized withdrawal divergence even if governance uses the maximum allowed slippage", async function() {
    await configureVault(100);
    await openBasePosition();
    await enterAndInvest(users.bob, USER_DEPOSIT, ORACLE_CBETH_IN_WETH);
    await syncAccounting(ORACLE_CBETH_IN_WETH, MARKET_CBETH_CHEAP);

    try {
      await withdrawAll(users.bob, MARKET_CBETH_CHEAP);
      assert.fail("expected revert");
    } catch (e) {
      assert(e.message.includes("minOut"), e.message);
    }
  });

  it("runs a multi-user annual scenario and keeps users inside a positive bounded-performance envelope", async function() {
    await configureVault();
    await openBasePosition();

    const result = await runAnnualScenario();
    const lookup = Object.fromEntries(result.report.map((row) => [row.user, row]));

    assert(parseFloat(lookup.bob.modeledReturnPct) > parseFloat(lookup.dan.modeledReturnPct), "bob should outperform dan");
    assert(parseFloat(lookup.dan.modeledReturnPct) > parseFloat(lookup.carol.modeledReturnPct), "dan should outperform carol");
    assert(parseFloat(lookup.carol.modeledReturnPct) > 0, "carol should remain positive inside the bounded production envelope");
    assert(parseFloat(lookup.alice.modeledReturnPct) > 0, "alice should remain positive over the year");
    assert(parseFloat(lookup.erin.modeledReturnPct) > 0, "erin should remain positive inside the bounded production envelope");
  });
});
