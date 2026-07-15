const BigNumber = require("bignumber.js");
const makeVault = require("./make-vault.js");
const addresses = require("../test-config.js");
const IController = artifacts.require("IController");
const Vault = artifacts.require("VaultV2");
const CLVault = artifacts.require("CLVault");
const VaultProxy = artifacts.require("VaultProxy");
const IUpgradeableStrategy = artifacts.require("IUpgradeableStrategy");
const ILiquidatorRegistry = artifacts.require("IUniversalLiquidatorRegistry");
const IDex = artifacts.require("IDex");
const IERC721 = artifacts.require("IERC721");
const IncentivesGeneral = artifacts.require("IncentivesGeneral");

const Utils = require("./Utils.js");

async function impersonates(targetAccounts){
  console.log("Impersonating...");
  for(i = 0; i < targetAccounts.length ; i++){
    console.log(targetAccounts[i]);
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [
        targetAccounts[i]
      ]
    });
  }
}

async function setupCoreProtocol(config) {
  // Set vault (or Deploy new vault), underlying, underlying Whale,
  // amount the underlying whale should send to farmers
  if(config.existingVaultAddress != null){
    vault = await Vault.at(config.existingVaultAddress);
    console.log("Fetching Vault at: ", vault.address);
  } else if (config.CLVault) {
    const impl = await CLVault.new();
    const implAddress = impl.address;
    const vaultAsProxy = await VaultProxy.new(implAddress);
    vault = await CLVault.at(vaultAsProxy.address);
    const nftToken = await IERC721.at(config.CLSetup.posManager);
    await nftToken.approve(vault.address, config.CLSetup.posId, { from: config.governance })
    await vault.initializeVault(
      addresses.Storage,
      config.CLSetup.posId,
      config.CLSetup.posManager,
      config.CLSetup.targetWidth,
      { from: config.governance }
    );
    console.log("New Vault Deployed: ", vault.address);
    console.log(new BigNumber(await vault.balanceOf(config.governance)).toFixed());
  } else {
    const implAddress = config.vaultImplementationOverride || addresses.VaultImplementation;
    vault = await makeVault(implAddress, addresses.Storage, config.underlying.address, 100, 100, {
      from: config.governance,
    });
    console.log("New Vault Deployed: ", vault.address);
  }

  controller = await IController.at(addresses.Controller);

  let rewardPool = null;

  if (!config.rewardPoolConfig) {
    config.rewardPoolConfig = {};
  }
  // if reward pool is required, then deploy it
  if(config.rewardPool != null && config.existingRewardPoolAddress == null) {
    const rewardTokens = config.rewardPoolConfig.rewardTokens || [addresses.FARM];
    const rewardDistributions = [config.governance];
    if (config.feeRewardForwarder) {
      rewardDistributions.push(config.feeRewardForwarder);
    }

    if (config.rewardPoolConfig.type === 'PotPool') {
      const PotPool = artifacts.require("PotPool");
      console.log("reward pool needs to be deployed");
      rewardPool = await PotPool.new(
        rewardTokens,
        vault.address,
        64800,
        rewardDistributions,
        addresses.Storage,
        "fPool",
        "fPool",
        18,
        {from: config.governance }
      );
      console.log("New PotPool deployed: ", rewardPool.address);
    } else {
      const NoMintRewardPool = artifacts.require("NoMintRewardPool");
      console.log("reward pool needs to be deployed");
      rewardPool = await NoMintRewardPool.new(
        rewardTokens[0],
        vault.address,
        64800,
        rewardDistributions,
        addresses.Storage,
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
        {from: config.governance }
      );
      console.log("New NoMintRewardPool deployed: ", rewardPool.address);
    }
  } else if(config.existingRewardPoolAddress != null) {
    const PotPool = artifacts.require("PotPool");
    rewardPool = await PotPool.at(config.existingRewardPoolAddress);
    console.log("Fetching Reward Pool deployed: ", rewardPool.address);
  }

  let universalLiquidatorRegistry = await ILiquidatorRegistry.at(addresses.UniversalLiquidatorRegistry);

  // set liquidation paths
  if(config.liquidation) {
    for (i=0;i<config.liquidation.length;i++) {
      dex = Object.keys(config.liquidation[i])[0];
      await universalLiquidatorRegistry.setPath(
        web3.utils.keccak256(dex),
        config.liquidation[i][dex],
        {from: config.ULOwner}
      );
    }
  }

  if(config.uniV3Fee) {
    const uniV3Dex = await IDex.at("0x3c304E03e8ba4dAA23671Fffab45288505BF3992");
    for (i=0;i<config.uniV3Fee.length;i++) {
      await uniV3Dex.setFee(config.uniV3Fee[i][0], config.uniV3Fee[i][1], config.uniV3Fee[i][2], {from: config.ULOwner})
    }
  }
  if(config.aeroSetup) {
    const dex = await IDex.at("0x63dFe27676d53f24E251CbBc0E37ffDC856319a2");
    for (i=0;i<config.aeroSetup.length;i++) {
      await dex.pairSetup(config.aeroSetup[i][0], config.aeroSetup[i][1], config.aeroSetup[i][2], config.aeroSetup[i][3], {from: config.ULOwner})
    }
  }

  // default arguments are storage and vault addresses
  config.strategyArgs = config.strategyArgs || [
    addresses.Storage,
    vault.address
  ];

  for(i = 0; i < config.strategyArgs.length ; i++){
    if(config.strategyArgs[i] == "storageAddr") {
      config.strategyArgs[i] = addresses.Storage;
    } else if(config.strategyArgs[i] == "vaultAddr") {
      config.strategyArgs[i] = vault.address;
    } else if(config.strategyArgs[i] == "poolAddr" ){
      config.strategyArgs[i] = rewardPool.address;
    } else if(config.strategyArgs[i] == "universalLiquidatorRegistryAddr"){
      config.strategyArgs[i] = universalLiquidatorRegistry.address;
    }
  }

  let strategyImpl = null;

  // Optional library linking — pass `libraries: ["AaveReserveLib", ...]` (or
  // an array of {name, instance}) and the helper deploys & links each one
  // against the strategy artifact before instantiation.
  if (Array.isArray(config.libraries) && config.libraries.length > 0) {
    for (const entry of config.libraries) {
      let libArtifact, libInstance;
      if (typeof entry === "string") {
        libArtifact = artifacts.require(entry);
        libInstance = await libArtifact.new();
      } else if (entry && entry.instance) {
        libInstance = entry.instance;
      } else if (entry && entry.name) {
        libArtifact = artifacts.require(entry.name);
        libInstance = await libArtifact.new();
      } else {
        throw new Error("setupCoreProtocol.libraries entry must be a string or {name|instance}");
      }
      await config.strategyArtifact.link(libInstance);
    }
  }

  if (!config.strategyArtifactIsUpgradable) {
    strategy = await config.strategyArtifact.new(
      ...config.strategyArgs,
      { from: config.governance }
    );
  } else {
    strategyImpl = await config.strategyArtifact.new();
    const StrategyProxy = artifacts.require("StrategyProxy");

    const strategyProxy = await StrategyProxy.new(strategyImpl.address);
    strategy = await config.strategyArtifact.at(strategyProxy.address);
    await strategy.initializeStrategy(
      ...config.strategyArgs,
      { from: config.governance }
    );
  }

  console.log("Strategy Deployed: ", strategy.address);

  if (config.announceStrategy === true) {
    // Announce switch, time pass, switch to strategy
    await vault.announceStrategyUpdate(strategy.address, { from: config.governance });
    console.log("Strategy switch announced. Waiting...");
    await Utils.waitHours(13);
    await vault.setStrategy(strategy.address, { from: config.governance });
    await vault.setVaultFractionToInvest(100, 100, { from: config.governance });
    console.log("Strategy switch completed.");
  } else if (config.upgradeStrategy === true) {
    // Announce upgrade, time pass, upgrade the strategy
    const strategyAsUpgradable = await IUpgradeableStrategy.at(await vault.strategy());
    await strategyAsUpgradable.scheduleUpgrade(strategyImpl.address, { from: config.governance });
    console.log("Upgrade scheduled. Waiting...");
    await Utils.waitHours(13);
    await strategyAsUpgradable.upgrade({ from: config.governance });
    await vault.setVaultFractionToInvest(100, 100, { from: config.governance });
    strategy = await config.strategyArtifact.at(await vault.strategy());
    console.log("Strategy upgrade completed.");
  } else {
    await vault.setStrategy(strategy.address, {from: config.governance});
  }

  let incentives = null;
  if (addresses.IncentivesGeneral != "0x0000000000000000000000000000000000000000") {
    incentives = await IncentivesGeneral.at(addresses.IncentivesGeneral);
    console.log("IncentivesGeneral loaded: ", incentives.address);
  } else {
    incentives = await IncentivesGeneral.new(addresses.Storage, { from: config.governance });
    console.log("IncentivesGeneral deployed: ", incentives.address);
  }
  await strategy.setIncentives(incentives.address, { from: config.governance });
  return [controller, vault, strategy, rewardPool, incentives];
}

async function depositVault(_farmer, _underlying, _vault, _amount) {
  await _underlying.approve(_vault.address, _amount, { from: _farmer });
  const oldSharePrice = new BigNumber(await _vault.getPricePerFullShare());
  console.log("Depositing to vault, amount: ", _amount.toString());
  await _vault.deposit(_amount, _farmer, { from: _farmer });
  const newSharePrice = new BigNumber(await _vault.getPricePerFullShare());

  console.log("Deposit: old shareprice: ", oldSharePrice.toFixed());
  console.log("Deposit: new shareprice: ", newSharePrice.toFixed());
  console.log("Deposit: growth:         ", (newSharePrice.toFixed() / oldSharePrice.toFixed() - 1) * 100, "%");
  
}

module.exports = {
  impersonates,
  setupCoreProtocol,
  depositVault,
};
