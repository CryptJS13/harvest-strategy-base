// Recover a half-deployed CL vault. Picks up after a failure in 12-deploy-CL-vault.js by
// taking the addresses of the already-deployed bridge / vault / helper / strategy from a
// config file, and runs only the steps that still need to happen:
//   - setMinRewardToCompound on the strategy (idempotent — skipped if already set)
//   - vault.setStrategy(strategy) (skipped if already set)
//   - deploy wrappers (skipped if already provided in config.recovery.wrapper0/wrapper1)
//   - finalize bridge: setStorage(realStorage) on vault, strategy, wrappers
//   - write a fresh snapshot
//   - run Basescan verification
//
// Every governance-gated step uses the bridge Storage (governance = deployer EOA) so the
// recovery EOA must match. After finalize, the bridge no longer governs anything.
//
// Usage:
//   CL_CONFIG=scripts/config/pilot-cbeth-eth.recovery.json CL_VERIFY=true \
//     npx hardhat run --network base scripts/13-recover-cl-vault.js
//
// Config schema (extends 12's config — keep all original fields and add `recovery`):
//   {
//     ... usual fields (strategyName, strategy.minRewardToCompound, etc.) ...
//     "recovery": {
//       "vault":         "0x...",   // required
//       "strategy":      "0x...",   // required
//       "strategyImpl":  "0x...",   // optional, only used for Basescan verification
//       "helper":        "0x...",   // optional, only used for snapshot
//       "wrapper0":      "0x...",   // optional, skip deploy if provided
//       "wrapper1":      "0x..."    // optional, skip deploy if provided
//     }
//   }
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { type2Transaction } = require("./utils.js");

const Vault = artifacts.require("CLVault");
const CLWrapper = artifacts.require("CLWrapper");
const Storage = artifacts.require("Storage");

const ZERO = "0x0000000000000000000000000000000000000000";

function ensureHardhatRunner() {
  if (typeof artifacts === "undefined" || typeof artifacts.require !== "function") {
    throw new Error("Run via Hardhat: `npx hardhat run --network base scripts/13-recover-cl-vault.js`");
  }
}

function parseArgs() {
  const parsed = {};
  if (process.env.CL_CONFIG) parsed.configPath = process.env.CL_CONFIG;
  if (process.env.CL_VERIFY === "true" || process.env.CL_VERIFY === "1") parsed.verify = true;
  return parsed;
}

function loadConfig(configPath) {
  const abs = path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
  if (!fs.existsSync(abs)) throw new Error(`Missing config: ${abs}`);
  const ext = path.extname(abs).toLowerCase();
  return ext === ".json" ? JSON.parse(fs.readFileSync(abs, "utf8")) : require(abs);
}

function resolveAddresses(addressesPath) {
  const abs = addressesPath
    ? path.isAbsolute(addressesPath) ? addressesPath : path.join(process.cwd(), addressesPath)
    : path.join(process.cwd(), "test/test-config.js");
  return require(abs);
}

function normalizeAddress(addr, label) {
  if (!addr) throw new Error(`Address required: ${label}`);
  return web3.utils.toChecksumAddress(addr);
}

function isZeroAddr(addr) {
  return !addr || /^0x0{40}$/i.test(String(addr));
}

function resolveSnapshotPath(config, chainId) {
  if (config.snapshotPath) {
    return path.isAbsolute(config.snapshotPath)
      ? config.snapshotPath
      : path.join(process.cwd(), config.snapshotPath);
  }
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const name = `${config.name || "cl-vault"}-recovery-${chainId}-${stamp}.json`;
  return path.join(process.cwd(), "scripts/deployments/cl", name);
}

function writeSnapshot(p, payload) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(payload, null, 2));
}

