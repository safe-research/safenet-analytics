# Sentinels

The *Sentinels* section of [dune.com/safe/safenet](https://dune.com/safe/safenet) covers participation, verdicts, coverage, arbitration, earnings, bonds and realized APR of the Safenet **Aegis** ("Aegis") Sentinels. Beta is never read. It reads the shared decoding model [`safenet_events`](../../dune/queries/safenet_events), unchanged, and applies the request rules of the [Network & revenue](network-and-revenue.md) section's [`safenet_requests`](../../dune/queries/safenet_requests):
- the request identifier (`request_id`);
- the lifecycle (verdict, dispute, timeout);
- one row per log;
- the Charter-chain population (`covered_chain`);
- the fee split.

The verification checks both sections against the same chain data.

**Query size.** Dune inlines every query reference and CTE where it is used, so the Sentinel models read `safenet_events` once each: one aggregation per request, with each Sentinel's actions kept in arrays. They do not read `safenet_requests`, which reads it several times over. See [decoding.md](../decoding.md#the-decoding-query).

| Model | One row per | Used for |
| --- | --- | --- |
| [`safenet_sentinel_terms`](../../dune/queries/safenet_sentinel_terms) | Sentinel membership term | current status, eligibility |
| [`safenet_sentinel_responses`](../../dune/queries/safenet_sentinel_responses) | (request, Sentinel) where the Sentinel was eligible or committed | every Sentinel panel |
| [`safenet_sentinel_texts`](../../dune/queries/safenet_sentinel_texts) | recorded reveal reason or arbitrator context | disputes |
| [`safenet_sentinel_failed_calls`](../../dune/queries/safenet_sentinel_failed_calls) | reverted `commit` / `reveal` call (traces) | reverted commits, reverted calls |
| [`safenet_sentinel_wallet_transfers`](../../dune/queries/safenet_sentinel_wallet_transfers) | USDC.e transfer of a Sentinel account, plus one `meta` row with its cutoff block and time | available bond token, APR cutoff |
| [`safenet_reward_events`](../../dune/queries/safenet_reward_events) | event of the SAFE rewards distributor on Ethereum | SAFE claimed |
| [`safenet_sentinel_rewards`](../../dune/queries/safenet_sentinel_rewards) | published Merkle root, and Sentinel entry under it | SAFE published |

## Panels

On the [Sentinels dashboard](https://dune.com/safe/safenet-sentinels):

| Panel | Query | Time basis |
| --- | --- | --- |
| Sentinels data as of | `sentinel_overview` | Latest Gnosis Chain block Dune has ingested, and computation time |
| Sentinel overview | `sentinel_overview` | Status: **now**. Counts: all time |
| Participation by time window | `sentinel_windows` | Requests proposed in the last 24 hours, 7 days, 30 days, all time |
| Participation per day (pivot table, Sentinel × day) | `sentinel_participation_daily` | Last 30 UTC days, by proposal day |
| Sentinel responses by kind (bars and table) | `sentinel_verdicts` | Bars: requests proposed in the last 30 days. Table: also all time |
| Requests by number of valid responses (bars and table) | `sentinel_coverage` | Bars: last 30 days. Table: also all time, by proposal time |
| Sentinel earnings | `sentinel_earnings` | All time and last 30 days (fees); latest published root (SAFE) |
| Fee rewards per day by Sentinel | `sentinel_earnings_daily` | Last 30 UTC days, by decision day |
| Sentinel bonds | `sentinel_bonds` | Available and locked: **now**. Movements: all time |
| Realized Sentinel APR (two charts and a table) | `sentinel_apr` | Completed two-week Aegis reward periods, from 2026-10-13 |

On the [Arbitration dashboard](https://dune.com/safe/safenet-arbitration), plus one counter on the overview:

| Panel | Query | Time basis |
| --- | --- | --- |
| Open arbitrations, oldest open arbitration (counters) | `arbitration_resolution` | **Now** (latest execution) |
| Arbitration rate by request cohort | `arbitration_windows` | Requests proposed in the last 24 hours, 7 days, 30 days, and since Aegis start (2026-10-07) |
| Arbitration rate per proposal day | `arbitration_daily` | Every UTC proposal day since the first Aegis request |
| Time from dispute (freeze) to ruling, per ruled case | `sentinel_disputes` | All ruled cases, at their dispute time |
| Time from dispute (freeze) to ruling (median, p90, longest) | `arbitration_resolution` | Cases ruled in the last 30 days, and since Aegis start |
| Disputes and arbitration | `sentinel_disputes` | All disputes, newest first |
| Overview: arbitration rate, last 30 days | `arbitration_windows` | Requests proposed in the last 30 days |

"All time" means Aegis since the first Aegis request (2026-10-14).

## Participation

### Protocol semantics

Verified in the deployed SentinelOracle's source, `safe-research/safenet` at `4ed5101`, which is the current head:
- **Commit, then reveal.** A Sentinel first commits a hash of its vote (`commit`, `SentinelOracle.sol:245`). This transfers the request's bond and emits `Committed`. After the commit window it reveals the vote (`reveal`, `:253`), emitting `Revealed(approved, bondAmount, reason)`.
- **Windows.** `NewRequest` sets the windows per request: commits are accepted up to `commitDeadline`, reveals after it and up to `revealDeadline` (`SentinelOracleRequests.sol:117-127`). Both windows are 6 blocks on Aegis (about 30 seconds).
- **Automatic finalization.** When the last committed Sentinel reveals, the request finalizes in the same transaction (`SentinelOracle.sol:256-258`).
- **Abstaining leaves no trace.** A Sentinel whose engine returns *abstain*, or that errors, does not commit at all (`docs/sentinel-engine.md`, `crates/sentinel/src/service.rs`). This is indistinguishable on chain from a Sentinel that is offline.
- **Invalid or late calls revert without an event.** This covers a commit after the window, a reveal outside its window, a reveal that does not match the commitment, a repeated call, and a commit without enough USDC.e for the bond. The reverted call in the transaction traces is the only record.
- **No quorum.** One revealed vote is enough for a verdict.

### Membership and eligibility

Membership comes only from the Sentinel Oracle's events (`SentinelMap.sol`):
- **Scheduling.** `SentinelScheduled(sentinel, activeAtBlock)` schedules a Sentinel. It may commit from `activeAtBlock`, the scheduling block plus 51 840 blocks (about 3 days).
- **Removal.** `SentinelRemoved` takes effect immediately. A Sentinel removed before its activation block was never active.
- **Re-adding.** A Sentinel can be re-added; each scheduling starts a new term.

A request is **eligible** for a Sentinel if the Sentinel was a member during the request's commit window: `active_from_block ≤ commitDeadline`, and not removed at or before the proposal block. Joining or leaving therefore changes only the requests made while the Sentinel was a member, never earlier ones. A Sentinel that committed is always included, so rates cannot exceed 100%. The verification confirms that no Sentinel ever committed while not a member.

Names come from [`safe-fndn/safenet-data` `assets/sentinel-info.json`](https://github.com/safe-fndn/safenet-data/blob/main/assets/sentinel-info.json):
- **Matching.** Addresses are matched in lowercase, and the source address is kept as published (`source_address`).
- **Fallback.** Unknown Sentinels show their address. Two scheduled addresses currently have no name: `0x3bf9…40a5`, active and never committing, and `0x0637…a3ca`, removed before activation.
- **Not proof of membership.** Being listed, or `is_active` in that file, is not membership.

### Response states

Each (request, Sentinel) row has exactly one state. It is judged against `as_of_block`, the latest Gnosis block Dune has ingested.

| State | Shown as | Meaning | Response? |
| --- | --- | --- | --- |
| `secure` | Secure | Revealed vote approving (`Revealed.approved = true`) | valid response |
| `insecure` | Insecure | Revealed vote denying | valid response |
| `missing_response` | Missing response (committed, not revealed) | Committed, never revealed, and the reveal window has closed or the request has ended. Slashed if another Sentinel revealed. | no |
| `reverted_commit` | Commit reverted (late or invalid) | Tried to commit, but every attempt reverted | no |
| `no_commit` | No commit (abstain or offline) | Eligible, never committed nor tried, and the commit window has closed | no |
| `pending_commit`, `pending_reveal` | Pending | The commit or reveal window is still open | not yet |

- **Missing responses are not abstentions.** A commit without a reveal is not a completed response.
- **Pending is not missed.** Requests whose window is still open are pending, in neither part of any rate.
- **Reverted calls.** The overview also counts every reverted `commit` and `reveal` call (*Reverted calls*) and shows the last recorded revert reason. A reverted reveal does not change the state: a Sentinel whose reveal reverted and never succeeded is a *missing response*.

**Late vs invalid.** A reverted commit after `commitDeadline` is late. A reverted reveal is early if it is at or before `commitDeadline`, late if after `revealDeadline`, and otherwise invalid. Up to block 48951413 (2026-10-26) there were 147 reverted commit and reveal calls, all in time:
- **IntentGuard: 142 commits.** All reverted with *ERC20: transfer amount exceeds balance*, so it could not post the 800 USDC.e bond. Its account holds about 160 USDC.e.
- **BlockSec: 2 commits and 1 early reveal.**
- **Candide: 1 early reveal.**

### Denominators

| Measure | Numerator | Denominator |
| --- | --- | --- |
| **Participation rate** (overview, windows, per-day pivot) | valid reveals on eligible requests | eligible requests with a closed response window, Charter chains |
| Eligible requests (overview) | | eligible requests with a closed response window |
| Response kinds (verdict breakdown) | each state | all closed (request, Sentinel) rows. secure + insecure + missing + reverted + no commit = eligible requests |
| Coverage | requests by number of valid responses | requests whose response window has closed (a verdict, a dispute, a timeout, or the reveal deadline passed) |

**Population.** Requests for Safes on the Charter's chains (`covered_chain`), exactly as the Network & revenue counts:
- Safenet's own operational Safes are included.
- Requests for Safes on other chains are likely tests and are excluded.

Fees and bonds include every request, test traffic too, because that money really moved. This also matches the Network & revenue fee allocation.

**Time.** Windows and days are by the request's **proposal time**. A request proposed on a day counts on that day once its window closes, which is about a minute later.

## Verdicts

The bars show each Sentinel's **own** revealed votes, not the Oracle result and not a ruling. The colours follow the result breakdown:
- green: secure;
- red: insecure;
- dark grey: missing response;
- yellow: commit reverted;
- light grey: no commit.

The stack order (secure, missing, insecure, reverted, no commit) keeps green and red apart for colour-blind readers. The legend and table name every kind.

## Coverage

Valid responses per request, from 0 up to the number of Sentinels that were ever active:
- **Valid only.** Commits without a reveal do not count.
- **Every bucket listed.** The query generates every bucket, so a bucket with no requests shows as an explicit 0, and requests with no valid response are always visible.
- **Pending.** Requests still in their response window are reported separately and are in no bucket.

## Disputes and arbitration

A dispute starts when revealed votes disagree:
- **Oracle result.** The Oracle emits `DisputeTriggered` instead of `OracleResult`, so there is no Oracle result.
- **Arbitrator.** The arbitrator is the Safenet Security Council's Arbitrator Safe `0xc89Ae483…8348` (`ARBITRATOR`).
- **Ending.** The dispute ends with exactly one of:
  - **Ruled.** `DisputeResolved(outcome, slashed, context)`: outcome 3 rules secure, 4 insecure. The losers' bonds are slashed and the fee is refunded from them.
  - **Out of scope.** `DisputeOutOfScope(context)`: no ruling, the fee is refunded and bonds are returned in full.
  - **Arbitration timed out.** `ArbitrationTimedOut`, after about 28 days: no ruling, refund, bonds returned.

The table keeps these apart:
- **Votes.** Each Sentinel's own vote, with its recorded `Revealed.reason`. Approvals carry an empty reason, denials the cited Charter rules.
- **Oracle result.** Always *none: votes differed*.
- **Arbitration status and ruling.** A ruling is never shown as the Sentinels' consensus.
- **Arbitrator's recorded context.** As recorded on chain: HTML-escaped, shortened to 160 characters, with a link to the ruling transaction. Nothing is added when nothing was recorded.
- **Attested.** Always *No*: disputed requests are never attested by the validators, whatever the ruling. *Yes (unexpected)* would flag a data error.
- **Timing.** The request's proposal, the dispute (freeze), the terminal outcome (ruling, out of scope or arbitration timeout), the time to ruling (ruled cases only), and how long a case still awaiting an outcome has been open (as of the latest execution). See [Arbitration rate and resolution time](#arbitration-rate-and-resolution-time).

## Arbitration rate and resolution time

Shown together on their own dashboard, [safe/safenet-arbitration](https://dune.com/safe/safenet-arbitration). Arbitration is a separate stage: the Security Council decides there, not the Sentinels. The dispute table, with each Sentinel's vote and reason, lives there too, and the Sentinels dashboard links to it. The overview has one counter, *Arbitration rate, last 30 days*, next to a link to the Arbitration dashboard. Queries: `arbitration_windows`, `arbitration_daily`, `arbitration_resolution` and the extended `sentinel_disputes`, all built on `safenet_requests`. The TypeScript model is [`scripts/lib/arbitration.ts`](../../scripts/lib/arbitration.ts), unit-tested in `test/arbitration.test.ts`.

### The freeze boundary

A request **enters arbitration** with `DisputeTriggered(requestId, deadline)`:
- **The freeze.** `SentinelOracle.finalize` emits it when the revealed votes include both an approval and a denial, and moves the request to `State.FROZEN`. Source: `contracts/src/SentinelOracle.sol` and `libraries/SentinelOracleRequests.sol` in `safe-research/safenet`, read at commit `c6ab855`. There is no separate freeze event: this is the freeze.
- **The deadline.** `deadline` is the block after which anyone can call `timeoutArbitration`. In Aegis it is always the freeze block + 483,840 blocks, 28 days at 5-second blocks; the verification checks this.

A frozen request leaves arbitration with exactly one terminal event:

| State | Event | Ruling? |
| --- | --- | --- |
| Awaiting outcome | none yet | not yet |
| Ruled secure / ruled insecure | `DisputeResolved` (outcome 3 or 4) | yes |
| Out of scope | `DisputeOutOfScope` (the arbitrator declined) | no |
| Arbitration timed out | `ArbitrationTimedOut` (after the deadline) | no |

### Arbitration rate

- **Population.** As in Network & revenue: requests for Safes on the Charter's chains (Ethereum, Gnosis Chain, Arbitrum One), including Safenet's operational Safes. Requests for Safes on other chains are test traffic and excluded. The dispute table still lists them, marked.
- **Cohorts.** Requests are selected by **proposal time**: the last 24 hours, 7 days and 30 days before the execution, and *Aegis, all time* since 2026-10-07. Each request counts once, in its **latest state**, unresolved arbitrations included. A Safe transaction proposed again in a later epoch is a new request, counted as such, as in the request counter.
- **Rate** = requests that entered arbitration ÷ requests. A window without requests shows *no requests*, not 0%. The awaiting, ruled secure, ruled insecure, out-of-scope and timed-out cases add up to the arbitrated requests.
- **Recent cohorts can rise.** A request still being voted on (*Still being voted on*: no outcome and no dispute yet) can still be disputed. So the latest windows and days can gain arbitrations later. Dispute dates are never mixed in: a request disputed today but proposed 40 days ago is in the all-time cohort only.
- **Per day.** The chart shows each UTC proposal day since the first Aegis request, days without requests included. Columns: requests, arbitrated, still being voted on (left axis). Line: the rate (right axis), with no point on days without requests.

### Resolution time

- **Definition.** From the freeze (`DisputeTriggered`) to the ruling (`DisputeResolved`), in hours, from the two blocks' timestamps.
- **Sample.** Ruled cases only, selected by **ruling time**: *ruled in the last 30 days* and *ruled since Aegis start*. Unresolved cases are excluded. Out-of-scope outcomes and arbitration timeouts end without a ruling: they are counted separately and never as resolved.
- **Median and p90** interpolate linearly between the closest ruled cases (position q × (n − 1) in the sorted durations). **Longest** is the slowest ruled case in the sample. With no ruled case, all three show *no ruled cases*, never 0 hours. The sample size is shown next to them.
- **Individual cases.** A scatter chart shows one point per ruled case, at its dispute time.
- **Open arbitrations.** Frozen requests without an outcome, as of the latest execution. Out-of-scope and timed-out cases have ended and are not open. *Oldest open arbitration* is the hours since the oldest open case's freeze. It is blank when none is open.

Linkage is by `request_id`. The verification recounts, from RPC logs, the disputes, the vote counts, each ruling and the slashed totals.

## Earnings

Transaction-fee rewards (USDC.e) and SAFE subsidies are separate columns and charts, never added together. Bond movements are not earnings and are in [Bonds](#bonds).

### Fee rewards (USDC.e)

Per `SentinelOracleRequests.sol`, `calcFeeReward`:
- **Who earns.** On a verdict, the revealers on the winning side share `fee − daoCut`. Each gets `floor((fee − DAO share) / winners)`, and the remainder goes to the protocol funds receiver.
- **Who does not.** There is no fee without a verdict: timeouts, disputes without a ruling, and pending requests.

| Column | Meaning |
| --- | --- |
| Accrued | the Sentinel's share of every decided request it won |
| Claimed | `Claimed.feeReward`, paid with the Sentinel's claim |
| Outstanding | accrued − claimed: claimable from the Sentinel Oracle |
| Accrued 30d | accrued on requests decided in the last 30 days |

The per-day chart shows accrued rewards on the day the request was decided. The per-Sentinel figures equal the *Sentinel fee rewards* rows of the Network & revenue fee allocation; the verification compares them.

### SAFE subsidies

Sentinel SAFE rewards are paid by Safe Foundation's rewards distributor on **Ethereum**:
- **Contract.** *Safenet Aegis Rewards* ([`0xe5139Fc0…20f2`](https://etherscan.io/address/0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2)), a `CumulativeMerkleDrop` deployed at block 24749707, with SAFE as its `token()`. It is verified on Etherscan and Sourcify.
- **Publication.** Allocations are published as Merkle proofs: for Beta in [`safe-fndn/safenet-data` `assets/rewards`](https://github.com/safe-fndn/safenet-data/tree/main/assets/rewards), which is frozen since; for Aegis on IPFS, pinned by the ENS name `rewards.safenet-gov.eth` (verified against its CID, `src/rewards-ipfs.ts`). The first Aegis period (to 2026-10-27) grants 15,384.62 SAFE to each of two Sentinels, both withheld until KYC (`kycAmount`, not yet claimable). Each version of `latest.json` is one root (`merkleRoot`, `rewardsUntil`), and one proof file per address carries its **cumulative** amount.
- **Sync.** `npm run sync:sentinel-rewards` copies every published root, and every proof of a Sentinel address under it, into [`dune/data/sentinel-rewards.json`](../../dune/data/sentinel-rewards.json) and the `safenet_sentinel_rewards` query, at a pinned commit.

| Column | Meaning |
| --- | --- |
| SAFE published | the cumulative SAFE published for the address under the latest published root, or *No allocation published* |
| SAFE claimed | SAFE claimed by the address from the distributor (`Claimed(account, amount)` on Ethereum) |
| SAFE claimable | published − claimed, when the latest published root is the distributor's current root. Otherwise *not available* |

- **Only published amounts.** Nothing is calculated. The reward methodology for Sentinels is a proposal pending SafeDAO approval (`safe-fndn/safenet-staking-scripts`), so unpublished allocations are never estimated.
- **All reward types in this table.** The earnings table shows the address's whole published amount, the column says *all reward types*. Aegis proofs also carry `sentinelAmount`, the cumulative Sentinel grant within it; the sync copies it (`sentinel_amount`), and the [realized APR](#realized-apr) uses only that part. Beta proofs have none.
- **Current state.** The first Aegis root (rewards until 2026-10-27) grants 15,384.62 SAFE to each of two Sentinel addresses, all of it `sentinelAmount` and all of it withheld until KYC. `cumulativeClaimed` is 0 for every Sentinel. A Sentinel without an entry shows *No allocation published* rather than 0.

## Bonds

There is no bond account in the Sentinel Oracle (`SentinelOracle.sol` `commit`, `claim`):
- **Posting.** Each commit transfers the request's `bondTarget` (800 USDC.e so far) from the Sentinel into the oracle (`Committed.bondAmount`).
- **Return.** After the request is decided, the Sentinel's claim returns `bondReturn = bond − slash` (`Claimed`).

| Column | Meaning | Source |
| --- | --- | --- |
| Available now | USDC.e in the Sentinel's own account on Gnosis Chain, which it can bond next | Sentinel USDC.e transfers since the oracle's deployment. The verification checks them against `balanceOf`, which also shows that no Sentinel held USDC.e before. |
| Locked now | bonds of unclaimed commitments still held by the oracle: bond minus any slash already taken | `Committed`, `Claimed` |
| Posted, returned | all-time bonds in and `Claimed.bondReturn` | `Committed`, `Claimed` |
| Slashed (claimed) | bond − `bondReturn` of claimed commitments: the slash as recorded by the claim | `Claimed` |
| Slashed (not yet claimed) | slash already taken from an unclaimed commitment, per the contract rule | below |
| Check | claims whose `bondReturn` differs from the rule (expected 0) | |

**Slashing** (`SentinelOracleRequests.sol`, `slashAmountFor`) applies the request's `slashAmount` (0.40 USDC.e so far) to:
- a committed vote that was **never revealed**, if any other Sentinel revealed on the request. It is taken at `finalize` and transferred to the protocol funds receiver.
- a **revealed vote on the losing side of a ruled dispute** (`DisputeResolved`). The slashed total is in the event, and it pays the sponsor's refund.

There is no slash after a total timeout (nobody revealed), an out-of-scope dispute or an arbitration timeout, and none for winners or lone revealers. A disputed vote or a lost ruling alone is never taken as a slash: the panel shows slashes confirmed by the Sentinel's claim. Before the claim, it shows the slash the contract has already taken. The verification checks every claim against the rule, and every `DisputeResolved.slashed` against the sum of its losers' slashes.

## Realized APR

What a Sentinel earned in each **completed** two-week reward period, relative to the USDC.e it kept bonded (`sentinel_apr`). It is historical: there is no projected or current rate, and none is implied.

```
APR (%) = (net fees + SAFE grant × SAFE/USD) / time-weighted capital × 365 / 14 × 100
```

| Term | Definition |
| --- | --- |
| **Period** | The fixed two-week Aegis reward periods [start, end), Tuesday 00:00 UTC, from 2026-10-13, as in the [staking APR](staking.md#realized-apr). Listed once the latest decoded Safenet event in Dune is past the end. The cutoff comes from the one `meta` row that `safenet_sentinel_wallet_transfers` always returns, with the block its transfers are capped at, so it doesn't depend on Sentinel activity. Every input has reached that block, so a period is never shown while its data is still arriving. |
| **Net fees** | Fee rewards accrued on requests decided in the period (`outcome_at`, as in the per-day chart), minus slashes taken in the period. A missing response is slashed at finalize: the freeze (`disputed_at`) or the outcome. A lost dispute is slashed at the ruling. |
| **SAFE grant** | The change of the address's published `sentinelAmount` from the last root before the period to the period's last root (`rewards_until` = period end). It includes amounts withheld until KYC, because they are granted, and excludes any staking reward of the same address. Null while the period is not published, never 0. |
| **SAFE/USD** | Dune's `prices.day` price of SAFE on Ethereum (`0x5afe…eeee`) for the period's last day. This is the only USD price in the section. USDC.e is taken as 1 USD. |
| **Locked capital** | Average USDC.e the oracle holds for the Sentinel: each commit's bond from the commit to the Sentinel's claim, less its slash from the time it was taken. Unclaimed bonds stay locked. |
| **Available capital** | Average USDC.e in the Sentinel's own account on Gnosis Chain (`safenet_sentinel_wallet_transfers`), which it bonds next. Fees and returned bonds land here when claimed. |
| **Time weighting** | Exact seconds each balance was held, carried into the period from before its start, not daily snapshots. |

Six rates per (period, Sentinel): fee, SAFE and total return, each over **locked** capital and over **locked + available** capital. The charts show the total rate over each denominator, one bar per Sentinel and period. Locked only shows the return on the bonds actually at stake. Locked + available also counts the working capital a Sentinel keeps ready to bond, so it is the lower and more conservative rate.

- **Non-compounded.** One period's return is scaled linearly to 365 days.
- **Null, not 0.** Without capital in the period there is no rate. The SAFE and total rates are null while the grant is unpublished or the price is missing; the table says which in *SAFE grant status*.
- **Small samples.** Fees are cents per request and grants are lump sums per period, so one period's rate can swing widely and is not a forecast.
- **Rows.** A Sentinel appears in a period if it held capital, earned or was slashed, or received a grant. A grant without capital shows with null rates.

## Units, freshness and empty states

- **Units.** USDC.e for fees and bonds (6 decimals) and SAFE for subsidies (18 decimals), always in the column title. No USD values or projected yields, except the [realized APR](#realized-apr), which values the SAFE grant at Dune's SAFE/USD price and USDC.e at 1 USD.
- **Freshness.** *Sentinels data as of* is the latest Gnosis Chain block time in Dune when the query ran. The section is as fresh as the daily refresh (05:17 UTC) plus Dune's ingestion delay, and the current UTC day is partial.
- **Empty states.**
  - Days without eligible requests are blank in the per-day pivot table.
  - A window without eligible requests has no rate, not 0%.
  - The disputes table is empty when there was no dispute.
  - The SAFE columns say *No allocation published* or *not available* instead of 0.

## Sources

- Contracts: `safe-research/safenet` at `4ed5101`:
  - `contracts/src/SentinelOracle.sol`;
  - `contracts/src/libraries/SentinelOracleRequests.sol`, `SentinelOracleCommitments.sol`, `SentinelMap.sol`, `BondConfig.sol`;
  - `docs/configuration.md` "Aegis Network" for addresses, windows, bond and slash multipliers, governance delay and arbitrator;
  - `docs/transaction-lifecycle.md`, `docs/sentinel-engine.md`.
- Event signatures, topic0 values and call selectors: [`src/safenet.ts`](../../src/safenet.ts), recomputed in `test/safenet.test.ts`.
- The arbitration flow: the Safenet Arbitration Charter, and `safe-research/safenet-arbitration-bot`.
- Rewards distributor: Etherscan and Sourcify (*CumulativeMerkleDrop*, verified). Its address is also in the Sentinel engine's staking checker (`crates/sentinel-engine/src/checkers/staking.rs`).
- Published rewards: `safe-fndn/safenet-data` `assets/rewards` (Beta) and the ENS `rewards.safenet-gov.eth` contenthash on IPFS (Aegis), and the format in `safe-fndn/safenet-staking-scripts`.

## Verification

[`scripts/verify-sentinels.ts`](../../scripts/verify-sentinels.ts) (`npm run verify:sentinels`) recounts the section from Gnosis Chain RPC logs with the same rules in TypeScript ([`scripts/lib/sentinels.ts`](../../scripts/lib/sentinels.ts), unit-tested in `test/sentinels.test.ts`).
- **Comparison with Dune.** With `DUNE_API_KEY`, it compares every Dune result at that result's `through_block`, judging open windows at Dune's `as_of_block`:
  - the overview, windows, per-day pivot, verdicts, coverage, disputes, earnings and bonds;
  - the realized APR: per period and Sentinel, fees, slashes, locked and available time-weighted capital, recounted from logs by a different method from the SQL (Σ change × remaining seconds). The SAFE grant comes from the synced proofs, and the fee and total rates use the SAFE price as Dune read it. The rows must be exactly the expected (period, Sentinel) pairs, built the same way as the SQL's (grant recipients included). The completed periods come from the RPC time of the result's `through_block`, which `through_t` must equal, or, for an empty completed result, from every period that ended a day before the execution finished, so a missing period or an empty table fails. The local report lists the same recounted rows at the finalized head;
  - the arbitration rates, per-day rates, resolution times and open arbitrations, judged at each query's own `computed_at`, and every dispute's proposal, freeze and outcome timestamps and durations;
  - the arbitration panels with each other and with the dispute table: all-time arbitrations and states = dispute table rows on Charter chains, all time = sum of the days, ruled = resolution sample, awaiting = open arbitrations;
  - the panels with each other over the same population (overview = verdict breakdown, overview = windows);
  - the per-Sentinel fee rewards with the Network & revenue fee allocation.
- **Independent checks:**
  - every claim matches the slash rule;
  - every ruled dispute's slashed total equals its losers' slashes;
  - no Sentinel committed while not a member;
  - Sentinel USDC.e transfers since deployment equal `balanceOf`;
  - the distributor's current root is the latest published root, and `cumulativeClaimed` per Sentinel is read on Ethereum;
  - every dispute has one `DisputeTriggered`, ends only with `DisputeResolved`, `DisputeOutOfScope` or `ArbitrationTimedOut`, never before its freeze, and its deadline is after its freeze block.
- **Traces.** `--traces` also recounts reverted calls with `trace_filter`. This takes about 15 minutes on the public RPC, which allows 100 blocks per call. Without it, *no commit* and *commit reverted* are compared as a sum.
- **Where it runs:** after every preview deploy, with the result and representative cases in the pull request comment, and after every production refresh.
- **Representative cases.** It lists a recent example of each case with Safenet explorer and Gnosisscan links, for a manual check on [safenet-explorer.eth.limo](https://safenet-explorer.eth.limo/). The cases are secure, insecure, no commit, commit reverted, missing response, pending, and each dispute ending. For arbitration, it lists one case per state (ruled secure, ruled insecure, awaiting, out of scope, timed out) with its proposal, freeze and outcome times and transactions, deadline block and durations. It also counts repeated proposals of one Safe transaction.

Result up to Gnosis block 48951573 (2026-10-26), in [`verification/sentinels.json`](../../verification/sentinels.json):

| Sentinel | Status | Eligible | Valid reveals | Rate | Secure | Insecure | Commit reverted | No commit | Fees accrued (USDC.e) | Locked (USDC.e) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BlockSec | active | 265 | 258 | 97.4% | 205 | 53 | 2 | 5 | 65.47 | 800 |
| Candide | active | 265 | 159 | 60.0% | 107 | 52 | 0 | 106 | 30.40 | 3 200 |
| OpenCover | active | 265 | 33 | 12.5% | 33 | 0 | 0 | 232 | 4.73 | 800 |
| IntentGuard | active | 265 | 16 | 6.0% | 11 | 5 | 142 | 107 | 2.60 | 800 |
| `0x3bf9…40a5` | active | 265 | 0 | 0% | 0 | 0 | 0 | 265 | 0 | 0 |
| `0x0637…a3ca` | removed before activation | 0 | | | | | | | 0 | 0 |

The table counts covered-chain requests only, so the 266 requests include one Polygon test request that is not counted here.
- **Missing responses.** There have been none: every commit was revealed.
- **Membership boundaries.** Every Sentinel became active (blocks 48721451 and 48722485) before the first request (block 48752182). No request so far falls on a membership boundary; `test/sentinels.test.ts` covers the boundary rules.
- **Coverage** of decided covered requests: 7 with no valid response (the launch-day timeouts), 80 with one, 148 with two, 30 with three.
- **Slashes.** All slashes recorded so far come from lost disputes: BlockSec 2.00, IntentGuard 0.80 and Candide 0.40 USDC.e. Every claim matches the rule.
- **Cross-check with safenet-data.** The rates agree with `participation_rate_14d` in `sentinel-info.json`, which counts reveals over all requests of the last 14 days: BlockSec 0.974 and IntentGuard 0.060. Candide (0.596) and OpenCover (0.121) differ slightly because of the 14-day window.

## Limitations

- **Abstain and offline cannot be told apart.** Neither leaves a trace on chain, so both are *No commit (abstain or offline)*.
- **Reverted calls depend on traces.** Dune's `gnosis.traces` provides them. Reasons are decoded only for `Error(string)` reverts; custom errors such as `CommitWindowClosed` show without a reason, and are classified by timing.
- **SAFE subsidies.** The earnings table shows every reward type of the address together. The realized APR uses the published `sentinelAmount`, which exists only in Aegis proofs. The methodology is not published, so unpublished grants are never estimated.
- **Realized APR** values SAFE at a daily price from Dune's price feeds, and treats USDC.e as 1 USD. Capital in other accounts of the same operator is not counted.
- **Available bond token** is the Sentinel's USDC.e balance on Gnosis Chain. It is reconstructed from transfers since 2026-10-07 and checked against `balanceOf`. A Sentinel that later bonds from a different account would not be covered.
- **Names** are labels from safenet-data. Two scheduled addresses have none and show the address.
