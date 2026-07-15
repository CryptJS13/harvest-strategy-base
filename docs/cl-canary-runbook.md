# CL Canary Runbook (Core Vault/Strategy)

## Scope
- Deploy and validate one canary CL vault/strategy pair before expanding to more pairs.
- Use deterministic config and preflight gates only.

## Preconditions
- Node v24.
- `scripts/config/*.json` reviewed and committed.
- Governance/controller/executor addresses finalized.
- Universal liquidator routes and gauge compatibility confirmed.

## Mandatory Gates (Pre-Deploy)
1. `npm run check:config:cl`
2. `npm run gate:cl`

## Deploy Steps
1. First canary (deploy shared helper) config-driven deploy:
```bash
npx hardhat run scripts/12-deploy-CL-vault.js --network base --config scripts/config/cl-canary-cbeth-eth.initial-helper.json
```
2. Follow-up canary/additional pair (reuse helper):
```bash
npx hardhat run scripts/12-deploy-CL-vault.js --network base --config scripts/config/cl-canary-cbeth-eth.reuse-helper.json
```
3. Archive generated snapshot from `scripts/deployments/cl/`.
4. Confirm onchain wiring from snapshot values:
- vault/strategy/helper addresses
- rebalance safety config
- rebalance cooldown/executor
- strategy `minRewardToCompound`

## Initial Canary Policy
- Keep `withdrawOnly=false`, all lanes enabled.
- Start with conservative cooldown and TWAP guard values from config.
- Keep wrappers disabled in canary phase.

## Monitoring During Soak
- Watch and alert on:
- failed `doHardWork`
- failed `rebalanceCurrentTick`
- repeated `StrategySwapSkipped` bursts
- unexpected NFT custody owner transitions
- share price non-monotonic behavior under normal operation

## Emergency Procedure
1. Vault governance: `setLanePause(false, true, true, true)`
2. Strategy governance: `setEmergencyState(true, true, true)`
3. Withdraw path rehearsal: `withdrawAllToVault(false)` and controlled user withdraw.

## Expansion Criteria
- No critical/high issues during soak.
- No stuck custody states.
- No repeated unexplained keeper failures.
- Gas profile remains within agreed bounds for core paths.
