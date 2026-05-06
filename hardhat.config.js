if (typeof File === "undefined") {
  global.File = class File {};
}

require("@nomicfoundation/hardhat-verify");
require("@nomiclabs/hardhat-truffle5");
require("@nomiclabs/hardhat-web3");
require("@nomiclabs/hardhat-ethers");
require('hardhat-contract-sizer');
require("hardhat-gas-reporter");

require('dotenv').config()

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      accounts: {
        mnemonic: process.env.MNEMONIC,
      },
      chainId: 8453,
      forking: {
        url: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`,
        blockNumber: 44729683, // <-- edit here
      },
      allowUnlimitedContractSize: true,
    },
    mainnet: {
      url: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`,
      accounts: {
        mnemonic: process.env.MNEMONIC,
      },
    },
  },
  solidity: {
    compilers: [
      {
        version: "0.8.26",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
        },
      },
    ],
  },
  mocha: {
    timeout: 2000000
  },
  etherscan: {
    apiKey: process.env.BASESCAN_API_KEY,
  },
  contractSizer: {
    alphaSort: false,
    disambiguatePaths: false,
    runOnCompile: false,
    strict: false,
  },
  gasReporter: {
    enabled: true,
  },
};
