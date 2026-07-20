// Deployer-wallet prep for upgrading the LIVE Aave cbETH/ETH fold deployment.
//
// This script performs ONLY the deployer's actions: it deploys the new
// implementation contracts (it does NOT touch the proxies, the position, or
// governance state). After it runs, GOVERNANCE (the msig) does the timelocked
// scheduleUpgrade + upgrade calls printed at the end.
//
// Deployer actions:
//   1. Deploy AaveReserveLib (or reuse an existing one via AAVE_RESERVE_LIB env).
//   2. Link it and deploy the new strategy implementation.
//   3. Deploy the new FoldVaultV2 implementation.
//   4. Verify both on the explorer.
// The proxies (strategy 0xcfd2…, vault 0xE78285…) already exist and are reused
// by the upgrade — nothing here is initialized.
//
//   npx hardhat run scripts/16-prepare-fold-upgrade.js --network mainnet
//   (optionally: AAVE_RESERVE_LIB=0x... to reuse an already-deployed library)

const hre = require("hardhat");
const { type2Transaction } = require("./utils.js");

// --- The live deployment being upgraded (Base mainnet) ---------------------
const STRATEGY_PROXY = "0xcfd2f32E6d533653cEd5Ba7E5fe1a76C3c626757";
const VAULT_PROXY = "0xE78285A51f51916F2311B7017Db036D8351F3Cf9";
const GOVERNANCE = "0x920b1aCb7618B553324aa0F71620226FA2e09870"; // msig that runs the upgrade
const STRATEGY_NAME = "Aave2AssetFoldStrategyMainnet_ETH_cbETH";  // same variant as deployed

async function main() {
  console.log("=== Deployer prep: Aave cbETH/ETH fold upgrade ===\n");

  // 1) AaveReserveLib — deploy fresh, or reuse a pre-deployed one.
  const AaveReserveLib = artifacts.require("AaveReserveLib");
  let libAddress = process.env.AAVE_RESERVE_LIB;
  if (libAddress) {
    console.log("Reusing existing AaveReserveLib at:", libAddress);
  } else {
    const lib = await type2Transaction(AaveReserveLib.new);
    libAddress = lib.creates;
    console.log("1) AaveReserveLib deployed at:      ", libAddress);
  }
  const libInstance = await AaveReserveLib.at(libAddress);

  // 2) New strategy implementation (references AaveReserveLib, so link first).
  const StrategyImpl = artifacts.require(STRATEGY_NAME);
  StrategyImpl.link(libInstance);
  const strat = await type2Transaction(StrategyImpl.new);
  console.log("2) New strategy impl deployed at:   ", strat.creates);

  // 3) New FoldVaultV2 implementation (no constructor args, no library).
  const FoldVaultV2 = artifacts.require("FoldVaultV2");
  const vaultImpl = await type2Transaction(FoldVaultV2.new);
  console.log("3) New FoldVaultV2 impl deployed at: ", vaultImpl.creates);

  // 4) Verify both on the explorer (best-effort; won't abort on failure).
  try {
    await hre.run("verify:verify", {
      address: strat.creates,
      libraries: { AaveReserveLib: libAddress },
    });
    console.log("   verified strategy impl");
  } catch (e) {
    console.log("   strategy verify skipped/failed:", e.message);
  }
  try {
    await hre.run("verify:verify", { address: vaultImpl.creates });
    console.log("   verified FoldVaultV2 impl");
  } catch (e) {
    console.log("   FoldVaultV2 verify skipped/failed:", e.message);
  }

  // --- Hand-off to governance ------------------------------------------------
  console.log("\n=== Deployer done. Governance (%s) next: ===", GOVERNANCE);
  console.log("Order-independent (the deployed strategy & vault already implement");
  console.log("preInteract, so neither upgrade bricks the other). Each has a 12h timelock.\n");
  console.log("Strategy upgrade:");
  console.log(`  1. IUpgradeSource(${STRATEGY_PROXY}).scheduleUpgrade(${strat.creates})`);
  console.log(`  2. (wait nextImplementationDelay, ~12h)`);
  console.log(`  3. StrategyProxy(${STRATEGY_PROXY}).upgrade()`);
  console.log("\nVault upgrade:");
  console.log(`  1. IUpgradeSource(${VAULT_PROXY}).scheduleUpgrade(${vaultImpl.creates})`);
  console.log(`  2. (wait nextImplementationDelay, ~12h)`);
  console.log(`  3. VaultProxy(${VAULT_PROXY}).upgrade()`);
  console.log("\nLeave the deposit cap at 0 (uncapped) through the upgrade; set it");
  console.log(`later with FoldVaultV2(${VAULT_PROXY}).setDepositCap(cap) as a separate action.`);

  console.log("\n=== Deployed addresses (record these) ===");
  console.log(JSON.stringify({
    aaveReserveLib: libAddress,
    newStrategyImpl: strat.creates,
    newFoldVaultV2Impl: vaultImpl.creates,
  }, null, 2));

  console.log("\nIf explorer verification failed above (propagation delay), re-verify once");
  console.log("the deploy txs have a few confirmations (do NOT re-run this whole script —");
  console.log("that redeploys everything). Verify directly with the addresses above:");
  console.log(`  - FoldVaultV2: npx hardhat verify --network mainnet ${vaultImpl.creates}`);
  console.log(`  - Strategy (library-linked): use the verify:verify task with`);
  console.log(`    libraries = { AaveReserveLib: "${libAddress}" }.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
