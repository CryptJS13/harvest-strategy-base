#!/usr/bin/env node

const required = Number(process.argv[2] || "24");
const major = Number(process.versions.node.split(".")[0]);

if (!Number.isFinite(required) || required <= 0) {
  console.error("Invalid required Node major version");
  process.exit(1);
}

if (major !== required) {
  console.error(`Node ${required}.x required, found ${process.version}`);
  process.exit(1);
}

console.log(`Node version OK: ${process.version}`);
