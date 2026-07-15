const { type2Transaction } = require('./utils.js');
const CLChainlinkChecker = artifacts.require('CLChainlinkChecker');
const addresses = require('../test/test-config.js');

async function main() {
  console.log("Deploy the CLChainlinkChecker contract");

  const checker = await type2Transaction(CLChainlinkChecker.new, addresses.SetupStorage);
  console.log("CLChainlinkChecker deployed at:", checker.creates);

  console.log("Deployment complete.");
  await hre.run("verify:verify", {address: checker.creates, constructorArguments: [addresses.SetupStorage]}); 
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });