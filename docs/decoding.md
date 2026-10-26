# Event decoding

The Safenet production contracts were not decoded on Dune when the first metric was built (2026-10-23). The metrics therefore read raw logs and traces, and only seven model queries do so. Every other query reads them through `{{query:...}}` references (`test/safenet.test.ts` enforces this). Replacing the decoding later changes only these models:

| Model | Reads | Replace with |
| --- | --- | --- |
| [`safenet_events`](../dune/queries/safenet_events/query.sql) | `gnosis.logs` of Consensus and SentinelOracle | Dune's decoded Safenet tables |
| [`safenet_fee_flows`](../dune/queries/safenet_fee_flows/query.sql) | `gnosis.logs` USDC.e `Transfer` logs to and from the oracle | a decoded ERC-20 transfer table, with the same parity rule |
| [`safenet_guards`](../dune/queries/safenet_guards/query.sql) | guard constructor events and creation traces on Ethereum, Gnosis Chain and Arbitrum One | decoded SafenetGuard tables, once a guard is deployed and decoded |
| [`safenet_guard_status`](../dune/queries/safenet_guard_status/query.sql) | Safe `ChangedGuard` logs on the three networks | Dune's decoded Safe tables, which split this event by Safe version |
| [`safenet_sentinel_failed_calls`](../dune/queries/safenet_sentinel_failed_calls/query.sql) | `gnosis.traces`: reverted SentinelOracle `commit` / `reveal` calls (selectors in `ORACLE_FUNCTIONS`), with the revert reason when it is an `Error(string)` | Dune's decoded call tables of the SentinelOracle (`*_call_commit`, `*_call_reveal` with `call_success = false`) |
| [`safenet_sentinel_wallet_transfers`](../dune/queries/safenet_sentinel_wallet_transfers/query.sql) | `gnosis.logs` USDC.e `Transfer` logs of Sentinel accounts since 2026-10-07 | a decoded ERC-20 transfer table, with the same parity rule; `verify-sentinels` checks the result against `balanceOf` |
| [`safenet_reward_events`](../dune/queries/safenet_reward_events/query.sql) | `ethereum.logs` of the SAFE rewards distributor (`Claimed`, `MerkelRootUpdated`) | Dune's decoded tables of the distributor (`CumulativeMerkleDrop`), once decoded |

## The decoding query

`safenet_events` returns one row per production event. It has these columns:

- `event`, `source_event`, `block_time`, `block_number`, `tx_hash`, `log_index`
- `request_id`, `safe_tx_hash`, `safe_chain_id`, `safe_address`, `epoch`, `sponsor`
- `covered_chain`
- `sentinel`, `vote_approved`, `bond_amount`, `fee_reward`, `slashed`, for votes, claims and dispute rulings
- `fee`, `bond_target`, `dao_fee_share`, `slash_amount`, `commit_deadline`, `reveal_deadline`, on request rows
- `active_at_block`, `config_data`, for governance events
- `reason`: the recorded text of `Revealed.reason` (empty for approvals, Charter rule IDs for denials) and the arbitrator's context of `DisputeResolved` and `DisputeOutOfScope`, decoded from the ABI string; null when empty
- `safe_url`, `tx_url`, `safe_tx_url`

Amounts are USDC.e base units. They are decoded as the low 8 bytes of their word, so values must stay below 2^63. Real values are far below that, and the verification would catch a difference.

The `event` values:

| `event` | Source |
| --- | --- |
| `request` | `Consensus.TransactionProposed` with `oracle` = production SentinelOracle, paired with its `SentinelOracle.NewRequest` |
| `approved`, `denied` | `OracleResult` (`approved` flag), `DisputeResolved` (outcome 3 or 4) |
| `no_verdict` | `RequestTimedOut`, `DisputeOutOfScope`, `ArbitrationTimedOut` |
| `dispute` | `DisputeTriggered` |
| `committed` | `Committed(requestId, sentinel, bondAmount)`: a Sentinel commits a vote and locks its bond |
| `revealed` | `Revealed(requestId, sentinel, approved, bondAmount, reason)`: a Sentinel response |
| `claimed` | `Claimed(requestId, sentinel, bondReturn, feeReward)`: the bond and fee reward paid out |
| `attestation` | `Consensus.TransactionAttested` with `oracle` = production SentinelOracle |
| `sentinel_scheduled`, `sentinel_removed` | `SentinelScheduled(sentinel, activeAtBlock)`, `SentinelRemoved(sentinel)` |
| `config_scheduled` | `FeeScheduled`, `DaoFeeShareScheduled`, `ProtocolFundsReceiverScheduled`, `BondConfigScheduled`; raw data in `config_data` |

