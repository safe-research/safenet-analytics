# Network & revenue

The *Network & revenue* section of [dune.com/safe/safenet](https://dune.com/safe/safenet). It covers Safenet **production** ("Aegis") only. Beta was a separate network with different contracts and is never read, so "all time" means production activity since the first production request (2026-10-14).

All queries read shared models, so counters, charts and tables reconcile by construction:

| Model | One row per | Used for |
| --- | --- | --- |
| [`safenet_events`](../../dune/queries/safenet_events) | decoded event ([decoding.md](../decoding.md)) | everything |
| [`safenet_requests`](../../dune/queries/safenet_requests) | request: status, votes, attestation, fee accounting | counters, windows, results, networks, fees |
| [`safenet_fee_flows`](../../dune/queries/safenet_fee_flows) | USDC.e transfer to or from the Sentinel Oracle, classified | fee allocation and its checks |
| [`safenet_known_traffic`](../../dune/queries/safenet_known_traffic) | known operational or test Safe | traffic classes |
| [`safenet_guards`](../../dune/queries/safenet_guards), [`safenet_guard_status`](../../dune/queries/safenet_guard_status) | guard deployment; Safe with a production guard | Guard-enabled Safes |

## Panels

| Panel | Query | Time basis |
| --- | --- | --- |
| Data as of | `network_summary` | Latest Gnosis Chain block Dune has ingested, latest request, and computation time |
| Requests, Completed results, Validator attestations, Safes with completed checks, Gross fees collected | `transaction_checks_daily` (requests), `network_summary` (the others) | All time |
| Guard-enabled Safes now | `guard_adoption` | Current status |
| Activity and fees by time window | `network_summary` | Rolling last 24 hours, 7 days and 30 days before computation, and all time |
| Requests and completed results per day | `transaction_checks_daily` | Last 30 UTC days, flows on the day they happen |
| Requests by proposal day and current status | `results_daily` | Last 30 UTC days by proposal day, current status |
| Activity by Safe network (bars and table) | `network_breakdown` | All time |
| Guard-enabled Safes by network | `guard_adoption` | Current status |
| Fees per day, cumulative fees | `fee_revenue_daily` | Last 30 UTC days; the cumulative total counts from the first request |
| Fee allocation | `fee_allocation` | All time |
| Fee terms and changes | `fee_config` | All time |
| Latest requests | `latest_requests` | 25 most recent |

## Identifiers and counting rules

| Measure | Counted as | Stable identifier | Time |
| --- | --- | --- | --- |
| **Request** (protocol request) | A production `TransactionProposed` paired with its `NewRequest`. Each one paid the fee. | Oracle `request_id`: the EIP-712 hash of epoch, oracle, oracle data and `safeTxHash` | Proposal block |
| **Unique Safe transaction** | Distinct (network, Safe, `safeTxHash`) among requests | `safeTxHash` with network and Safe | Proposal block |
| **Sentinel response** | A `Revealed` vote. A committed vote that is never revealed is a missing response and is not counted. | (`request_id`, Sentinel) | Reveal block |
| **Completed result** | A request with a verdict: an undisputed `OracleResult` (approved or denied), or the arbitrator's `DisputeResolved` | `request_id` | Verdict block |
| **Validator attestation** | `TransactionAttested` with the production oracle | `safeTxHash` and epoch | Attestation block |
| **Safes with requests / with completed checks** | Distinct (network, Safe) with a request, or with a completed result, in the period | Network and Safe address | As above |

**Deduplication and retries.**
- Every log is counted once.
- A Safe transaction proposed again, for example in a later epoch after a dispute, is a **new request** (it paid again), but the same unique Safe transaction.
- A request has exactly one status, so lifecycle transitions are never counted twice. For example, a dispute that is later ruled counts once as *disputed* in the breakdown and once as a *completed result* on its ruling day.

**Flows vs status.**
- Daily activity, the time windows and the fee charts are **flows**: each event counts on the UTC day, or within the window, in which it happened.
- The result breakdown and Guard-enabled Safes are **status counts**: each request (or Safe) is counted once, in its current status. Past days can change as their requests are decided.

## Result breakdown

Each request has one current status, decided by the Sentinel Oracle rules (`SentinelOracleRequests.sol`, `finalize`):

| Status | Meaning | Colour |
| --- | --- | --- |
| Secure (unanimous) | `OracleResult` approved: every revealed vote approved | green |
| Disputed (incl. ruled) | Revealed votes disagreed (`DisputeTriggered`) | yellow |
| Insecure (unanimous) | `OracleResult` denied: every revealed vote denied | red |
| Timed out, no verdict (final) | No Sentinel revealed a vote (`RequestTimedOut`); the fee is refunded | dark grey |
| Pending (not yet decided) | Voting open, or not finalized yet | light grey |

**Disputed requests.**
- They **stay disputed after arbitration.** The ruling is shown in the latest-requests table (secure, insecure, no ruling, awaiting ruling) and in the table's "awaiting ruling" column.
- A ruling of secure or insecure is a completed result. Out of scope, or no ruling within about 28 days, ends without a verdict.
- Disputed transactions are never attested, whatever the ruling.

**"Unanimous"** means every *revealed* vote agreed. There is no quorum, so one revealed vote is enough, and a Sentinel that commits but does not reveal loses part of its bond. Missing responses, technical failures and timeouts are never counted as secure.

**Colours** are fixed per status. The stack order (green, yellow, red, dark grey, light grey) keeps green and red apart for colour-blind readers. Every status is named in the legend and in the table below the chart. The greys are deliberately colourless, because they mean "no verdict".

## Networks

The network is the **Safe's network**, taken from the request's `safeId` (chain ID in the top 96 bits). It is not Gnosis Chain, where the Consensus and Sentinel Oracle run for every network.

## Test and operational traffic

- **Charter networks.** Headline activity counts Safes on the networks the Charter covers: Ethereum, Gnosis Chain and Arbitrum One.
- **Test traffic** (`test_uncovered_chain`): requests for Safes on any other network. They are only shown as *Test requests* and as a separate row in the network table. So far there is one, on Polygon.
- **Operational traffic** (`operational`): Safes listed in [`dune/data/known-traffic.json`](../../dune/data/known-traffic.json), each with its source. Currently that is the Safenet Arbitrator Safe on Gnosis Chain. Its requests are real production checks, so totals **include** them and the window table shows them as *of which Safenet operational*.
- **Fees are money actually received.** Gross fees therefore include every request, including test requests (0.40 USDC.e so far).
- **Attribution limits.**
  - Safenet records no origin, so nothing is labelled as Safe{Wallet} activity. `proposeTransaction` is permissionless, and the sponsor in `NewRequest` is only the account that paid the fee: today a handful of relayer and Safe accounts. Requests from wallets, scripts and tests by the same sponsors cannot be told apart.
  - There is no list of production test Safes beyond the network rule and the known operational Safes.

## Guard-enabled Safes

- **What counts.** A Safe whose **current** transaction guard is a SafenetGuard bound to the production Consensus.
- **How it is determined.** From the Safe's own `ChangedGuard` events on Ethereum, Gnosis Chain and Arbitrum One. The latest event wins, so removing the guard or switching to another guard ends the status.
  - Safe 1.3.0 logs the guard address in the event data; 1.4.1 and later as `topic1`. Both are read.
  - Module guards are ignored, because SafenetGuard guards transactions only.
- **Requesting checks without the guard is not Guard activation.** Those Safes are not counted.
- **Which guards are production.** No guard address is documented, so guards are found on chain: every SafenetGuard emits `EpochInitialized` in its constructor. A guard is production only if its creation trace shows the production Consensus. Either its constructor arguments must be chain 100 and `0xc855761D…aa96`, or its runtime code must embed the production Consensus domain separator `0x0a60fd26…b097`, which equals `Consensus.domainSeparator()`. Testnet guards are never counted.
- **No production guard yet.** As long as none is deployed on a network, that network shows *not available*, not 0. No guard deployment was found on Gnosis Chain by RPC (2026-10-26). Ethereum and Arbitrum One are checked by the query.

## Revenue

**Gross transaction fees collected** are the fees actually paid into the Sentinel Oracle: `NewRequest.fee` of every request, in USDC.e. The check *fees recorded minus fees received* compares this with the USDC.e `Transfer` in the same transaction.
- It is not estimated from request counts or today's fee.
- Refunds do not reduce it. They are a separate line, and *net retained* would be gross minus refunds.

**No USD values, APY or profitability** in this section.

### Fee allocation

Where the fees went, per the contract rules (`SentinelOracleRequests.sol`):

| Row | Accrued (assigned by the contract) | Paid (USDC.e transfers) | Outstanding |
| --- | --- | --- | --- |
| Gross fees collected | Σ `NewRequest.fee` | Σ fee transfers into the oracle | |
| Refunded to sponsors (no verdict) | Full fee of timed-out requests, and of disputes without a ruling | (in *All refunds paid*) | |
| Sentinel fee rewards (total and per Sentinel) | Winning-side revealers share `fee − daoCut`, each `floor((fee − DAO share) / winners)`. Paid on denials too, not on timeouts | Σ `Claimed.feeReward` | Accrued − paid: claimable, a liability |
| Protocol funds receiver | `daoCut` (DAO share, 0% so far, plus the split remainder), non-revealer slashes, and arbitrated slashes beyond the refund | Transfers to `0x9D02…6127` | Accrued − paid |
| Held for undecided requests | Fees of pending requests and of disputes awaiting a ruling | | Held by the oracle |
| Refunded to sponsors after arbitration | The fee, refunded **from the losing Sentinels' slashed bonds**; the winners still share the fee | | |
| All refunds paid | Both refund kinds | Transfers to sponsors in the refunding transactions | Accrued − paid |
| Bonds (not revenue): deposited, returned, slashed, outstanding | 800 USDC.e per committed vote | Bond transfers in; claims | Unclaimed bonds |
| Checks (expected 0) | Fees recorded minus received; claim events minus claim transfers; unclassified oracle transfers; oracle balance minus obligations | | |

- **Per-Sentinel rows** come from [`safenet_sentinel_responses`](../../dune/queries/safenet_sentinel_responses), the per-(request, Sentinel) model of the [Sentinels](sentinels.md) section, with the same rule. The query reads each model once and expands its rows from one row of totals: Dune inlines every query reference and CTE, and the earlier form exceeded Dune's limit on query stages ([decoding.md](../decoding.md#the-decoding-query)).
- **Classification is never by amount.** Refunds and receiver payouts have no event of their own. They are identified as transfers from the oracle to the request's sponsor, or to the receiver, in the transaction that ended the request ([`safenet_fee_flows`](../../dune/queries/safenet_fee_flows)).
- **Recipients are never assumed.** They are the addresses in `Claimed` events and transfers, and Sentinel names come from [safe-fndn/safenet-data](https://github.com/safe-fndn/safenet-data) as labels only (unknown addresses show the address).
- **Not part of this section:** SAFE incentives and staking (Ethereum), bond deposits, and funding transfers.
- **Zero vs missing.** A value is 0 only when every relevant event was read and the configuration confirms it. For example, the DAO share is 0 on every request. Values that cannot be observed are *not available*, not 0. The fee allocation has no unobservable rows: every transfer of the oracle is classified.

### Fee terms

[`fee_config`](../../dune/queries/fee_config) lists every distinct set of terms actually charged, from each request's `NewRequest`: fee, bond per vote, DAO share and slash. It also lists every governance schedule event (`FeeScheduled`, `DaoFeeShareScheduled`, `ProtocolFundsReceiverScheduled`, `BondConfigScheduled`), which take effect after a delay of about 3 days.

Since deployment one set applies: a 0.40 USDC.e fee, an 800 USDC.e bond, a 0% DAO share and a 0.40 USDC.e slash. No change has been scheduled, so there are no zero-fee periods or fee changes.

## Freshness

*Data as of* is the latest Gnosis Chain block time in Dune when the query ran. The section is as fresh as the daily refresh (05:17 UTC) plus Dune's ingestion delay. The current UTC day is partial.

## Verification

[`scripts/verify-network-revenue.ts`](../../scripts/verify-network-revenue.ts) recounts the section from Gnosis Chain RPC logs, using the same rules in TypeScript ([`scripts/lib/recount.ts`](../../scripts/lib/recount.ts), unit-tested in `test/recount.test.ts`).
- **What it compares** with the latest Dune results, each at the block that result read (`through_block`):
  - every time window;
  - every network;
  - every day and status of the result breakdown;
  - every fee-allocation line.
- **What it checks independently of Dune:**
  - every oracle transfer is classified;
  - fees recorded equal fees received, and claim events equal claim transfers;
  - refunds and receiver payouts equal what is due;
  - the oracle's on-chain USDC.e balance equals transfers in minus out, which equals its outstanding obligations: held fees, unclaimed rewards and unclaimed bonds.
- **Where it runs:** after every preview deploy, with results in the pull request comment, and after every production refresh.
- **Spot checks:** it lists a representative request for each lifecycle path, with Safenet explorer and Gnosisscan links, for comparison with [safenet-explorer.eth.limo](https://safenet-explorer.eth.limo/).

Result up to Gnosis block 48947889 (2026-10-26), in [`verification/network_revenue.json`](../../verification/network_revenue.json):

**Requests:** 263.

| Status | Requests |
| --- | --- |
| Secure (unanimous) | 195 |
| Insecure (unanimous) | 52 |
| Disputed | 9 |
| Timed out | 7 |

**Fees (USDC.e):**

| Line | Amount |
| --- | --- |
| Gross fees | 105.20, equal to the fees received |
| Refunds | 6.00 (2.80 from fees, 3.20 from slashed bonds) |
| Sentinel rewards accrued | 101.999975 |
| Sentinel rewards claimed | 101.599976 |
| Protocol funds receiver | 0.000025 (split remainders) |
| Held for undecided requests | 0.40 |

**Checks:** every fee check is 0 and no transfer is unclassified. The oracle's balance, 4800.799999 USDC.e, equals its obligations.

## Limitations and follow-ups

- **No production SafenetGuard address is documented,** so *Guard-enabled Safes* depends on on-chain discovery. If Safenet publishes the addresses, pin them in the repository as well.
- **Ethereum and Arbitrum logs scans grow over time.** The guard queries scan `ethereum` and `arbitrum` logs from 2026-09-01 by event signature. Their cost grows with time; Dune's decoded Safe tables or a materialized view would bound it ([decoding.md](../decoding.md)).
- **Some approved requests are never attested.** Two were found in epoch 33915 (2026-10-23 census). They show as secure without an attestation. The cause is unknown; an approval that arrives after the validators' signing window is never attested. The gap is the difference between unanimous-secure requests and attestations.
- **No origin attribution:** see [Test and operational traffic](#test-and-operational-traffic).
- **The protocol funds receiver is a constant** (`0x9D02…6127`). A `ProtocolFundsReceiverScheduled` event would appear in the fee terms table, and the classification would need the new address.
