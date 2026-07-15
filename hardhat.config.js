if (typeof File === "undefined") {
  global.File = class File {};
}

// Inject a root-level beforeAll into mocha so we mine one block before any
// test runs against a fork. Avoids EDR's "No known hardfork for execution on
// historical block N" error on Base when reading state at the fork block.
{
  const Mocha = require("mocha");
  const origRun = Mocha.prototype.run;
  Mocha.prototype.run = function (...args) {
    this.suite.beforeAll("hh-fork-mine-once", async function () {
      const hre = require("hardhat");
      if (hre.network.name !== "hardhat") return;
      if (!hre.network.config.forking || hre.network.config.forking.enabled === false) return;
      await hre.network.provider.request({ method: "evm_mine", params: [] });
    });
    return origRun.apply(this, args);
  };
}

require("@nomicfoundation/hardhat-verify");
require("@nomiclabs/hardhat-truffle5");
require("@nomiclabs/hardhat-web3");
require("@nomiclabs/hardhat-ethers");
require('hardhat-contract-sizer');
require("hardhat-gas-reporter");

require('dotenv').config()
const FORK_BLOCK = process.env.FORK_BLOCK ? parseInt(process.env.FORK_BLOCK, 10) : 37210850;
const DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";
const MNEMONIC = process.env.MNEMONIC || DEFAULT_MNEMONIC;

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
        mnemonic: MNEMONIC,
      },
      chainId: 8453,
      hardfork: "cancun",
      chains: {
        8453: {
          hardforkHistory: {
            berlin: 0,
            london: 0,
            arrowGlacier: 0,
            grayGlacier: 0,
            merge: 0,
            shanghai: 0,
            cancun: 0,
          },
        },
      },
      forking: {
        url: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`,
        blockNumber: FORK_BLOCK, // override with FORK_BLOCK env var when needed
      },
      allowUnlimitedContractSize: true,
    },
    mainnet: {
      url: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`,
      accounts: {
        mnemonic: MNEMONIC,
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
          viaIR: true,
        },
      },
    ],
    overrides: {
      "contracts/base/CLVault.sol": {
        version: "0.8.26",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
          metadata: {
            bytecodeHash: "none",
          },
          debug: {
            revertStrings: "strip",
          },
        },
      },
    },
  },
  mocha: {
    timeout: 2000000,
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
