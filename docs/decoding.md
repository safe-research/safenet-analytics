# Event decoding

The Safenet production contracts were not decoded on Dune when the first metric was built (2026-10-23). The metrics therefore read raw `gnosis.logs`. All raw-log decoding lives in one query, [`safenet_events`](../dune/queries/safenet_events/query.sql), and every other query reads that query through `{{query:safenet_events}}`. Replacing the decoding later changes one query.

## The decoding query

`safenet_events` returns one row per production event. It has these columns:

- `event`, `block_time`, `block_number`, `tx_hash`, `log_index`
- `request_id`, `safe_tx_hash`, `safe_chain_id`, `safe_address`, `epoch`, `sponsor`
- `covered_chain`
- `safe_url`, `tx_url`, `safe_tx_url`

The `event` values:

| `event` | Source |
| --- | --- |
| `request` | `Consensus.TransactionProposed` with `oracle` = production SentinelOracle, paired with its `SentinelOracle.NewRequest` |
| `approved`, `denied` | `OracleResult` (`approved` flag), `DisputeResolved` (outcome 3 or 4) |
| `no_verdict` | `RequestTimedOut`, `DisputeOutOfScope`, `ArbitrationTimedOut` |
| `dispute` | `DisputeTriggered` |
| `attestation` | `Consensus.TransactionAttested` with `oracle` = production SentinelOracle |

- **ABIs.** The signatures and topic0 values are in [`src/safenet.ts`](../src/safenet.ts). `test/safenet.test.ts` recomputes each topic0 from its signature and checks that the SQL uses them, and no Beta, testnet or coordinator addresses.
- **Field layout.** The indexed fields and data words come from the event declarations in `safe-research/safenet` at commit `4ed5101`:
  - `TransactionProposed` / `TransactionAttested`: `safeTxHash`, `safeId` and `oracle` are indexed; `epoch` is data word 0.
  - `NewRequest`: `requestId` and `sponsor` are indexed.
  - `OracleResult`: `requestId` and `sponsor` are indexed; `approved` is data word 1.
  - `DisputeResolved`: `outcome` is data word 0.
- **Ranges.** Consensus from block 48635843 and SentinelOracle from block 48635850, with `block_date >= 2026-10-07` for partition pruning.
- **Deduplication.** Each log is one row. A request is identified by its `request_id`, the EIP-712 proposal hash, which is unique per proposal and epoch. `scripts/verify-transaction-checks.ts` checks from RPC logs that every proposal has exactly one oracle request, and that each request has at most one outcome.

## Decoding status

Three production contracts were submitted to Dune for decoding. The submissions are tracked at [dune.com/workspace/t/safe/contracts](https://dune.com/workspace/t/safe/contracts), which requires a Dune login.

`npm run dune -- check-decoded` looks up these contracts in Dune's `gnosis.contracts` and `ethereum.contracts` tables. It runs in every preview, and its result appears in the pull request comment:

- Consensus
- SentinelOracle
- FROSTCoordinator
- Safenet 7702 Executor
- Staking on Ethereum

Current status: **not yet checked against Dune in this repository.** The first `check-decoded` result in a pull request comment replaces this sentence. Until both Consensus and SentinelOracle are decoded with full history, raw logs stay.

The FROSTCoordinator is shared by production and the Aegis testnet. Even once decoded, its events cannot be attributed to production by address alone.

## Replacing raw logs with decoded tables

Only replace the decoding when all of the following hold:

1. **Decoded everywhere it matters.** `check-decoded` lists Consensus and SentinelOracle.
2. **Full history.** The decoded event tables start at the deploy blocks: their minimum `evt_block_number` is at or before the first raw event of each type in `safenet_events`. Dune sometimes backfills decoded tables gradually.
3. **Matching results over identical block ranges.** Run [`scripts/decoded-parity.sql`](../scripts/decoded-parity.sql) on Dune for the range from the deploy block to a block at least a day old, after filling in the table names and the production ID of `safenet_events`. The result must be empty. Extend it to the oracle outcome events as described in the file before switching those.
4. **Same output.** In the pull request that switches the query, the preview reconciliation must show no mismatches, so the counter and every daily value equal the RPC recount.

Then rewrite the CTEs of `safenet_events` to read the decoded tables, keep the output columns unchanged, and keep the `oracle` = production SentinelOracle filter. Update the topic0 test, which then checks the decoded-table names instead. Note the switch and the parity evidence in this file.