async function main() {
  ensureHardhatRunner();
  const args = parseArgs();
  if (!args.configPath) {
    throw new Error("Set CL_CONFIG=<path-to-recovery-config.json>");
  }
  const config = loadConfig(args.configPath);
  const addresses = resolveAddresses(config.addressesPath);
  const [deployer] = await web3.eth.getAccounts();
  const chainId = await web3.eth.getChainId();

  const rec = config.recovery || {};
  if (!rec.vault || !rec.strategy) {
    throw new Error("config.recovery must include `vault` and `strategy` addresses");
  }
  const vaultAddr = normalizeAddress(rec.vault, "recovery.vault");
  const strategyAddr = normalizeAddress(rec.strategy, "recovery.strategy");
  const strategyImplAddr = rec.strategyImpl ? normalizeAddress(rec.strategyImpl, "recovery.strategyImpl") : null;
  const helperAddr = rec.helper ? normalizeAddress(rec.helper, "recovery.helper") : null;
  let wrapper0Addr = rec.wrapper0 ? normalizeAddress(rec.wrapper0, "recovery.wrapper0") : null;
  let wrapper1Addr = rec.wrapper1 ? normalizeAddress(rec.wrapper1, "recovery.wrapper1") : null;

  console.log(`CL vault RECOVERY (chainId=${chainId}, deployer=${deployer})`);
  console.log(`  vault    = ${vaultAddr}`);
  console.log(`  strategy = ${strategyAddr}`);

  // Verify the bridge currently governs both vault and strategy (i.e. EOA can still execute).
  const vault = await Vault.at(vaultAddr);
  const StrategyImpl = artifacts.require(config.strategyName);
  const strategy = await StrategyImpl.at(strategyAddr);
  const vaultGov = await vault.governance();
  const strategyGov = await strategy.governance();
  if (vaultGov.toLowerCase() !== deployer.toLowerCase() && strategyGov.toLowerCase() !== deployer.toLowerCase()) {
    throw new Error(
      `Neither vault.governance(${vaultGov}) nor strategy.governance(${strategyGov}) match deployer ${deployer}.\n` +
      "If you've already finalized this deploy, the bridge is no longer in play — every remaining step needs the real governance multisig instead."
    );
  }

  // ---- Step 1: setMinRewardToCompound on the strategy (idempotent) -------------------------
  const strategyConfig = config.strategy || {};
  const minRewardToCompound = String(strategyConfig.minRewardToCompound == null ? "10000000000000000" : strategyConfig.minRewardToCompound);
  let rewardToken = strategyConfig.rewardToken
    ? normalizeAddress(strategyConfig.rewardToken, "strategy.rewardToken")
    : null;
  if (!rewardToken) {
    for (let i = 1; i <= 6; i++) {
      const got = await strategy.rewardToken();
      if (got && got !== ZERO) { rewardToken = got; break; }
      console.log(`  rewardToken read returned 0x0 (attempt ${i}/6); retrying in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  if (!rewardToken) {
    throw new Error("strategy.rewardToken() returned 0x0 after retries. Set `strategy.rewardToken` in the recovery config (e.g. AERO = 0x940181a94A35A4569E4529A3CDfB74e38FD98631).");
  }
  const existingThreshold = await strategy.minRewardToCompound(rewardToken);
  if (existingThreshold.toString() === minRewardToCompound) {
    console.log(`  minRewardToCompound already = ${minRewardToCompound}; skipping`);
  } else {
    console.log(`  minRewardToCompound: ${existingThreshold.toString()} -> ${minRewardToCompound}`);
    await type2Transaction(strategy.setMinRewardToCompound, rewardToken, minRewardToCompound);
  }

  // ---- Step 2: vault.setStrategy(strategy) (idempotent) ------------------------------------
  const currentVaultStrategy = await vault.strategy();
  if (currentVaultStrategy.toLowerCase() === strategyAddr.toLowerCase()) {
    console.log(`  vault.strategy already = ${strategyAddr}; skipping`);
  } else if (currentVaultStrategy === ZERO) {
    console.log(`  vault.setStrategy(${strategyAddr})`);
    await type2Transaction(vault.setStrategy, strategyAddr);
  } else {
    throw new Error(`vault.strategy is ${currentVaultStrategy} (not zero, not our strategy). Aborting to avoid overwriting an active strategy.`);
  }

  // ---- Step 3: deploy wrappers (skipped if already provided) -------------------------------
  // Wrappers are constructed with the bridge Storage (so the deployer can flip them onto
  // addresses.Storage in Step 4). If the deploy already produced wrappers, just attach to them.
  const wrappersCfg = config.wrappers || { deploy: false };
  let wrapper0 = null, wrapper1 = null;
  if (wrappersCfg.deploy) {
    const setupStorage = web3.utils.toChecksumAddress(addresses.SetupStorage);
    if (!wrapper0Addr) {
      const w0Tx = await type2Transaction(CLWrapper.new, setupStorage, vaultAddr, true);
      wrapper0Addr = w0Tx.creates;
      console.log(`  Wrapper0 deployed: ${wrapper0Addr}`);
    } else {
      console.log(`  Wrapper0 already deployed: ${wrapper0Addr}`);
    }
    if (!wrapper1Addr) {
      const w1Tx = await type2Transaction(CLWrapper.new, setupStorage, vaultAddr, false);
      wrapper1Addr = w1Tx.creates;
      console.log(`  Wrapper1 deployed: ${wrapper1Addr}`);
    } else {
      console.log(`  Wrapper1 already deployed: ${wrapper1Addr}`);
    }
    wrapper0 = await CLWrapper.at(wrapper0Addr);
    wrapper1 = await CLWrapper.at(wrapper1Addr);
  }

  // ---- Step 4: finalize bridge — flip every Controllable to addresses.Storage --------------
  const realStorage = web3.utils.toChecksumAddress(addresses.Storage);
  const expectedGov = web3.utils.toChecksumAddress(addresses.Governance);

  // Idempotent: skip flipping anything that's already on the real Storage.
  if (vaultGov.toLowerCase() !== expectedGov.toLowerCase()) {
    console.log(`  vault.setStorage(${realStorage})`);
    await type2Transaction(vault.setStorage, realStorage);
  } else {
    console.log(`  vault already resolves governance to multisig; skipping setStorage`);
  }
  if (strategyGov.toLowerCase() !== expectedGov.toLowerCase()) {
    console.log(`  strategy.setStorage(${realStorage})`);
    await type2Transaction(strategy.setStorage, realStorage);
  } else {
    console.log(`  strategy already resolves governance to multisig; skipping setStorage`);
  }
  if (wrapper0) {
    const g = await wrapper0.governance();
    if (g.toLowerCase() !== expectedGov.toLowerCase()) {
      console.log(`  wrapper0.setStorage(${realStorage})`);
      await type2Transaction(wrapper0.setStorage, realStorage);
    } else {
      console.log(`  wrapper0 already on real Storage; skipping`);
    }
  }
  if (wrapper1) {
    const g = await wrapper1.governance();
    if (g.toLowerCase() !== expectedGov.toLowerCase()) {
      console.log(`  wrapper1.setStorage(${realStorage})`);
      await type2Transaction(wrapper1.setStorage, realStorage);
    } else {
      console.log(`  wrapper1 already on real Storage; skipping`);
    }
  }

  // ---- Step 5: verify -----------------------------------------------------------------------
  const checks = [
    ["vault", await vault.governance()],
    ["strategy", await strategy.governance()],
  ];
  if (wrapper0) checks.push(["wrapper0", await wrapper0.governance()]);
  if (wrapper1) checks.push(["wrapper1", await wrapper1.governance()]);
  for (const [name, gov] of checks) {
    if (web3.utils.toChecksumAddress(gov) !== expectedGov) {
      throw new Error(`Post-flip ${name}.governance()=${gov}, expected ${expectedGov}`);
    }
  }
  console.log("Finalize verified: vault/strategy/wrappers all resolve governance through addresses.Storage");

  // ---- Step 6: snapshot ---------------------------------------------------------------------
  const snapshotPath = resolveSnapshotPath(config, chainId);
  writeSnapshot(snapshotPath, {
    generatedAt: new Date().toISOString(),
    network: { hardhatNetworkName: hre.network.name, chainId },
    deployer,
    addresses: {
      storage: realStorage,
      governance: expectedGov,
      controller: addresses.Controller,
      vaultImplementation: addresses.CLVaultImplementation,
      vault: vaultAddr,
      strategy: strategyAddr,
      strategyImplementation: strategyImplAddr,
      helper: helperAddr,
      wrapper0: wrapper0Addr,
      wrapper1: wrapper1Addr,
      setupStorage: addresses.SetupStorage,
    },
    bridge: { used: true, finalized: true, currentStorage: realStorage, finalizedAt: new Date().toISOString() },
    config: {
      strategyName: config.strategyName,
      strategy: { rewardToken, minRewardToCompound },
      wrappers: { deploy: !!wrappersCfg.deploy },
    },
    recovery: true,
  });
  console.log(`Recovery snapshot written: ${snapshotPath}`);

  // ---- Step 7: optional Basescan verification -----------------------------------------------
  if (args.verify || config.verify) {
    if (strategyImplAddr) {
      try { await hre.run("verify:verify", { address: strategyImplAddr }); }
      catch (e) { console.log("  strategy impl verify skipped:", e.message.split("\n")[0]); }
    }
    if (wrapper0Addr) {
      try { await hre.run("verify:verify", { address: wrapper0Addr, constructorArguments: [realStorage, vaultAddr, true] }); }
      catch (e) { console.log("  wrapper0 verify skipped:", e.message.split("\n")[0]); }
    }
    if (wrapper1Addr) {
      try { await hre.run("verify:verify", { address: wrapper1Addr, constructorArguments: [realStorage, vaultAddr, false] }); }
      catch (e) { console.log("  wrapper1 verify skipped:", e.message.split("\n")[0]); }
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
