# Transaction checks per day

Query: [`dune/queries/transaction_checks_daily`](../../dune/queries/transaction_checks_daily) · Chart: *Requests, completed checks and attestations per day* on [dune.com/safe/safenet](https://dune.com/safe/safenet)

The query counts Safenet **production** activity per UTC day. It has three headline numbers: transactions submitted for checking, checks that reached a verdict, and transactions the validators attested. These are three different stages and their counts differ.

## Definitions

| Column | Counts | Event (production contracts only) |
| --- | --- | --- |
| `requests` | Transactions proposed for checking. Each one is a paid Sentinel Oracle request (0.40 USDC.e). | `Consensus.TransactionProposed` with `oracle` = production SentinelOracle (one-to-one with `SentinelOracle.NewRequest`) |
| `completed_checks` | Requests that got a verdict: approved or denied by the Sentinels, or ruled on by the Security Council after a dispute | `SentinelOracle.OracleResult`, `SentinelOracle.DisputeResolved` |
| `checks_approved` / `checks_denied` | Split of `completed_checks`. A Council ruling of *secure* counts as approved, *insecure* as denied. | `OracleResult.approved`; `DisputeResolved.outcome` (3 approved, 4 denied) |
| `closed_without_verdict` | Requests that ended without a verdict and were refunded: nobody voted or revealed, the Council declined the dispute, or arbitration timed out. These are **not** completed checks. | `RequestTimedOut`, `DisputeOutOfScope`, `ArbitrationTimedOut` |
| `attestations` | Transactions the validators signed with the group's threshold (FROST) signature, which lets the Safe execute them | `Consensus.TransactionAttested` with `oracle` = production SentinelOracle |
| `uncovered_chain_*` | The same counts for Safes on chains outside the Charter: likely test traffic, excluded from the columns above | as above |
| `unmatched_events` | Data-quality check, always expected to be 0: outcomes without a production request, or proposals without an oracle request | |

Each event is counted on the UTC day of its own block. The proposal, the verdict and the attestation of one transaction can fall on different days, so a day can have more completed checks than requests.

### How the stages relate

1. Anyone calls `Consensus.proposeTransaction`. In the same transaction, Consensus emits `TransactionProposed`, starts a signing ceremony on the FROSTCoordinator, and posts a request to the Sentinel Oracle (`NewRequest`, which collects the fee). The oracle's `requestId` is the proposal's EIP-712 message hash.
2. Sentinels commit and then reveal votes. The final reveal, or a later `finalize`, produces exactly one result:
   - `OracleResult` (approved or denied): a completed check.
   - `DisputeTriggered`: Sentinels disagreed. The request is frozen until the Council's `DisputeResolved` (a completed check), or `DisputeOutOfScope` / `ArbitrationTimedOut` (no verdict).
   - `RequestTimedOut`: nobody voted or revealed (no verdict).
3. Only approved, undisputed requests are signed by the validators, which ends in `TransactionAttested`. Disputed transactions are never attested, even when the Council rules them secure. An approval can also go unsigned if it arrives after the validators' signing timeout.

So `attestations` ≤ `checks_approved` ≤ `completed_checks` ≤ `requests` over time. The day-by-day numbers need not follow this order.

### Why not other events

- **FROSTCoordinator `Sign` / `SignCompleted`** are not used. Production and the Aegis testnet share the same coordinator (`0xC6B34dA4…5B78`, deployed with CREATE2), so these events mix both networks. They also include epoch rollovers and restarted signing ceremonies. `Sign` fires at proposal time, even for checks that are later denied.
- **Beta metrics do not apply.** Beta used a different Consensus contract (`0x223624cB…cEE9`) from before the Sentinel Oracle existed. Its events and lifecycle differ, and none of its contracts are read here.

## Sources

Production ("Aegis") contracts on Gnosis Chain:

| Contract | Address | Deployed at block |
| --- | --- | --- |
| Consensus | [`0xc855761D619f6002923507cE68B84d7689C2aa96`](https://gnosisscan.io/address/0xc855761D619f6002923507cE68B84d7689C2aa96) | 48635843 |
| SentinelOracle | [`0x4F61B8832978e83b80D69551AEf07557DBE41d03`](https://gnosisscan.io/address/0x4F61B8832978e83b80D69551AEf07557DBE41d03) | 48635850 |

- Addresses: `safe-research/safenet` [`docs/configuration.md`](https://github.com/safe-research/safenet/blob/4ed5101/docs/configuration.md), "Aegis Network". The explorer's production defaults use the same addresses.
- Deploy blocks: `safe-research/safenet-beta-wallet-extension` `src/constants.ts`.
- Lifecycle and outcome meanings: `safe-research/safenet` [`docs/transaction-lifecycle.md`](https://github.com/safe-research/safenet/blob/4ed5101/docs/transaction-lifecycle.md).
- Events: `contracts/src/interfaces/IConsensus.sol`, `contracts/src/SentinelOracle.sol`, `contracts/src/libraries/SentinelOracleRequests.sol`, `contracts/src/interfaces/IOracle.sol`, all at commit `4ed5101`.
- Checked on-chain: `SentinelOracle.PROPOSER()` is the production Consensus, and both production and testnet Consensus return the same `getCoordinator()`.

The query reads raw `gnosis.logs`, because Dune has not decoded these contracts. [`src/safenet.ts`](../../src/safenet.ts) lists every event signature with its topic0. `test/safenet.test.ts` recomputes each topic0 from its signature and checks that the SQL uses exactly those values and none of the Beta, testnet or shared coordinator addresses.

## Test traffic

- **Testnet** runs on separate Consensus and Oracle contracts, so filtering on the production contracts excludes it.
- **Other oracles.** `proposeTransaction` accepts any oracle, but validators and the explorer only act on the production Sentinel Oracle. Proposals naming another oracle are excluded (none so far).
- **Uncovered chains.** The Charter covers Safes on Ethereum (1), Gnosis Chain (100) and Arbitrum One (42161). A request's Safe chain is the top 12 bytes of `safeId`. Requests for other chains are counted separately as likely tests. So far there is one, on Polygon (137).
- **Not identified.** There is no list of production test Safes or test accounts. The relayer serves both testnet and production, so the proposer (`NewRequest.sponsor`) cannot separate them either. Requests from Safenet's own operational Safes are included. For example, the Arbitrator Safe `0xc89Ae483…8348` on Gnosis Chain made 7 requests up to 2026-10-23. Requests are made by 5 sponsor addresses.

## Limitations

- **Requests are paid proposals, not distinct Safe transactions.** The same Safe transaction can be proposed again in a later epoch, for example after arbitration, and is then counted again.
- **Launch period.** The first production requests were on 2026-10-14. All 4 requests that day closed without a verdict.
- **Open requests.** Requests still being voted on, frozen in a dispute, or approved but not yet signed have no outcome yet. They appear in later days' counts once resolved.
- **Approved but unattested.** An approval that arrives after the validators' signing timeout is never attested, and there is no event for this. It shows only as the gap between `checks_approved` and `attestations`. Disputed transactions ruled secure also make up part of this gap.
- **Freshness.** The data is as fresh as the last refresh (daily, 05:17 UTC) plus Dune's Gnosis Chain ingestion delay. The current UTC day is partial.

## Verification

[`scripts/verify-transaction-checks.ts`](../../scripts/verify-transaction-checks.ts) recomputes the table from Gnosis Chain RPC logs, independently of Dune. It checks:

- every production proposal pairs with exactly one oracle request, in the same transaction, after the proposal;
- each request has at most one terminal outcome;
- every attestation follows an approved check of the same safeTxHash and epoch;
- with `DUNE_API_KEY` set and the query deployed, every complete UTC day and column matches Dune's latest result.

The Refresh workflow runs it after every refresh. The result up to Gnosis block 48902093 (2026-10-23 13:35 UTC) is in [`verification/transaction_checks_daily.json`](../../verification/transaction_checks_daily.json), with all invariants holding:

- **Requests:** 181 in total. 180 are on covered chains; 180 of the 181 have an outcome, 1 is still open.
- **Completed checks:** 172, of which 144 were approved and 28 denied. 8 disputes were triggered.
- **Closed without a verdict:** 7.
- **Attestations:** 138.
- **Uncovered chains:** 1 request (Polygon), with a completed check.

The comparison with Dune runs once the query is deployed. Until then the SQL has not been executed on Dune; see the remaining setup steps in [setup.md](../setup.md).
