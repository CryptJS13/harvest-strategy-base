const IPosManager = artifacts.require("INonfungiblePositionManager");
const ICLGauge = artifacts.require("ICLGauge");

function slotFromLabel(label) {
  const raw = web3.utils.toBN(web3.utils.keccak256(label));
  return web3.utils.toHex(raw.sub(web3.utils.toBN("1")));
}

async function readUintSlot(address, slot) {
  const raw = await web3.eth.getStorageAt(address, slot);
  return web3.utils.toBN(raw);
}

async function readAddressSlot(address, slot) {
  const raw = await web3.eth.getStorageAt(address, slot);
  return web3.utils.toChecksumAddress(`0x${raw.slice(26)}`);
}

async function validateCLVaultWiring({
  vault,
  strategy,
  posId,
  posManager,
  targetWidth,
  deployer,
  expected = {},
}) {
  const pm = await IPosManager.at(posManager);
  const owner = await pm.ownerOf(posId);
  if (owner.toLowerCase() !== vault.address.toLowerCase()) {
    throw new Error(`Preflight failed: vault is not NFT owner. owner=${owner}, vault=${vault.address}`);
  }

  const vaultPosManager = await vault.posManager();
  if (vaultPosManager.toLowerCase() !== posManager.toLowerCase()) {
    throw new Error(`Preflight failed: vault posManager mismatch ${vaultPosManager} != ${posManager}`);
  }

  const vaultPosId = await vault.posId();
  if (vaultPosId.toString() !== String(posId)) {
    throw new Error(`Preflight failed: vault posId mismatch ${vaultPosId} != ${posId}`);
  }

  const width = await vault.targetWidth();
  if (String(width) !== String(targetWidth)) {
    throw new Error(`Preflight failed: target width mismatch ${width} != ${targetWidth}`);
  }

  const linkedVault = await strategy.vault();
  if (linkedVault.toLowerCase() !== vault.address.toLowerCase()) {
    throw new Error(`Preflight failed: strategy vault mismatch ${linkedVault} != ${vault.address}`);
  }

  const helper = await vault.rebalanceHelper();
  if (helper === "0x0000000000000000000000000000000000000000") {
    throw new Error("Preflight failed: rebalance helper is not set");
  }

  if (expected.rebalanceSafety) {
    const {
      maxSwapBps,
      maxSlippageBps,
      twapWindow,
      maxTwapDeviationBps
    } = expected.rebalanceSafety;
    const maxSwapBpsOnchain = await readUintSlot(vault.address, slotFromLabel("eip1967.vaultStorage.maxSwapBps"));
    const maxSlippageBpsOnchain = await readUintSlot(vault.address, slotFromLabel("eip1967.vaultStorage.maxSlippageBps"));
    const twapWindowOnchain = await readUintSlot(vault.address, slotFromLabel("eip1967.vaultStorage.twapWindow"));
    const maxTwapDeviationOnchain = await readUintSlot(vault.address, slotFromLabel("eip1967.vaultStorage.maxTwapDeviationBps"));
    if (maxSwapBps != null && maxSwapBpsOnchain.toString() !== String(maxSwapBps)) {
      throw new Error(`Preflight failed: maxSwapBps mismatch ${maxSwapBpsOnchain.toString()} != ${maxSwapBps}`);
    }
    if (maxSlippageBps != null && maxSlippageBpsOnchain.toString() !== String(maxSlippageBps)) {
      throw new Error(`Preflight failed: maxSlippageBps mismatch ${maxSlippageBpsOnchain.toString()} != ${maxSlippageBps}`);
    }
    if (twapWindow != null && twapWindowOnchain.toString() !== String(twapWindow)) {
      throw new Error(`Preflight failed: twapWindow mismatch ${twapWindowOnchain.toString()} != ${twapWindow}`);
    }
    if (maxTwapDeviationBps != null && maxTwapDeviationOnchain.toString() !== String(maxTwapDeviationBps)) {
      throw new Error(`Preflight failed: maxTwapDeviationBps mismatch ${maxTwapDeviationOnchain.toString()} != ${maxTwapDeviationBps}`);
    }
  }

  if (expected.rebalanceConfig) {
    const { cooldown, executor } = expected.rebalanceConfig;
    const cooldownOnchain = await readUintSlot(vault.address, slotFromLabel("eip1967.vaultStorage.rebalanceCooldown"));
    const executorOnchain = await readAddressSlot(vault.address, slotFromLabel("eip1967.vaultStorage.rebalanceExecutor"));
    if (cooldown != null && cooldownOnchain.toString() !== String(cooldown)) {
      throw new Error(`Preflight failed: cooldown mismatch ${cooldownOnchain.toString()} != ${cooldown}`);
    }
    if (executor != null && executorOnchain.toLowerCase() !== String(executor).toLowerCase()) {
      throw new Error(`Preflight failed: executor mismatch ${executorOnchain} != ${executor}`);
    }
  }

  if (expected.strategy && expected.strategy.minRewardToCompound != null) {
    const rewardToken = await strategy.rewardToken();
    const threshold = await strategy.minRewardToCompound(rewardToken);
    if (String(threshold) !== String(expected.strategy.minRewardToCompound)) {
      throw new Error(
        `Preflight failed: minRewardToCompound mismatch ${threshold.toString()} != ${expected.strategy.minRewardToCompound}`
      );
    }
  }

  const rewardPool = await strategy.rewardPool();
  if (rewardPool && rewardPool !== "0x0000000000000000000000000000000000000000") {
    const gauge = await ICLGauge.at(rewardPool);
    const gaugeNft = await gauge.nft();
    if (gaugeNft.toLowerCase() !== posManager.toLowerCase()) {
      throw new Error(`Preflight failed: gauge NFT manager mismatch ${gaugeNft} != ${posManager}`);
    }
    const gaugeToken0 = await gauge.token0();
    const gaugeToken1 = await gauge.token1();
    const vaultToken0 = await vault.token0();
    const vaultToken1 = await vault.token1();
    if (
      gaugeToken0.toLowerCase() !== vaultToken0.toLowerCase() ||
      gaugeToken1.toLowerCase() !== vaultToken1.toLowerCase()
    ) {
      throw new Error("Preflight failed: gauge token pair does not match vault position pair");
    }
  }

  console.log("CL preflight checks passed for deployer", deployer);
}

module.exports = {
  validateCLVaultWiring,
};
