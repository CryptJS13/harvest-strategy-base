const fs = require("fs");
const path = require("path");

const CONFIG_DIR = path.join(process.cwd(), "scripts", "config");

function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isZeroAddress(value) {
  return /^0x0{40}$/i.test(value || "");
}

function toNumberStrict(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`non-numeric value: ${value}`);
  }
  return n;
}

function assertBps(name, value) {
  const n = toNumberStrict(value);
  if (!Number.isInteger(n) || n < 0 || n > 10000) {
    throw new Error(`${name} must be an integer in [0,10000], got ${value}`);
  }
}

function assertUint(name, value, min = 0) {
  const n = toNumberStrict(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}, got ${value}`);
  }
}

function assertStringLike(name, value) {
  if (value == null || `${value}`.trim() === "") {
    throw new Error(`${name} is required`);
  }
}

function validateConfig(config, file) {
  assertStringLike("name", config.name);
  assertStringLike("posId", config.posId);
  assertStringLike("targetWidth", config.targetWidth);
  assertStringLike("strategyName", config.strategyName);

  if (!isAddress(config.posManager)) {
    throw new Error(`posManager must be a valid address in ${file}`);
  }

  const rebalance = config.rebalance || {};
  assertUint("rebalance.cooldown", rebalance.cooldown, 0);
  assertUint("rebalance.twapWindow", rebalance.twapWindow, 0);
  assertBps("rebalance.maxSwapBps", rebalance.maxSwapBps);
  assertBps("rebalance.maxSlippageBps", rebalance.maxSlippageBps);
  assertBps("rebalance.maxTwapDeviationBps", rebalance.maxTwapDeviationBps);
  assertUint("rebalance.deviation", rebalance.deviation || 0, 0);

  if (!isAddress(rebalance.executor) || isZeroAddress(rebalance.executor)) {
    throw new Error(`rebalance.executor must be a non-zero address in ${file}`);
  }

  const strategy = config.strategy || {};
  assertStringLike("strategy.minRewardToCompound", strategy.minRewardToCompound);

  const deploySharedHelper = !!config.deploySharedHelper;
  if (deploySharedHelper) {
    if (config.rebalanceHelper && !isZeroAddress(config.rebalanceHelper)) {
      throw new Error(`deploySharedHelper=true expects rebalanceHelper omitted/zero in ${file}`);
    }
  } else {
    if (!isAddress(config.rebalanceHelper) || isZeroAddress(config.rebalanceHelper)) {
      throw new Error(`rebalanceHelper must be non-zero when deploySharedHelper=false in ${file}`);
    }
  }
}

function main() {
  if (!fs.existsSync(CONFIG_DIR)) {
    throw new Error(`Missing config directory: ${CONFIG_DIR}`);
  }

  const files = fs
    .readdirSync(CONFIG_DIR)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".example.json"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No deploy configs found in ${CONFIG_DIR} (expected at least one non-example .json)`);
  }

  let deploySharedHelperCount = 0;
  for (const file of files) {
    const full = path.join(CONFIG_DIR, file);
    const config = JSON.parse(fs.readFileSync(full, "utf8"));
    validateConfig(config, file);
    if (config.deploySharedHelper) {
      deploySharedHelperCount += 1;
    }
  }

  if (deploySharedHelperCount > 1) {
    throw new Error(`At most one config may set deploySharedHelper=true, found ${deploySharedHelperCount}`);
  }

  console.log(`CL config preflight passed for ${files.length} config(s): ${files.join(", ")}`);
}

try {
  main();
} catch (e) {
  console.error(`CL config preflight failed: ${e.message}`);
  process.exit(1);
}
