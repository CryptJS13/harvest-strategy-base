# RewardForwarderV2 cut-over (Base)

Why: on 2026-10-23 the current forwarder `0x1695A1BE…` sold a 726 USDC profit share into iFARM with
`minOut = 1` (tx `0x8b33f163…`) and lost 47%. It was the eighth time FARM was left in SwapRouter02.
Two pieces replace that path:

- `contracts/base/RewardForwarderV2.sol` (this repo). It sells each fee token into WETH in capped chunks
  above a Chainlink floor, buffers the profit share in WETH, and buys iFARM in small chunks above a
  governance floor. The keeper path is `buyProfitShare(hubIn, minOut)`.
- `UniV3ExactDex` (harvest-universal-liquidator-base, branch `claude/univ3-exact-dex`). It swaps hop by hop
  and reverts `PartialFill` instead of leaving input in the router.

Tests: `test/rewardForwarder/reward-forwarder-v2.js` (30 tests) and the liquidator repo's
`tests/exactdex.test.ts` (9 tests). Both fork Base at block 52987864, the state just before the
incident. Every protection was checked by a mutation that turns its test red.

## Starting parameters

| Pair | maxIn | Floor |
|---|---|---|
| USDC -> WETH | 50,000 USDC | Chainlink USDC/USD (`0x7e86…`, maxAge 90000 s) and ETH/USD (`0x7104…`, maxAge 3600 s), `oracleToleranceBps` 200. `minRate` 0 |
| WETH -> iFARM | 0.02 WETH | `minRate` = 0.85 x fair, about 158e18 today (fair is about 186 iFARM/WETH: L1 FARM/WETH divided by L1 iFARM `getPricePerFullShare`) |
| Each other fee token | per token | A Chainlink feed where one exists, otherwise a static `minRate`. Or leave the token unlisted on purpose (its platform fee then waits too) |

- **Throughput.** One chunk per call means the cadence sets capacity. At 8 h x 0.02 WETH that is 0.06
  WETH/day, which is about today's profit-share flow and too tight. Run the scheduled call hourly
  (0.48 WETH/day), or have the bot call `buyProfitShare`.
- **`minBuyInterval`.** 600–3600 s. It rate-limits both paths, which bounds what a compromised hardWorker
  can buy at the floor.
- **Fee tokens.** V1's last 30 days of inflow came in USDC, WETH, AERO, FARM, USDbC, cbBTC, EURC, WELL,
  VIRTUAL, DOLA and the four xStocks. Decide each one.

## Order of operations

1. **Deploy `UniV3ExactDex`.** `setFee` for every hop the iFARM routes use, at the uniV3 dex's live tiers:
   WETH/FARM 3000, FARM/iFARM 3000, USDC/WETH 100, cbBTC/WETH 3000, USDbC/WETH 500, weETH/WETH 100.
   Hand ownership to the registry owner, or better the Safe.
2. **Registry owner `0x6a74…`.** Run `addDex(keccak256("uniV3Exact"), dex)`. Then `setPath` on it for
   **every** iFARM-bound entry, not only WETH:
   - `[WETH, FARM, iFARM]`
   - `[USDC, WETH, FARM, iFARM]` (direct entry, live since block 53155748)
   - `[cbBTC, WETH, FARM, iFARM]`
   - `[USDbC, WETH, FARM, iFARM]`
   - `[weETH, WETH, FARM, iFARM]`

   A direct entry wins over the WETH one, so any token left on the old dex still strands.
   - Check that `getPath(X, iFARM)` resolves to the exact dex for every X that V1 or V2 holds.
   - Update `helpers/registry.json` in the same change: a `uniV3Exact` dex entry of kind `uniV3` with no
     `defaultFee`, and those path entries. Otherwise a later `SYNC_EXECUTE=1 registry:sync` points
     them back at the old dex. `setPath` emits no event, so monitoring would not see it.
   - On its own this step already protects V1: an oversized V1 swap reverts, V1 emits `SwapFailed`,
     and the fee stays pending.
3. **Deploy `RewardForwarderV2(storage, WETH, iFARM)`.**
4. **Safe MultiSend.** In one batch:
   - V2 configuration: `setPriceFeed`, `setOracleTolerance`, `setSwapLimit`, `addRewardToken`,
     `setMinBuyInterval`.
   - `Controller.addHardWorker(0xe262…)`, if the bot calls V2 directly.
   - `Controller.setRewardForwarder(V2)`.

   Strategies read the forwarder from the Controller on every harvest, so no strategy changes.
5. **V1 leftovers.** About 3.4 USDC, 0.004 WETH, AERO and FARM dust, and xStock dust. After step 2, one
   more `V1.distributeAllFees()` settles what the exact routes can fill; the rest stays in V1. V1 has no
   sweep. If the amounts ever matter, a MultiSend that briefly swaps `Controller.universalLiquidator`
   for a rescue contract can move them, followed by `V2.notifyFeeAdmin`.
6. **Keepers.**
   - CronUpkeep `0xA46a…` (owner `0x6a74…`): `updateCronJob(1, V2, 0x51789422, "0 * * * *")`.
   - CRE `fee-distribution`: point `targetAddress` at V2, update the receiver allowlist, and set the
     same hourly schedule.
   - base-cron reads the forwarder from the Controller. Its WETH-at-CommunityMsig measurement still
     works for listed tokens, as covered by the live-strategy test.
7. **Monitoring.**
   - Growth of `pendingProfitShare(WETH)`.
   - N consecutive `SwapFailed` or `SwapSkipped` for one pair.
   - `FeeNotified` for an unlisted token.
   - The WETH->iFARM floor drifting from fair (FARM/ETH moves). A hardWorker can tighten it with
     `setKeeperRate`; loosening it needs the Safe.

## Known limits

- **FARM fees round-trip.** They go FARM -> WETH -> FARM -> iFARM (about $95/month of inflow). List FARM
  with a static floor, or leave it parked.
- **Donations can delay buys.** Anyone can delay a buy by donating input to the exact dex ahead of a
  scheduled call. The liquidator sells the dex's whole balance, so the swap partial-fills and reverts.
  The donor can only win the donation back at a cost, through a fillable swap. Funds stay safe, and the
  chunk stays buffered.
- **Keeper-side quoting is not built.** The plan was a fair value from L1 NAV (take the max of the
  sources, not the min) and a tolerance that allows for the ~3% Base iFARM premium. The contract
  supports it through `buyProfitShare` and `setKeeperRate`.
