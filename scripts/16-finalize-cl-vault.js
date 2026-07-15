// Finalize a CL vault deployment that was deployed with `useSetupStorage: true, finalizeStorage: false`.
// Reads the snapshot JSON written by 12-deploy-CL-vault.js, then flips every Controllable
// contract (vault, strategy, wrappers) from setupStorage → addresses.Storage. The deployer EOA
// must still be governance on setupStorage at the time this runs.
//
// Usage:
//   CL_SNAPSHOT=scripts/deployments/cl/pilot-cbeth-eth.json \
//     npx hardhat run --network base scripts/16-finalize-cl-vault.js
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { type2Transaction } = require("./utils.js");

const Vault = artifacts.require("CLVault");
const Strategy = artifacts.require("BaseUpgradeableStrategyCL");
const CLWrapper = artifacts.require("CLWrapper");

function ensureHardhatRunner() {
  if (typeof artifacts === "undefined" || typeof artifacts.require !== "function") {
    throw new Error("Run via Hardhat: `npx hardhat run --network base scripts/16-finalize-cl-vault.js`");
  }
}

function loadSnapshot(p) {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  if (!fs.existsSync(abs)) throw new Error(`Missing snapshot file: ${abs}`);
  return { abs, json: JSON.parse(fs.readFileSync(abs, "utf8")) };
}

async function main() {
  ensureHardhatRunner();
  const snapshotPath = process.env.CL_SNAPSHOT;
  if (!snapshotPath) throw new Error("Set CL_SNAPSHOT=<path-to-snapshot.json>");
  const { abs, json } = loadSnapshot(snapshotPath);

  const [deployer] = await web3.eth.getAccounts();
  console.log(`Finalize storage bridge for snapshot ${abs}`);
  console.log(`deployer=${deployer}`);

  if (!json.bridge || !json.bridge.used) throw new Error("Snapshot reports useSetupStorage=false — nothing to finalize");
  if (json.bridge.finalized) {
    console.log("Snapshot already marks finalized=true; aborting to avoid double-flip.");
    return;
  }

  const realStorage = json.addresses.storage;
  const setupStorage = json.addresses.setupStorage;
  if (!realStorage || !setupStorage) throw new Error("Missing storage / setupStorage in snapshot.addresses");
  if (realStorage.toLowerCase() === setupStorage.toLowerCase()) {
    throw new Error("storage and setupStorage are identical — nothing to flip");
  }

  const vault = await Vault.at(json.addresses.vault);
  const strategy = await Strategy.at(json.addresses.strategy);
  const wrapper0 = json.addresses.wrapper0 ? await CLWrapper.at(json.addresses.wrapper0) : null;
  const wrapper1 = json.addresses.wrapper1 ? await CLWrapper.at(json.addresses.wrapper1) : null;

  console.log(`Flipping storage: ${setupStorage} -> ${realStorage}`);
  await type2Transaction(vault.setStorage, realStorage);
  await type2Transaction(strategy.setStorage, realStorage);
  if (wrapper0) await type2Transaction(wrapper0.setStorage, realStorage);
  if (wrapper1) await type2Transaction(wrapper1.setStorage, realStorage);

  const expectedGov = web3.utils.toChecksumAddress(json.addresses.governance);
  const checks = [["vault", await vault.governance()], ["strategy", await strategy.governance()]];
  if (wrapper0) checks.push(["wrapper0", await wrapper0.governance()]);
  if (wrapper1) checks.push(["wrapper1", await wrapper1.governance()]);
  for (const [name, gov] of checks) {
    if (web3.utils.toChecksumAddress(gov) !== expectedGov) {
      throw new Error(`Post-flip ${name}.governance()=${gov}, expected ${expectedGov}`);
    }
  }

  // Update snapshot in place so future runs / audits see the finalized state.
  json.bridge.finalized = true;
  json.bridge.currentStorage = realStorage;
  json.bridge.finalizedAt = new Date().toISOString();
  fs.writeFileSync(abs, JSON.stringify(json, null, 2));
  console.log("Bridge finalized; snapshot updated.");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