- **ABIs.** The signatures and topic0 values are in [`src/safenet.ts`](../src/safenet.ts). `test/safenet.test.ts` recomputes each topic0 from its signature and checks that the SQL uses them, and no Beta, testnet or coordinator addresses.
- **Field layout.** The indexed fields and data words come from the event declarations in `safe-research/safenet` at commit `4ed5101`:
  - `TransactionProposed` / `TransactionAttested`: `safeTxHash`, `safeId` and `oracle` are indexed; `epoch` is data word 0.
  - `NewRequest`: `requestId` and `sponsor` are indexed.
  - `OracleResult`: `requestId` and `sponsor` are indexed; `approved` is data word 1.
  - `DisputeResolved`: `outcome` is data word 0 and `slashed` is word 1.
  - `NewRequest` data words: `fee`, `bondTarget`, `daoFeeShare` (of 100000), `slashAmount`, `commitDeadline`, `revealDeadline`.
  - `Committed`, `Revealed` and `Claimed`: `requestId` and `sentinel` are indexed. `Revealed` data starts with `approved` and then `bondAmount`; `Claimed` data is `bondReturn` then `feeReward`.
  - `SentinelScheduled` / `SentinelRemoved`: `sentinel` is indexed.
- **Ranges.** Consensus from block 48635843 and SentinelOracle from block 48635850, with `block_date >= 2026-10-07` for partition pruning.
- **Deduplication.** Each log is one row. A request is identified by its `request_id`, the EIP-712 proposal hash, which is unique per proposal and epoch. `scripts/verify-transaction-checks.ts` and `scripts/verify-network-revenue.ts` check from RPC logs that every proposal has exactly one oracle request, that each request has at most one outcome, and that every reveal follows a commit.

## Decoding status

Three production contracts were submitted to Dune for decoding. The submissions are tracked at [dune.com/workspace/t/safe/contracts](https://dune.com/workspace/t/safe/contracts), which requires a Dune login.

`npm run dune -- check-decoded` looks up these contracts in Dune's `gnosis.contracts` and `ethereum.contracts` tables. It runs in every preview, and its result appears in the pull request comment:

- Consensus
- SentinelOracle
- FROSTCoordinator
- Safenet 7702 Executor
- Staking on Ethereum
- SAFE rewards distributor (CumulativeMerkleDrop) on Ethereum

Current status: **not yet checked against Dune in this repository.** The first `check-decoded` result in a pull request comment replaces this sentence. Until both Consensus and SentinelOracle are decoded with full history, raw logs stay.

The FROSTCoordinator is shared by production and the Aegis testnet. Even once decoded, its events cannot be attributed to production by address alone.

## Replacing raw logs with decoded tables

Only replace the decoding when all of the following hold:

1. **Decoded everywhere it matters.** `check-decoded` lists Consensus and SentinelOracle.
2. **Full history.** The decoded event tables start at the deploy blocks: their minimum `evt_block_number` is at or before the first raw event of each type in `safenet_events`. Dune sometimes backfills decoded tables gradually.
3. **Matching results over identical block ranges.** Run [`scripts/decoded-parity.sql`](../scripts/decoded-parity.sql) on Dune for the range from the deploy block to a block at least a day old, after filling in the table names and the production ID of `safenet_events`. The result must be empty. Extend it to the oracle outcome events as described in the file before switching those.
4. **Same output.** In the pull request that switches the query, both preview reconciliations must show no mismatches: the counter, every daily value, every window and network, the result breakdown and the fee allocation must equal the RPC recount.

The same rules apply to the other three models. For `safenet_fee_flows`, the decoded transfer table must give the same rows over the same block range. For the guard models, a decoded table must cover every Safe version on each network.

Then rewrite the CTEs of `safenet_events` to read the decoded tables, keep the output columns unchanged, and keep the `oracle` = production SentinelOracle filter. Update the topic0 test, which then checks the decoded-table names instead. Note the switch and the parity evidence in this file.
