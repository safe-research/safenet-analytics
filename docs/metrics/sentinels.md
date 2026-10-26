# Sentinels

The *Sentinels* section of [dune.com/safe/safenet](https://dune.com/safe/safenet) covers participation, verdicts, coverage, arbitration, earnings and bonds of the Safenet **production** ("Aegis") Sentinels. Beta is never read. It builds on the shared models of the [Network & revenue](network-and-revenue.md) section:
- requests and their lifecycle come from [`safenet_requests`](../../dune/queries/safenet_requests);
- events come from [`safenet_events`](../../dune/queries/safenet_events);
- known operational and test Safes come from [`safenet_known_traffic`](../../dune/queries/safenet_known_traffic).

Request identifiers, lifecycle, deduplication and time boundaries are therefore the same in both sections.

| Model | One row per | Used for |
| --- | --- | --- |
| [`safenet_sentinel_terms`](../../dune/queries/safenet_sentinel_terms) | Sentinel membership term | current status, eligibility |
| [`safenet_sentinel_responses`](../../dune/queries/safenet_sentinel_responses) | (request, Sentinel) where the Sentinel was eligible or committed | every Sentinel panel |
| [`safenet_sentinel_failed_calls`](../../dune/queries/safenet_sentinel_failed_calls) | reverted `commit` / `reveal` call (traces) | reverted commits, reverted calls |
| [`safenet_sentinel_wallet_transfers`](../../dune/queries/safenet_sentinel_wallet_transfers) | USDC.e transfer of a Sentinel account | available bond token |
| [`safenet_reward_events`](../../dune/queries/safenet_reward_events) | event of the SAFE rewards distributor on Ethereum | SAFE claimed |
| [`safenet_sentinel_rewards`](../../dune/queries/safenet_sentinel_rewards) | published Merkle root, and Sentinel entry under it | SAFE published |

## Panels

| Panel | Query | Time basis |
| --- | --- | --- |
| Sentinels data as of | `sentinel_overview` | Latest Gnosis Chain block Dune has ingested, and computation time |
| Sentinel overview | `sentinel_overview` | Status: **now**. Counts: all time |
| Participation by time window | `sentinel_windows` | Requests proposed in the last 24 hours, 7 days, 30 days, all time |
| Participation per day (heatmap) | `sentinel_participation_daily` | Last 30 UTC days, by proposal day |
| Sentinel responses by kind (bars and table) | `sentinel_verdicts` | Bars: requests proposed in the last 30 days. Table: also all time |
| Requests by number of valid responses (bars and table) | `sentinel_coverage` | Bars: last 30 days. Table: also all time, by proposal time |
| Disputes and arbitration | `sentinel_disputes` | All disputes, newest first |
| Sentinel earnings | `sentinel_earnings` | All time and last 30 days (fees); latest published root (SAFE) |
| Fee rewards per day by Sentinel | `sentinel_earnings_daily` | Last 30 UTC days, by decision day |
| Sentinel bonds | `sentinel_bonds` | Available and locked: **now**. Movements: all time |

"All time" means production since the first production request (2026-10-14).

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
| **Participation rate** (overview, windows, heatmap) | valid reveals on eligible requests | eligible requests with a closed response window, Charter chains |
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
- **Publication.** Allocations are published as Merkle proofs in [`safe-fndn/safenet-data` `assets/rewards`](https://github.com/safe-fndn/safenet-data/tree/main/assets/rewards). Each version of `latest.json` is one root (`merkleRoot`, `rewardsUntil`), and one proof file per address carries its **cumulative** amount.
- **Sync.** `npm run sync:sentinel-rewards` copies every published root, and every proof of a Sentinel address under it, into [`dune/data/sentinel-rewards.json`](../../dune/data/sentinel-rewards.json) and the `safenet_sentinel_rewards` query, at a pinned commit.

| Column | Meaning |
| --- | --- |
| SAFE published | the cumulative SAFE published for the address under the latest published root, or *No allocation published* |
| SAFE claimed | SAFE claimed by the address from the distributor (`Claimed(account, amount)` on Ethereum) |
| SAFE claimable | published − claimed, when the latest published root is the distributor's current root. Otherwise *not available* |

- **Only published amounts.** Nothing is calculated. The reward methodology for Sentinels is a proposal pending SafeDAO approval (`safe-fndn/safenet-staking-scripts`), so unpublished allocations are never estimated.
- **No Sentinel split.** The published files have one amount per address for every reward type. A Sentinel address that also stakes cannot be split into subsidy and staking reward, and the column says *all reward types*.
- **Current state.** No allocation has been published for any production Sentinel address. Production started after the latest published period: 18 roots, the latest covering rewards until 2026-10-06. The distributor's `merkleRoot()` equals that root, and `cumulativeClaimed` is 0 for every Sentinel. The panel says *No allocation published* rather than 0.

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

## Units, freshness and empty states

- **Units.** USDC.e for fees and bonds (6 decimals) and SAFE for subsidies (18 decimals), always in the column title. No USD values, APY or profitability.
- **Freshness.** *Sentinels data as of* is the latest Gnosis Chain block time in Dune when the query ran. The section is as fresh as the daily refresh (05:17 UTC) plus Dune's ingestion delay, and the current UTC day is partial.
- **Empty states.**
  - Days without eligible requests are blank in the heatmap.
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
- Published rewards: `safe-fndn/safenet-data` `assets/rewards`, and the format in `safe-fndn/safenet-staking-scripts`.

## Verification

[`scripts/verify-sentinels.ts`](../../scripts/verify-sentinels.ts) (`npm run verify:sentinels`) recounts the section from Gnosis Chain RPC logs with the same rules in TypeScript ([`scripts/lib/sentinels.ts`](../../scripts/lib/sentinels.ts), unit-tested in `test/sentinels.test.ts`).
- **Comparison with Dune.** With `DUNE_API_KEY`, it compares every Dune result at that result's `through_block`, judging open windows at Dune's `as_of_block`:
  - the overview, windows, heatmap, verdicts, coverage, disputes, earnings and bonds;
  - the panels with each other over the same population (overview = verdict breakdown, overview = windows);
  - the per-Sentinel fee rewards with the Network & revenue fee allocation.
- **Independent checks:**
  - every claim matches the slash rule;
  - every ruled dispute's slashed total equals its losers' slashes;
  - no Sentinel committed while not a member;
  - Sentinel USDC.e transfers since deployment equal `balanceOf`;
  - the distributor's current root is the latest published root, and `cumulativeClaimed` per Sentinel is read on Ethereum.
- **Traces.** `--traces` also recounts reverted calls with `trace_filter`. This takes about 15 minutes on the public RPC, which allows 100 blocks per call. Without it, *no commit* and *commit reverted* are compared as a sum.
- **Where it runs:** after every preview deploy, with the result and representative cases in the pull request comment, and after every production refresh.
- **Representative cases.** It lists a recent example of each case with Safenet explorer and Gnosisscan links, for a manual check on [safenet-explorer.eth.limo](https://safenet-explorer.eth.limo/). The cases are secure, insecure, no commit, commit reverted, missing response, pending, and each dispute ending.

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
- **SAFE subsidies.** No production Sentinel allocation is published yet. A Sentinel that also stakes cannot be split, because the published data has one amount per address. The methodology is not published, so nothing is estimated.
- **Available bond token** is the Sentinel's USDC.e balance on Gnosis Chain. It is reconstructed from transfers since 2026-10-07 and checked against `balanceOf`. A Sentinel that later bonds from a different account would not be covered.
- **Names** are labels from safenet-data. Two scheduled addresses have none and show the address.
