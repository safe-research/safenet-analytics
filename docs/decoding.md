# Event decoding

The Safenet Aegis contracts were not decoded on Dune when the first metric was built (2026-10-23), so the metrics read raw logs and traces, and only a few model queries do so. Every other query reads those models through `{{query:...}}` references (`test/safenet.test.ts` enforces this). Since 2026-10-29, `safenet_events` and `safenet_sentinel_texts` read Dune's decoded Safenet tables instead, and since 2026-11-02 the Validators models, `staking_validator_stakers` and `safenet_reward_events` too (see [Switches](#switches)). The remaining raw-log models:

| Model | Reads | Replace with |
| --- | --- | --- |
| [`safenet_fee_flows`](../dune/queries/safenet_fee_flows/query.sql) | `gnosis.logs` USDC.e `Transfer` logs to and from the oracle | a decoded ERC-20 transfer table, with the same parity rule |
| [`safenet_guards`](../dune/queries/safenet_guards/query.sql) | guard constructor events and creation traces on Ethereum, Gnosis Chain and Arbitrum One | decoded SafenetGuard tables, once a guard is deployed and decoded |
| [`safenet_guard_status`](../dune/queries/safenet_guard_status/query.sql) | Safe `ChangedGuard` logs on the three networks | Dune's decoded Safe tables, which split this event by Safe version |
| [`safenet_sentinel_failed_calls`](../dune/queries/safenet_sentinel_failed_calls/query.sql) | `gnosis.traces`: reverted SentinelOracle `commit` / `reveal` calls (selectors in `ORACLE_FUNCTIONS`), with the revert reason when it is an `Error(string)` | Dune's decoded call tables of the SentinelOracle (`*_call_commit`, `*_call_reveal` with `call_success = false`) |
| [`safenet_sentinel_wallet_transfers`](../dune/queries/safenet_sentinel_wallet_transfers/query.sql) | `gnosis.logs` USDC.e `Transfer` logs of Sentinel accounts since 2026-10-07 | a decoded ERC-20 transfer table, with the same parity rule; `verify-sentinels` checks the result against `balanceOf` |

**Query size.** Dune inlines every `{{query:...}}` reference, and every CTE, where it is used. A query that reaches `safenet_events` many times therefore hits Dune's limit on query stages ("too many stages"); `fee_allocation` is close to it. Keep `safenet_events` lean, and have new models read it once (one aggregation, window functions or arrays instead of self-joins). `test/safenet.test.ts` caps the references of the Sentinel queries.

## The decoding query

`safenet_events` returns one row per Aegis event. It has these columns:

- `event`, `source_event`, `block_time`, `block_number`, `tx_hash`, `log_index`
- `request_id`, `safe_tx_hash`, `safe_chain_id`, `safe_address`, `epoch`, `sponsor`
- `covered_chain`
- `sentinel`, `vote_approved`, `bond_amount`, `fee_reward`, `slashed`, for votes, claims and dispute rulings
- `fee`, `bond_target`, `dao_fee_share`, `slash_amount`, `commit_deadline`, `reveal_deadline`, on request rows
- `active_at_block`, `config_change`, for governance events
- `safe_url`, `tx_url`, `safe_tx_url`

Amounts are USDC.e base units. They are decoded as the low 8 bytes of their word, so values must stay below 2^63. Real values are far below that, and the verification would catch a difference.

The `event` values:

| `event` | Source |
| --- | --- |
| `request` | `Consensus.TransactionProposed` with `oracle` = Aegis SentinelOracle, paired with its `SentinelOracle.NewRequest` |
| `approved`, `denied` | `OracleResult` (`approved` flag), `DisputeResolved` (outcome 3 or 4) |
| `no_verdict` | `RequestTimedOut`, `DisputeOutOfScope`, `ArbitrationTimedOut` |
| `dispute` | `DisputeTriggered` |
| `committed` | `Committed(requestId, sentinel, bondAmount)`: a Sentinel commits a vote and locks its bond |
| `revealed` | `Revealed(requestId, sentinel, approved, bondAmount, reason)`: a Sentinel response |
| `claimed` | `Claimed(requestId, sentinel, bondReturn, feeReward)`: the bond and fee reward paid out |
| `attestation` | `Consensus.TransactionAttested` with `oracle` = Aegis SentinelOracle |
| `sentinel_scheduled`, `sentinel_removed` | `SentinelScheduled(sentinel, activeAtBlock)`, `SentinelRemoved(sentinel)` |
| `config_scheduled` | `FeeScheduled`, `DaoFeeShareScheduled`, `ProtocolFundsReceiverScheduled`, `BondConfigScheduled`; the decoded values in `config_change`, for example `newValue 250000, activeAtBlock 49100000` |

