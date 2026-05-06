const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { type2Transaction } = require("./utils.js");
const { validateCLVaultWiring } = require("./preflight/cl-vault-preflight.js");

const VaultProxy = artifacts.require("VaultProxy");
const Vault = artifacts.require("CLVault");
const CLRebalanceHelper = artifacts.require("CLRebalanceHelper");
const IPosManager = artifacts.require("INonfungiblePositionManager");
const CLWrapper = artifacts.require("CLWrapper");

function parseArgs() {
  const parsed = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--config" || arg === "-c") {
      parsed.configPath = process.argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--verify") {
      parsed.verify = true;
      continue;
    }
  }
  return parsed;
}

function loadConfig(configPath) {
  const absolutePath = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.cwd(), configPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Missing config file: ${absolutePath}`);
  }
  const ext = path.extname(absolutePath).toLowerCase();
  if (ext === ".json") {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  }
  return require(absolutePath);
}

function requireField(config, key) {
  if (config[key] == null || config[key] === "") {
    throw new Error(`Config field is required: ${key}`);
  }
  return config[key];
}

function normalizeAddress(addr, fallbackLabel) {
  if (!addr) {
    throw new Error(`Address is required: ${fallbackLabel}`);
  }
  return web3.utils.toChecksumAddress(addr);
}

function assertBps(name, value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0 || v > 10_000) {
    throw new Error(`${name} must be in [0, 10000], got ${value}`);
  }
}

function assertUint(name, value) {
  if (value == null) {
    throw new Error(`${name} must be set`);
  }
  const bn = web3.utils.toBN(String(value));
  if (bn.lt(web3.utils.toBN("0"))) {
    throw new Error(`${name} must be non-negative`);
  }
}

function writeSnapshot(snapshotPath, payload) {
  const targetDir = path.dirname(snapshotPath);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify(payload, null, 2));
}

function resolveAddresses(addressesPath) {
  const absolute = addressesPath
    ? path.isAbsolute(addressesPath)
      ? addressesPath
      : path.join(process.cwd(), addressesPath)
    : path.join(process.cwd(), "test/test-config.js");
  return require(absolute);
}

function resolveSnapshotPath(config, chainId) {
  if (config.snapshotPath) {
    return path.isAbsolute(config.snapshotPath)
      ? config.snapshotPath
      : path.join(process.cwd(), config.snapshotPath);
  }
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const name = `${config.name || config.strategyName || "cl-vault"}-${chainId}-${stamp}.json`;
  return path.join(process.cwd(), "scripts/deployments/cl", name);
}

async function maybeVerify(enableVerify, deployment) {
  if (!enableVerify) {
    return;
  }
  await hre.run("verify:verify", { address: deployment.strategyImpl });
  if (deployment.wrapper0) {
    await hre.run("verify:verify", {
      address: deployment.wrapper0,
      constructorArguments: [deployment.storage, deployment.vault, true],
    });
  }
  if (deployment.wrapper1) {
    await hre.run("verify:verify", {
      address: deployment.wrapper1,
      constructorArguments: [deployment.storage, deployment.vault, false],
    });
  }
}

async function main() {
  const args = parseArgs();
  if (!args.configPath) {
    throw new Error("Config-driven deploy required. Use: --config <path-to-json-or-js>");
  }

  const config = loadConfig(args.configPath);
  const addresses = resolveAddresses(config.addressesPath);
  const [deployer] = await web3.eth.getAccounts();
  const net = await web3.eth.net.getId();
  const chainId = await web3.eth.getChainId();

  const posId = requireField(config, "posId");
  const posManager = normalizeAddress(requireField(config, "posManager"), "posManager");
  const targetWidth = requireField(config, "targetWidth");
  const strategyName = requireField(config, "strategyName");

  const rebalance = config.rebalance || {};
  const strategyConfig = config.strategy || {};
  const wrappers = config.wrappers || { deploy: false };

  assertUint("rebalance.cooldown", rebalance.cooldown);
  assertBps("rebalance.maxSwapBps", rebalance.maxSwapBps);
  assertBps("rebalance.maxSlippageBps", rebalance.maxSlippageBps);
  assertBps("rebalance.maxTwapDeviationBps", rebalance.maxTwapDeviationBps);
  assertUint("rebalance.twapWindow", rebalance.twapWindow);

  const rebalanceExecutor = normalizeAddress(
    rebalance.executor || rebalance.rebalanceExecutor || addresses.Governance,
    "rebalance.executor"
  );
  const governance = normalizeAddress(addresses.Governance, "addresses.Governance");

  const minRewardToCompound = String(strategyConfig.minRewardToCompound == null ? "1" : strategyConfig.minRewardToCompound);

  console.log("CL vault deploy (config-driven)");
  console.log(`networkId=${net} chainId=${chainId} deployer=${deployer}`);

  const vaultProxy = await type2Transaction(VaultProxy.new, addresses.CLVaultImplementation);
  const vaultAddr = vaultProxy.creates;
  const vault = await Vault.at(vaultAddr);
  console.log("Vault Proxy deployed at:", vaultAddr);

  const posManagerContract = await IPosManager.at(posManager);
  await type2Transaction(posManagerContract.approve, vaultAddr, posId);
  await type2Transaction(vault.initializeVault, addresses.Storage, posId, posManager, targetWidth);

  let helperAddress = config.rebalanceHelper;
  if (!helperAddress) {
    if (!config.deploySharedHelper) {
      throw new Error("Config requires rebalanceHelper (shared) or deploySharedHelper=true for first deployment");
    }
    const helper = await type2Transaction(CLRebalanceHelper.new);
    helperAddress = helper.creates;
    console.log("Shared CLRebalanceHelper deployed:", helperAddress);
  }
  helperAddress = normalizeAddress(helperAddress, "rebalanceHelper");
  await type2Transaction(vault.setRebalanceHelper, helperAddress);

  await type2Transaction(
    vault.setRebalanceSafetyConfig,
    rebalance.maxSwapBps,
    rebalance.maxSlippageBps,
    rebalance.twapWindow,
    rebalance.maxTwapDeviationBps
  );

  await type2Transaction(
    vault.setRebalanceConfig,
    rebalance.deviation || 0,
    rebalance.cooldown,
    rebalanceExecutor
  );

  console.log("Vault initialized with CL position", posId);

  const StrategyImpl = artifacts.require(strategyName);
  const impl = await type2Transaction(StrategyImpl.new);
  console.log("Strategy Implementation deployed at:", impl.creates);

  const StrategyProxy = artifacts.require("StrategyProxy");
  const proxy = await type2Transaction(StrategyProxy.new, impl.creates);
  console.log("Strategy Proxy deployed at:", proxy.creates);

  const strategy = await StrategyImpl.at(proxy.creates);
  await type2Transaction(strategy.initializeStrategy, addresses.Storage, vaultAddr);
  const rewardToken = await strategy.rewardToken();
  await type2Transaction(strategy.setMinRewardToCompound, rewardToken, minRewardToCompound);

  await type2Transaction(vault.setStrategy, proxy.creates);

  await validateCLVaultWiring({
    vault,
    strategy,
    posId,
    posManager,
    targetWidth,
    deployer,
    expected: {
      rebalanceSafety: {
        maxSwapBps: rebalance.maxSwapBps,
        maxSlippageBps: rebalance.maxSlippageBps,
        twapWindow: rebalance.twapWindow,
        maxTwapDeviationBps: rebalance.maxTwapDeviationBps,
      },
      rebalanceConfig: {
        cooldown: rebalance.cooldown,
        executor: rebalanceExecutor,
      },
      strategy: {
        minRewardToCompound,
      },
    },
  });

  let wrapper0 = null;
  let wrapper1 = null;
  if (wrappers.deploy) {
    wrapper0 = await type2Transaction(CLWrapper.new, addresses.Storage, vaultAddr, true);
    wrapper1 = await type2Transaction(CLWrapper.new, addresses.Storage, vaultAddr, false);
    console.log("Wrapper 0 deployed at:", wrapper0.creates);
    console.log("Wrapper 1 deployed at:", wrapper1.creates);
  }

  const snapshotPath = resolveSnapshotPath(config, chainId);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    network: {
      hardhatNetworkName: hre.network.name,
      chainId,
      networkId: net,
    },
    deployer,
    addresses: {
      storage: addresses.Storage,
      governance,
      controller: addresses.Controller,
      vaultImplementation: addresses.CLVaultImplementation,
      vault: vaultAddr,
      strategy: proxy.creates,
      strategyImplementation: impl.creates,
      helper: helperAddress,
      wrapper0: wrapper0 ? wrapper0.creates : null,
      wrapper1: wrapper1 ? wrapper1.creates : null,
    },
    config: {
      posId: String(posId),
      posManager,
      targetWidth: String(targetWidth),
      strategyName,
      rebalance: {
        deviation: String(rebalance.deviation || 0),
        cooldown: String(rebalance.cooldown),
        executor: rebalanceExecutor,
        maxSwapBps: String(rebalance.maxSwapBps),
        maxSlippageBps: String(rebalance.maxSlippageBps),
        twapWindow: String(rebalance.twapWindow),
        maxTwapDeviationBps: String(rebalance.maxTwapDeviationBps),
      },
      strategy: {
        rewardToken,
        minRewardToCompound,
      },
      wrappers: {
        deploy: !!wrappers.deploy,
      },
    },
  };
  writeSnapshot(snapshotPath, snapshot);
  console.log(`Deployment snapshot written: ${snapshotPath}`);

  await maybeVerify(args.verify || config.verify, {
    vault: vaultAddr,
    storage: addresses.Storage,
    strategyImpl: impl.creates,
    wrapper0: wrapper0 ? wrapper0.creates : null,
    wrapper1: wrapper1 ? wrapper1.creates : null,
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
