#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const maxBytes = Number(process.argv[2] || "24576");
const artifactPath = path.resolve(
  __dirname,
  "../../artifacts/contracts/base/CLVault.sol/CLVault.json"
);

if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
  console.error("Invalid max bytecode size");
  process.exit(1);
}

if (!fs.existsSync(artifactPath)) {
  console.error(`Artifact not found: ${artifactPath}`);
  console.error("Run compilation first (e.g. `npx hardhat compile`).");
  process.exit(1);
}

const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const deployed = artifact.deployedBytecode || "";
if (!deployed.startsWith("0x")) {
  console.error("Invalid deployedBytecode format in artifact");
  process.exit(1);
}

const byteLen = (deployed.length - 2) / 2;
const kib = byteLen / 1024;
console.log(`CLVault deployed bytecode: ${byteLen} bytes (${kib.toFixed(3)} KiB)`);

if (byteLen >= maxBytes) {
  console.error(`CLVault exceeds limit: ${byteLen} >= ${maxBytes}`);
  process.exit(1);
}