- **Sources.** `safe_gnosis.SafenetAegisConsensus_evt_*` and `safe_gnosis.SafenetAegisSentinelOracle_evt_*`, restricted to the Aegis contract addresses, and proposals and attestations to `oracle` = Aegis SentinelOracle. Column names are the event parameters in `safe-research/safenet` at commit `4ed5101`: `requestId`, `safeTxHash`, `safeId` (bytes32: chain ID in the top 12 bytes, Safe in the low 20), `sponsor`, `sentinel`, `approved`, `bondAmount`, `bondReturn`, `feeReward`, `outcome` (`SentinelOracleRequest.State`, 3 = approved, 4 = denied), `slashed` and the `NewRequest` terms. `test/safenet.test.ts` checks the tables and filters, and no Beta, testnet or coordinator addresses. `test/decoded-parity.test.ts` checks that every decoded table any query reads is covered by the parity check.
- **Raw-log layout (until 2026-10-29).** The raw decoding read the indexed fields and data words from the same declarations:
  - `TransactionProposed` / `TransactionAttested`: `safeTxHash`, `safeId` and `oracle` are indexed; `epoch` is data word 0.
  - `NewRequest`: `requestId` and `sponsor` are indexed.
  - `OracleResult`: `requestId` and `sponsor` are indexed; `approved` is data word 1.
  - `DisputeResolved`: `outcome` is data word 0 and `slashed` is word 1.
  - `NewRequest` data words: `fee`, `bondTarget`, `daoFeeShare` (of 100000), `slashAmount`, `commitDeadline`, `revealDeadline`.
  - `Committed`, `Revealed` and `Claimed`: `requestId` and `sentinel` are indexed. `Revealed` data starts with `approved` and then `bondAmount`; `Claimed` data is `bondReturn` then `feeReward`.
  - `SentinelScheduled` / `SentinelRemoved`: `sentinel` is indexed.
- **Ranges.** Consensus from block 48635843 and SentinelOracle from block 48635850.
- **Deduplication.** Each log is one row. A request is identified by its `request_id`, the EIP-712 proposal hash, which is unique per proposal and epoch. `scripts/verify-transaction-checks.ts` and `scripts/verify-network-revenue.ts` check from RPC logs that every proposal has exactly one oracle request, that each request has at most one outcome, and that every reveal follows a commit.

## Decoding status

