
const prompt = require('prompt');
const hre = require("hardhat");
const { type2Transaction } = require('./utils.js');

async function main() {
  console.log("Vault Proxy deployment");
  console.log("Specify a the implementation address");
  prompt.start();
  const addresses = require("../test/test-config.js");

  const {underlyingAddr, strategyName} = await prompt.get(['underlyingAddr', 'strategyName']);

  const VaultProxy = artifacts.require('VaultProxy');
  const proxy = await type2Transaction(VaultProxy.new, addresses.FoldVaultImplementation);

  console.log("Proxy deployed at:", proxy.creates);

  const VaultV2 = artifacts.require('VaultV2');
  const vault = await VaultV2.at(proxy.creates);
  await type2Transaction(vault.initializeVault, addresses.Storage, underlyingAddr, 100, 100);

  console.log("New vault deployed and initialised at", proxy.creates);

  // The fold strategy references the external AaveReserveLib, so the library
  // must be deployed and linked into the strategy artifact before the
  // implementation can be instantiated (otherwise .new() throws on the
  // unresolved library placeholder).
  const AaveReserveLib = artifacts.require('AaveReserveLib');
  const lib = await type2Transaction(AaveReserveLib.new);
  console.log("AaveReserveLib deployed at:", lib.creates);
  const libInstance = await AaveReserveLib.at(lib.creates);

  const StrategyImpl = artifacts.require(strategyName);
  StrategyImpl.link(libInstance);
  const impl = await type2Transaction(StrategyImpl.new);

  console.log("Strategy Implementation deployed at:", impl.creates);

  const StrategyProxy = artifacts.require('StrategyProxy');
  const stratProxy = await type2Transaction(StrategyProxy.new, impl.creates);

  console.log("Strategy Proxy deployed at:", stratProxy.creates);

  const strategy = await StrategyImpl.at(stratProxy.creates);
  await type2Transaction(strategy.initializeStrategy, addresses.Storage, proxy.creates);

  console.log("Strategy initialized with vault", proxy.creates);

  // Pass the linked library so the explorer can match the linked bytecode.
  await hre.run("verify:verify", {
    address: impl.creates,
    libraries: { AaveReserveLib: lib.creates },
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
