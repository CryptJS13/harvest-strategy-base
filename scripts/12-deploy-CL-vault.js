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
const Storage = artifacts.require("Storage");

function parseArgs() {
  // Hardhat's `run` command consumes ALL CLI flags itself and rejects unknown ones with HH305,
  // so we can't reliably pass `--config <path>` through to this script. The CL_CONFIG /
  // CL_VERIFY environment variables are the canonical way to drive this deploy. CLI flags are
  // still parsed below as a courtesy when the script is run directly (e.g. `node scripts/...`),
  // but that path requires the Hardhat globals to be set up some other way.
  const parsed = {};
  if (process.env.CL_CONFIG) parsed.configPath = process.env.CL_CONFIG;
  if (process.env.CL_VERIFY === "true" || process.env.CL_VERIFY === "1") parsed.verify = true;
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

function ensureHardhatRunner() {
  if (typeof artifacts === "undefined" || typeof artifacts.require !== "function") {
    throw new Error(
      "This script must be invoked through Hardhat's runner so that the `artifacts` global is set.\n" +
      "  Wrong: node scripts/12-deploy-CL-vault.js\n" +
      "  Right: CL_CONFIG=scripts/config/pilot-cbeth-eth.json \\\n" +
      "         npx hardhat run --network base scripts/12-deploy-CL-vault.js"
    );
  }
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
  ensureHardhatRunner();
  const args = parseArgs();
  if (!args.configPath) {
    throw new Error(
      "Config-driven deploy required. Use the CL_CONFIG environment variable:\n" +
      "  CL_CONFIG=<path-to-json> CL_VERIFY=true \\\n" +
      "    npx hardhat run --network base scripts/12-deploy-CL-vault.js\n" +
      "(`npx hardhat run` does not pass through extra CLI flags — it rejects them with HH305.)"
    );
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

  // ---- Storage-bridge handling --------------------------------------------------------------
  // When the deployer EOA is NOT the protocol's real governance (typical for multisig-governed
  // deployments), the deployer can't call any `onlyGovernance` setter. The bridge pattern below
  // uses a pre-deployed `Storage` whose governance is the deployer for all setup steps, then
  // flips every Controllable contract onto the real `Storage` as a final step. Once flipped,
  // the deployer EOA has no remaining powers over the deployed vault stack.
  //
  // The bridge Storage is deployed ONCE via scripts/15-deploy-setup-storage.js and its address
  // is recorded in test/test-config.js (`SetupStorage`) so all subsequent CL deployments reuse
  // it. A per-config override (`setupStorageAddress`) is also accepted.
  const useSetupStorage = config.useSetupStorage !== false;        // default ON; opt out with `false`
  const finalizeStorage = config.finalizeStorage !== false;        // default ON; set false to leave on setupStorage for inspection
  let setupStorageAddr;
  if (useSetupStorage) {
    const provided = config.setupStorageAddress || addresses.SetupStorage;
    if (!provided || /^0x0{40}$/i.test(provided)) {
      throw new Error(
        "Bridge Storage required but not configured. Either:\n" +
        "  (a) deploy one via `npx hardhat run --network base scripts/15-deploy-setup-storage.js`\n" +
        "      and paste its address into test/test-config.js under `SetupStorage`, or\n" +
        "  (b) set `setupStorageAddress` in the deploy config, or\n" +
        "  (c) set `useSetupStorage: false` if the deployer EOA is already the protocol's governance."
      );
    }
    setupStorageAddr = normalizeAddress(provided, "setupStorage");

    // Verify on-chain that the deployer is the bridge's governance — otherwise every
    // onlyGovernance setter below would revert with the same generic "Not governance" error
    // and the failure mode would be hard to diagnose.
    const bridge = await Storage.at(setupStorageAddr);
    const bridgeGov = web3.utils.toChecksumAddress(await bridge.governance());
    if (bridgeGov !== web3.utils.toChecksumAddress(deployer)) {
      throw new Error(
        `Bridge Storage ${setupStorageAddr} governance is ${bridgeGov}, deployer is ${deployer}.\n` +
        "The bridge must be governed by the deployer for the setup steps to succeed."
      );
    }
    console.log(`Bridge Storage in use (governance = deployer): ${setupStorageAddr}`);
  } else {
    setupStorageAddr = addresses.Storage;
    console.log("Bridge Storage disabled — using addresses.Storage directly (deployer must be governance)");
  }
  // ------------------------------------------------------------------------------------------

  const vaultProxy = await type2Transaction(VaultProxy.new, addresses.CLVaultImplementation);
  const vaultAddr = vaultProxy.creates;
  const vault = await Vault.at(vaultAddr);
  console.log("Vault Proxy deployed at:", vaultAddr);

  const posManagerContract = await IPosManager.at(posManager);
  await type2Transaction(posManagerContract.approve, vaultAddr, posId);
  await type2Transaction(vault.initializeVault, setupStorageAddr, posId, posManager, targetWidth);

  // Treat both an unset field and the literal zero-address string as "not provided" —
  // otherwise the script silently calls setRebalanceHelper(0) and the vault reverts with
  // ErrZeroAddress, which previously surfaced as a misleading _deposit stack frame.
  let helperAddress = config.rebalanceHelper;
  const helperIsZero = !helperAddress || /^0x0{40}$/i.test(String(helperAddress));
  if (helperIsZero) {
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
  await type2Transaction(strategy.initializeStrategy, setupStorageAddr, vaultAddr);

  // Read rewardToken with a short retry. Some Base RPC providers (Alchemy, public endpoint)
  // load-balance reads across replicas; the replica handling our view can lag the one that
  // accepted the previous tx by a few seconds, returning a stale `address(0)` for the freshly-
  // initialized slot. The strategy contract revert ('token') on setMinRewardToCompound(0,...)
  // is the symptom we're protecting against. A config override `strategy.rewardToken` skips
  // the chain read entirely.
  let rewardToken = strategyConfig.rewardToken
    ? normalizeAddress(strategyConfig.rewardToken, "strategy.rewardToken")
    : null;
  if (!rewardToken) {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const got = await strategy.rewardToken();
      if (got && got !== "0x0000000000000000000000000000000000000000") {
        rewardToken = got;
        break;
      }
      console.log(`  rewardToken read returned 0x0 (attempt ${attempt}/6); retrying in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  if (!rewardToken) {
    throw new Error(
      "strategy.rewardToken() never returned a non-zero address after init. RPC likely lagging.\n" +
      "Workaround: set `strategy.rewardToken` explicitly in your deploy config (e.g. AERO = 0x940181a94A35A4569E4529A3CDfB74e38FD98631 on Base)."
    );
  }
  console.log(`Strategy rewardToken resolved: ${rewardToken}`);
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
  let wrapper0Addr = null;
  let wrapper1Addr = null;
  if (wrappers.deploy) {
    const w0Tx = await type2Transaction(CLWrapper.new, setupStorageAddr, vaultAddr, true);
    const w1Tx = await type2Transaction(CLWrapper.new, setupStorageAddr, vaultAddr, false);
    wrapper0Addr = w0Tx.creates;
    wrapper1Addr = w1Tx.creates;
    wrapper0 = await CLWrapper.at(wrapper0Addr);
    wrapper1 = await CLWrapper.at(wrapper1Addr);
    console.log("Wrapper 0 deployed at:", wrapper0Addr);
    console.log("Wrapper 1 deployed at:", wrapper1Addr);
  }

  // ---- Finalize: flip every Controllable contract from setupStorage → realStorage -----------
  // Each contract is independently flipped; the order doesn't matter because none of these
  // calls touch each other's storage. We verify the post-flip governance() view at the end.
  let bridgeFinalized = false;
  if (useSetupStorage && finalizeStorage) {
    if (setupStorageAddr.toLowerCase() === addresses.Storage.toLowerCase()) {
      throw new Error("setupStorage and addresses.Storage are identical — nothing to finalize");
    }
    console.log("Finalizing storage bridge → flipping every Controllable to addresses.Storage");
    await type2Transaction(vault.setStorage, addresses.Storage);
    await type2Transaction(strategy.setStorage, addresses.Storage);
    if (wrapper0) await type2Transaction(wrapper0.setStorage, addresses.Storage);
    if (wrapper1) await type2Transaction(wrapper1.setStorage, addresses.Storage);

    // Verify each contract now resolves governance() through the real Storage's multisig.
    const expectedGov = web3.utils.toChecksumAddress(addresses.Governance);
    const checks = [
      ["vault", await vault.governance()],
      ["strategy", await strategy.governance()],
    ];
    if (wrapper0) checks.push(["wrapper0", await wrapper0.governance()]);
    if (wrapper1) checks.push(["wrapper1", await wrapper1.governance()]);
    for (const [name, gov] of checks) {
      if (web3.utils.toChecksumAddress(gov) !== expectedGov) {
        throw new Error(`Bridge finalize: ${name}.governance() = ${gov}, expected ${expectedGov}`);
      }
    }
    bridgeFinalized = true;
    console.log("Bridge finalize verified: vault/strategy/wrappers all resolve governance through addresses.Storage");
  } else if (useSetupStorage && !finalizeStorage) {
    console.log("Bridge finalize SKIPPED (finalizeStorage=false). Run scripts/16-finalize-cl-vault.js when ready.");
  }
  // ------------------------------------------------------------------------------------------

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
      wrapper0: wrapper0Addr,
      wrapper1: wrapper1Addr,
      setupStorage: useSetupStorage ? setupStorageAddr : null,
    },
    bridge: {
      used: useSetupStorage,
      finalized: bridgeFinalized,
      currentStorage: bridgeFinalized || !useSetupStorage ? addresses.Storage : setupStorageAddr,
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
    wrapper0: wrapper0Addr,
    wrapper1: wrapper1Addr,
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