Three Aegis contracts were submitted to Dune for decoding. The submissions are tracked at [dune.com/workspace/t/safe/contracts](https://dune.com/workspace/t/safe/contracts), which requires a Dune login.

`npm run dune -- check-decoded` looks up these contracts in Dune's `gnosis.contracts` and `ethereum.contracts` tables. It runs in every preview, and its result appears in the pull request comment:

- Consensus
- SentinelOracle
- FROSTCoordinator
- Safenet 7702 Executor
- Staking on Ethereum
- SAFE rewards distributor (CumulativeMerkleDrop) on Ethereum

Status on 2026-10-29 (`check-decoded`):

| Contract | Decoded tables |
| --- | --- |
| Consensus | `safe_gnosis.SafenetAegisConsensus_evt_*` |
| SentinelOracle | `safe_gnosis.SafenetAegisSentinelOracle_evt_*` |
| FROSTCoordinator | `safe_gnosis.SafenetAegisFROSTCoordinator_evt_*` |
| Staking | `safe_ethereum.Staking_evt_*` (already used) |
| SAFE rewards distributor | `safe_ethereum.CumulativeMerkleDrop_evt_*` |
| Safenet 7702 Executor | not decoded (no metric reads it) |

The models still read raw logs until the parity check below holds and each switch passes its preview reconciliations.

**Staking (Ethereum) is decoded on Dune** as `safe_ethereum.Staking_evt_*`, so the staking models read the decoded tables instead of raw logs. All reads go through one query, [`staking_events`](../dune/queries/staking_events/query.sql), which is the only query that names those tables (`test/safenet.test.ts`). The validator → staker relation (`ValidatorStakerSet`) comes from the decoded Aegis Consensus table in `staking_validator_stakers`. Coverage of the decoded tables from the deploy block 24585750 is checked by `verify:staking`: each preview compares Dune's results with an RPC replay over the same block range ([metrics/staking.md](metrics/staking.md#validation)).

The **Validators** models read Consensus (epochs, attestations, staker settings) and the FROSTCoordinator (key generation and signing) from the decoded tables in `validator_epochs`, `validator_membership`, `validator_ceremonies` and `validator_staker_history`. Beta Consensus is not decoded, so `validator_staker_history` still reads its `ValidatorStakerSet` from `gnosis.logs` ([metrics/validators.md](metrics/validators.md#decoding-and-coverage)).

**Beta signing** (`validator_beta_participation`) reads raw `gnosis.logs`, like the Beta staker history:
- the Beta FROST coordinator `0xae27…d7e4`: `SignShared`, `SignCompleted`, with the same signatures as Aegis's;
- the Beta Consensus `0x2236…cEE9`: `TransactionAttested`, whose Beta signature differs (`BETA_TRANSACTION_ATTESTED` in `src/safenet.ts`).

Dune has decoded the Beta Consensus as *SafenetBetaConsensus*. Both contracts are listed for `check-decoded`, so the preview comment reports their tables. A switch to decoded tables follows the steps below, with a parity check of the raw and decoded events.

The FROSTCoordinator is shared by Aegis (mainnet) and the Aegis testnet. Decoded or not, its events cannot be attributed to Aegis by address alone: the models keep only ceremonies initiated by Aegis Consensus and groups named by it.

**Mixing raw logs with decoded tables.** Dune's decoded tables can trail its raw logs by a minute or so. A model that combines raw logs with decoded events must therefore end at the decoded events' last block. `safenet_fee_flows` and `safenet_sentinel_wallet_transfers` drop USDC.e transfers after the last block of `safenet_events`, the `through_block` the fee allocation and the Sentinel figures report. They take that bound from the read of `safenet_events` they already make, so no read is added (`test/safenet.test.ts`). Without the cap, a Sentinel claim inside that minute made available and locked bond end at different blocks (Refresh of 2026-11-02, OpenCover, Candide and BlockSec, 800.133333 USDC.e each).

## Switches

| Date | Models | Evidence |
| --- | --- | --- |
| 2026-10-29 | `safenet_events`, `safenet_sentinel_texts` | `decoded-parity` in [#9](https://github.com/safe-research/safenet-analytics/pull/9): all 21 Consensus and SentinelOracle events match the raw logs log by log, from the deploy blocks to block 48987090 (for example 584 requests, 1,336 commits and reveals, 14 disputes). [#10](https://github.com/safe-research/safenet-analytics/pull/10): request recount, Network & revenue and Sentinels reconciliations without mismatches. |
| 2026-11-02 | `validator_epochs`, `validator_membership`, `validator_ceremonies`, `validator_staker_history` (Aegis part), `staking_validator_stakers`, `safenet_reward_events` | `decoded-parity` in #9 and #10: the Consensus epoch and staker events, all FROSTCoordinator events (for example 2,997 `SignShared`) and both distributor events match the raw logs from the deploy blocks. The switch's preview reconciliations: see its pull request. |

`safenet_sentinel_failed_calls` reads call traces, which the parity check does not cover yet; the USDC.e transfer and Safe guard models read contracts that are not decoded under the Safenet namespace.

## Replacing raw logs with decoded tables

Only replace the decoding when all of the following hold:

1. **Decoded everywhere it matters.** `check-decoded` lists Consensus and SentinelOracle.
2. **Full history.** The decoded event tables start at the deploy blocks: their minimum `evt_block_number` is at or before the first raw event of each type in `safenet_events`. Dune sometimes backfills decoded tables gradually.
3. **The same logs over identical block ranges.** `npm run dune -- decoded-parity` ([`src/decoded-parity.ts`](../src/decoded-parity.ts)) is read-only. It runs one unsaved query per decoded contract and compares every decoded event table with the raw logs of the same contract and topic0, log by log (transaction hash and log index). It covers the range from the deploy block to the latest block at least a day old, and reports the first block on each side, which shows a partial backfill. Every event must show *all logs match*, or *no logs on either side yet* for events that never happened. `test/decoded-parity.test.ts` requires the check to cover every event a model reads from raw logs; USDC.e transfers, Safe guard changes and guard deployments stay raw. The Preview workflow runs the check, at a few credits, whenever a pull request changes it or a model that decodes raw logs, and posts the result in the comment.
4. **Same output.** In the pull request that switches the query, both preview reconciliations must show no mismatches: the counter, every daily value, every window and network, the result breakdown and the fee allocation must equal the RPC recount.

The same rules apply to the other three models. For `safenet_fee_flows`, the decoded transfer table must give the same rows over the same block range. For the guard models, a decoded table must cover every Safe version on each network.

Then rewrite the CTEs of `safenet_events` to read the decoded tables, keep the output columns unchanged, and keep the `oracle` = Aegis SentinelOracle filter. Update the topic0 test, which then checks the decoded-table names instead. Note the switch and the parity evidence in this file.
