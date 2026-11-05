# Staking

The **Staking** section of [dune.com/safe/safenet](https://dune.com/safe/safenet) covers SAFE staked toward Safenet validators: active stake, deposits, withdrawal requests, outstanding withdrawals and completed withdrawals, stake by validator with self-stake and delegated stake, and the [realized APR](#realized-apr) of completed reward periods. The shared models below are also the basis for the Validators section.

## Panels

| Panel | Query / visualization | Scope |
| --- | --- | --- |
| Data as of | `staking_overview/freshness` | Ethereum block and time of the data |
| Active stake now, stakers now, outstanding withdrawals now, of which claimable | `staking_overview/*` counters | current state |
| Flows over 24 hours, 7 days, 30 days and all time | `staking_flow_summary/table` | rolling windows up to the refresh |
| Active stake history | `staking_daily/active_stake` (area) | all time, Beta grey, production blue |
| Net capital flow | `staking_daily/net_flow` (line, with active stake for comparison) | all time |
| Deposits and completed withdrawals | `staking_daily/flows` (columns; withdrawals below zero) | all time |
| Withdrawal requests | `staking_daily/requests` (columns) | all time, Beta grey, production orange |
| Outstanding withdrawals | `staking_withdrawals_outstanding/table` | current state, earliest withdrawal first |
| Stake by validator | `staking_by_validator/bars` (horizontal stacked) and `/table` | current state |
| Realized APR, latest published period | `staking_rewards_apr/headline` (counter) | latest completed and published reward period |
| Realized APR by reward period | `staking_rewards_apr/history` (columns) and `/table` | completed Aegis reward periods |
| Realized APR by validator | `staking_rewards_apr_by_validator/bars` (columns by validator) and `/table`, the table also on the Validators dashboard | completed Aegis reward periods |

The dashboard has no parameter widgets ([deployment.md](../deployment.md#what-is-managed)), so the charts show all time. The flow table gives the 24 h, 7 d and 30 d summaries. The counters, the outstanding withdrawals and stake by validator are always current state, whatever range a chart shows; their titles say *now*. The realized APR panels are history of completed periods only, in their own block, and are never mixed with current stake or with an estimate of future returns.

## The contract

The Staking contract is `0x115E78f160e1E3eF163B05C84562Fa16fA338509` on Ethereum ([Etherscan](https://etherscan.io/address/0x115E78f160e1E3eF163B05C84562Fa16fA338509)). Its source is `contracts/src/Staking.sol` in `safe-research/safenet` at commit `4ed5101`.

- **Deployment.** Block 24585750, 2026-03-04 18:00 UTC. The contract is not a proxy; the EIP-1967 implementation slot is empty. The deploy block was found by binary search on the contract code over RPC.
- **Token.** SAFE `0x5aFE3855358E112B5647B952709E6165e1c1eEEe`, read from `SAFE_TOKEN()`.
- **Delays.** `withdrawDelay` is 172800 s (2 days) and has not changed since deployment: one `WithdrawDelayChanged`, from the constructor. `CONFIG_TIME_DELAY` is 604800 s.
- **One contract for Beta and production.** There is no separate Beta staking contract. The history is continuous, and the [production start](#eras) marks where production begins.

### Lifecycle

| Step | Function | Event | Effect |
| --- | --- | --- | --- |
| Deposit | `stake(validator, amount)` | `StakeIncreased(staker, validator, amount)` | SAFE moves into the contract. `stakes[staker][validator]`, `totalValidatorStakes`, `totalStakerStakes` and `totalStakedAmount` increase. Only allowed for validators registered in the contract. |
| Withdrawal request | `initiateWithdrawal(validator, amount)` or `initiateWithdrawalAtPosition(…)` | `WithdrawalInitiated(staker, validator, withdrawalId, amount)` | **The stake leaves active stake at once.** The stake counters decrease and `totalPendingWithdrawals` increases by the amount. A queue entry is created with `claimableAt = block.timestamp + withdrawDelay`. No tokens move. Partial amounts are allowed. |
| Claim | `claimWithdrawal()` | `WithdrawalClaimed(staker, withdrawalId, amount)` | Pays the **head** of the staker's queue (the earliest `claimableAt`) if that time has passed. One withdrawal per call. `totalPendingWithdrawals` decreases and SAFE moves to the staker. |
| Validator change | `proposeValidators` → `executeValidatorChanges` (owner, 7-day timelock) | `ValidatorsProposed`, `ValidatorUpdated(validator, isRegistered)` | Registers or deregisters a validator. Existing stake is untouched and stays withdrawable. |
| Delay change | `proposeWithdrawDelay` → `executeWithdrawDelayChange` | `WithdrawDelayProposed`, `WithdrawDelayChanged(oldDelay, newDelay)` | Applies to **later** requests only. Existing `claimableAt` values never move. |
| Token recovery | `recoverTokens` (owner) | `TokensRecovered(token, to, amount)` | For SAFE, only `balance − totalStakedAmount − totalPendingWithdrawals`. Never stake. |

The contract has no cancellation of a request, no restaking from a pending withdrawal, no moving stake between validators, and no slashing. So there are no internal movements. Every `StakeIncreased` is an external deposit, and every `WithdrawalClaimed` is an external outflow. A staker who wants to change validator requests a withdrawal and deposits again; this shows as a withdrawal and a new deposit. Withdrawal IDs are global (`nextWithdrawalId`), so a claim is matched to its request by `(staker, withdrawalId)`.

## Definitions

### Active stake

Active stake is the sum of deposits minus the sum of withdrawal requests, per (staker, validator). It equals the contract's `stakes(staker, validator)`, and the total equals `totalStakedAmount`. It is computed from events. The contract's SAFE balance is never used for it, because the balance also holds outstanding withdrawals: balance = active stake + outstanding withdrawals.

### Stakers

Stakers are distinct addresses with positive active stake, summed over all validators. An address that stakes toward several validators counts once.

### Withdrawals

Each withdrawal ID is in exactly one state:

| State | Rule |
| --- | --- |
| **waiting** | requested, `claimable_at` in the future |
| **claimable** | `claimable_at` reached, not claimed yet |
| **completed** | `WithdrawalClaimed` for the same staker and withdrawal ID |

`claimable_at` is the request's block time plus the withdraw delay in force at that event, as in the contract. **Outstanding** = waiting + claimable. It is rebuilt per withdrawal ID, not as a sum of historical requests, and equals `totalPendingWithdrawals`. The status is evaluated when the query runs. A staker with several claimable withdrawals claims them one by one, earliest first.

### Flows

| Term | Definition |
| --- | --- |
| **Deposits** | SAFE in, by `StakeIncreased` |
| **Withdrawal requests** | SAFE moved from active stake to outstanding. No tokens move. |
| **Completed withdrawals** | SAFE out, by `WithdrawalClaimed` |
| **Net capital flow** | deposits − completed withdrawals, cumulative over the chart period (all time). It differs from active stake by exactly the outstanding withdrawals. |
| **Active stake change** | deposits − withdrawal requests over a window, in the flow table |

### Self-stake and delegated stake

Each validator registers a **staker** on the production Consensus on Gnosis Chain with `Consensus.setValidatorStaker`, which emits `ValidatorStakerSet(validator, staker)`. This is the Ethereum account that puts up the validator's own stake (safenet `docs/configuration.md`, section *Staking*).

- **Self-stake** is that account's active stake on its own validator.
- **Delegated stake** is everyone else's stake on that validator.

Self-stake is never inferred from names or labels. If a validator has no registered staker, the split is unknown: the bar shows *No registered staker (split unknown)*, and the table leaves self-stake and delegated stake blank rather than 0. The relationship is the latest `ValidatorStakerSet` per validator, checked against `Consensus.getValidatorStaker` in the verification.

### Validators and deregistered stake

`staking_status` comes from `ValidatorUpdated` in the Staking contract: *registered* (latest update registers it), *deregistered* (registered before, not now) or *never registered*. Stake on a deregistered validator stays in the contract until its stakers withdraw it. It is counted in active stake, because the contract counts it in `totalStakedAmount`. Stake by validator shows it in its own grey series, *On deregistered validator*, and the overview reports it as `deregistered_stake`. It is never shown as backing a registered validator, and never dropped.

Registration in the Staking contract is not the same as membership of the live consensus validator set. That is the Validators section's subject, and nothing here claims it. Names in [safe-fndn/safenet-data](https://github.com/safe-fndn/safenet-data/blob/main/assets/validator-info.json) are labels only. A listed validator is not necessarily registered or active, and an unknown validator shows its address.

At block 26278309 (2026-10-26), the Staking contract had registered six validators, all on 2026-03-26:

- five are registered and hold stake: Gnosis, Core Contributors, Safe Labs, Greenfield and RockawayX;
- Blockchain Capital (`0xd899…305b`) was deregistered on 2026-10-23 with 2,815,177.96 SAFE still staked in 19 positions;
- the same 2026-10-23 transaction also deregistered `0xfb2a…0b2c`, RockawayX's registered staker, which had never been registered as a validator. It holds no stake as a validator and is listed as *never registered*.

### Eras

The **production start** is the deployment of the production Consensus on Gnosis Chain: block 48635843, 2026-10-07 13:51:55 UTC (`PRODUCTION_START_TIME` in `src/safenet.ts`). Events before it are `beta`, events from it on are `production` (`era` in `staking_events`). The daily charts use UTC days, with 2026-10-07 as the first production day. The active stake area includes the boundary day in both series so the two areas meet. Dune charts cannot draw a vertical marker, so the boundary is shown by the change in colour, and the section text names it.

## Realized APR

What staking earned in each **completed** Aegis reward period, from the published rewards and the stake that earned them. It is historical. There is no projected or current APR on the dashboard, and none is implied: future rates depend on future stake, participation and rewards.

### Formula

```
APR (%) = stake rewards / time-weighted eligible stake × 365 days / period length × 100
```

- **Realized and non-compounded.** One period's rewards are scaled linearly to a year. Rewards are not assumed to be restaked.
- **Annualization: 365 days.** A period is 14 days (1,209,600 s), so the factor is 365 / 14 = 26.07. The rewards programme budgets 5M SAFE over 52 weeks, which is 26 periods of 364 days in total. Using 52 weeks instead would give a 0.27% lower rate (relative). The dashboard uses 365 days throughout and says so (`basis` column).

| Term | Definition |
| --- | --- |
| **Period** | Fixed two-week periods, Tuesday 00:00 UTC to Monday 23:59:59 UTC of the second week, from 2026-10-13 (`AEGIS_REWARDS_START` in safenet-staking-scripts `src/utils/sep.ts`). The first is 2026-10-13 to 2026-10-26 inclusive. They are known in advance: stake, participation and eligibility are computed for every period once it has ended, published or not. Published rewards attach to the period with the same start and end. The reward scripts publish exactly one such period per rewards DB, starting where the previous one ended (`src/distribution/export.ts`). The sync rejects a published root that is anything else. Beta periods have no APR. |
| **Stake rewards** | SAFE allocated in the period minus Sentinel grants. It is the change of the published `tokenTotal − sentinelTokenTotal` from the previous period's last root. It includes every validator's and delegator's staking reward and the commission, and KYC-withheld amounts, which are allocated but not yet claimable. The programme's `unpaidAmount` (rounding dust) is not allocated and not included. |
| **Sentinel grants** | `sentinelAmount` in the published proofs. They are a subsidy for Sentinels, not a return on stake, and are excluded from every APR. They are shown in the table as *excluded*, so the totals add up to the published amounts. A Sentinel address that also stakes counts only its staking reward. |
| **Time-weighted stake** | Σ balance × seconds held, ÷ period seconds, per (staker, validator), from every `StakeIncreased` and `WithdrawalInitiated` at its block time (`staking_period_stake`). The balance at the period start is carried in. A withdrawal request leaves at once, as in the contract. This is exact event-time weighting, not daily snapshots. |
| **Eligible stake** | Time-weighted stake on validators that met the 75% reward participation threshold, counted only while the validator was registered in the Staking contract. It is the stake the rewards were paid on. Stakers the reward scripts exclude (sanctioned) would be removed. There are none so far, and the verification checks it. |
| **Reward participation** | The reward scripts' rate (`src/data/attestations.ts`). It counts recognised signature shares on transaction ceremonies completed in the period (both ends included) whose `TransactionAttested` is no later than the **settlement block** (the last Gnosis block at or before the period end, + 48). The denominator is all such ceremonies, member or not (`staking_period_validators`). |

Three rates per period (`staking_rewards_apr`):

| Rate | Numerator | Denominator | Meaning |
| --- | --- | --- | --- |
| **APR, eligible stake** (headline) | stake rewards | eligible stake | average over the stake that was paid, before commission |
| **APR, delegators net** | delegators' rewards after commission | eligible delegated stake (eligible stake − self-stake) | what delegations earned; from a [verified split](#commission-split) only |
| **APR, all stake** | stake rewards | all time-weighted stake in the contract, ineligible validators included | what an average staked SAFE earned |

Per validator (`staking_rewards_apr_by_validator`):

| Rate | Definition |
| --- | --- |
| **Gross APR** | the validator's reward (own stake + delegations, before commission) / its average stake |
| **Delegator APR, net** | its delegators' rewards after commission / its average delegated stake. This is what a delegation to it earned. |
| **Self-stake APR** | its registered staker's own-stake reward / average self-stake. No commission is charged on self-stake, so this equals gross. |

Commission is a transfer from delegators to the validator's beneficiary, not a return on stake, so it is in no APR. A **validator staker's published allocation** combines its commission, its own-stake reward and any delegations it holds elsewhere, so it is never treated as a staking yield. Validator stakers get an APR only on their self-stake, from the verified split.

### How rewards are allocated (production)

From safe-fndn/safenet-staking-scripts at `8401845` (`src/safenet.ts` `rewards()`, `src/data/staking.ts`), reproduced exactly below:

1. **Budget**: 5M SAFE × period / 52 weeks, plus the catch-up of earlier unpaid amounts. Sentinels have their own budget, 400k SAFE per eligible Sentinel per year.
2. **Stake per validator**: time-weighted over the period while registered, divided by the full period length.
3. **Weight**: 0 below 75% participation. The share of an ineligible validator goes to the others; nothing is burnt. Above the threshold, weight = stake up to T = total stake ÷ number of validators, and √(T × stake) above it, × participation. A validator with much more than the average stake therefore earns less per SAFE. That is why Gnosis' rate is the lowest of the eligible validators.
4. **Validator reward** = budget × weight / Σ weights. It is split pro rata to time-weighted stake: self-stake (the registered staker's, time-sliced by `ValidatorStakerSet`) without commission, delegations minus **5% commission** if the validator's average self-stake is ≥ 3.5M SAFE.
5. **Commission** goes to the validator's beneficiary: its staker, or the DelegateRegistry delegate it set (id `keccak256("Safenet Beta validator commission beneficiary")`).
6. **KYC**: an account's payout of ≥ 7,500 SAFE is withheld whole (`kycAmount`) until the account is approved. It still counts in `tokenTotal`.

### Commission split

The published proofs give one amount per address, with no split into staking reward and commission. `npm run sync:validator-rewards` derives the split from public data, without running the reward scripts (`scripts/lib/derive-split.ts`):

1. **Inputs, all public:**
   - every address's published payout for the period;
   - time-weighted stake per staker and validator, and self-stake, from the Staking events and `ValidatorStakerSet` (as for the APR);
   - each validator's commission beneficiary: its staker at the period end, or the delegate that staker named in the DelegateRegistry (`SetDelegate` / `ClearDelegate`, id `keccak256("Safenet Beta validator commission beneficiary")`).
2. **One unknown per validator**, its reward R. Payouts follow from it with the scripts' rounding:
   - self-stake gets ⌊R·s/T⌋;
   - a delegation gets ⌊R·d/T⌋ minus 5% commission (⌊·×500/10000⌋), if the validator's average self-stake is ≥ 3.5M SAFE.
3. **Solving R.**
   - Each plain delegator (one position, not a staker or beneficiary) bounds R. A validator whose plain delegators all received nothing is ineligible: R = 0.
   - Within the bounds, R is chosen so that every payout is reproduced. This includes the validators' own stakers, multi-validator holders and beneficiaries.
4. **Recorded only if every published payout is reproduced** (tolerance 2 base units), and if payouts + `unpaidAmount` = the period's budget. Otherwise the period reads *split not verified*.
   - A change of the rules (commission rate, threshold, beneficiary rule) therefore gives no split, never a wrong one.
   - A period that was verified and no longer derives fails the sync instead of losing its split.
   - A re-issue that changes a period's payouts is derived again.

The payouts identify each validator's reward up to a few base units (10⁻¹⁸ SAFE): a staker on two validators lets one base unit move between them without changing any payout. Per address, the split is exact: commission is derived, and the staking reward is the rest of the published payout.

**Checked against the reward scripts.** For 2026-10-13 to 2026-10-27, the safe-fndn/safenet-staking-scripts `rewards()` split at `8401845` was run once and kept as a test fixture (`test/fixtures/split-2026-10-27-scripts.json`). The derived split equals it for all 846 recipients, field by field. Per validator, the rewards agree within 2 base units, the commissions exactly, and the ineligible validators are exactly 0. All 893 addresses with stake or a payout are reproduced with a difference of 0 base units.

Then `safenet_reward_breakdown` has per-validator rows for the period. The pool APR does not need a split.

### First production period: 2026-10-13 to 2026-10-27

Published on chain on 2026-11-04. ENS `rewards.safenet-gov.eth` → IPFS `bafybeibncjvxsa22w64cnpv43pr6zzhggnlkoe3hldpfxwjosex5oxz2em`, root `0xab63…711e`, set on the distributor in Ethereum block 26341873.

| | SAFE |
| --- | --- |
| Allocated in the period (Δ `tokenTotal`) | 223,076.923076923076922575 |
| Sentinel grants (2 Sentinels, both withheld until KYC; excluded) | 30,769.230769230769230768 |
| **Stake rewards** = 5M × 2 / 52 weeks − 500 wei unpaid | **192,307.692307692307691807** |
| of which commission (Gnosis, Core Contributors, Greenfield's beneficiary) | 5,574.524233338648039958 |
| of which withheld until KYC | 0 |
| Average eligible stake (Gnosis, Greenfield, Core Contributors, Safe Labs) | 56,394,566.79 |
| Average stake on ineligible validators (RockawayX, Blockchain Capital) | 11,682,754.51 |

| Rate | APR |
| --- | --- |
| **Eligible stake** | **8.89%** |
| Delegators, net of commission | 8.49% |
| All stake | 7.36% |

| Validator | Participation | Avg stake | Avg self-stake | Commission | Gross | Delegators net |
| --- | --- | --- | --- | --- | --- | --- |
| Safe Labs | 416/416 | 11,598,830 | 3,222,967 | none (self < 3.5M) | 9.86% | 9.86% |
| Core Contributors | 415/416 | 11,934,169 | 3,737,610 | 1,523.98 | 9.69% | 9.21% |
| Greenfield | 416/416 | 13,862,163 | 3,678,555 | 1,761.07 to `0xafb0…a56d` | 9.02% | 8.57% |
| Gnosis | 416/416 | 18,999,405 | 3,500,000 | 2,289.47 | 7.70% | 7.32% |
| RockawayX | 53/416 (12.7%) | 7,122,567 | 265,568 | ineligible | 0% | 0% |
| Blockchain Capital | 0/416 | 3,765,679 while registered (4,560,187 in all) | none | ineligible | 0% | 0% |

Safe Labs' staker was registered on 2026-10-14 08:47 UTC, so its time-sliced self-stake stayed below 3.5M and no commission was charged.

## Models

All amounts are SAFE, which has 18 decimals. `*_raw` columns hold exact base units as `decimal(38,0)`. The other amount columns are `double` in SAFE, for display. Addresses and hashes are `varbinary`. Each panel query reaches `staking_events` at most three times once references are inlined (`test/safenet.test.ts`), to stay well below Dune's limit on query stages.

### staking_events

One row per Staking contract event. It reads Dune's decoded tables `safe_ethereum.Staking_evt_*`, filtered to the contract address, from block 24585750, with `evt_block_date >= 2026-03-04` for partition pruning. It is the only query that reads those tables.

| Field | Meaning |
| --- | --- |
| `event` | `deposit`, `withdrawal_requested`, `withdrawal_claimed`, `validator_updated`, `delay_changed`, `tokens_recovered` |
| `block_time`, `block_number`, `tx_hash`, `log_index` | position of the event |
| `staker` | `deposit`, `withdrawal_requested`, `withdrawal_claimed` |
| `validator` | `deposit`, `withdrawal_requested`, `validator_updated` (claims carry none) |
| `withdrawal_id` | `withdrawal_requested`, `withdrawal_claimed` |
| `amount_raw`, `amount` | deposits, requests, claims, recovered tokens |
| `is_registered` | `validator_updated` |
| `new_delay` | `delay_changed`, in seconds |
| `era` | `beta` / `production` |
| `tx_url` | Etherscan link |

### staking_validator_stakers

One row per validator: the latest `ValidatorStakerSet` on the production Consensus (`0xc855…aa96`, Gnosis Chain), from Dune's decoded table `safe_gnosis.SafenetAegisConsensus_evt_ValidatorStakerSet` ([decoding.md](../decoding.md#switches)). Fields: `validator`, `staker`, `set_at`, `set_block`, `set_tx`, `set_tx_url`.

### staking_withdrawals

One row per withdrawal ID.

| Field | Meaning |
| --- | --- |
| `withdrawal_id`, `staker`, `validator` | identity of the withdrawal |
| `amount_raw`, `amount` | requested amount |
| `requested_at`, `requested_block`, `request_tx`, `request_tx_url` | the request |
| `era` | era of the request |
| `delay_seconds` | withdraw delay in force at the request |
| `claimable_at` | `requested_at + delay_seconds` |
| `claimed_at`, `claimed_block`, `claim_tx`, `claim_tx_url` | the claim, if any |
| `status` | `waiting`, `claimable` or `completed`, at query time |
| `consistent` | the claim matches its request in staker, ID and amount, and was not claimed before `claimable_at`. Expected true; `staking_overview.inconsistent_withdrawals` counts the exceptions. |

### staking_positions

One row per (staker, validator) with positive active stake now.

| Field | Meaning |
| --- | --- |
| `active_stake_raw`, `active_stake` | the stake |
| `deposited` | all-time deposits on this pair |
| `first_deposit_at`, `last_change_at` | first deposit and latest change |
| `validator_staker` | the validator's registered staker |
| `is_self_stake` | null if the validator has no registered staker |
| `staker_url` | Etherscan link |

### staking_validators

One row per validator ever registered in the Staking contract or holding stake. It is not a statement of live validator-set membership.

| Field | Meaning |
| --- | --- |
| `name` | label, or the address |
| `source_address` | address as published in safenet-data |
| `staking_status` | `registered`, `deregistered` or `never registered` |
| `status_since`, `first_registered_at` | dates of the latest and first registration events |
| `staker` | registered staker |
| `total_stake`, `total_stake_raw` | active stake on the validator |
| `self_stake` | null without a staker |
| `delegated_stake` | everyone else's stake |
| `stakers` | stakers with active stake on the validator |
| `validator_url`, `staker_url` | Etherscan links |

### staking_daily

One row per UTC day from 2026-03-04. It is also a dashboard query, scheduled daily.

| Field | Meaning |
| --- | --- |
| `deposits`, `withdrawals_requested`, `withdrawals_completed` | flows that day |
| `withdrawals_completed_negative` | completed withdrawals as a negative number, for the chart |
| `active_stake`, `outstanding_withdrawals`, `net_flow` | end-of-day levels |
| `active_stake_beta` / `_production`, `withdrawals_requested_beta` / `_production` | the series split by era |
| `deposit_count`, `request_count`, `claim_count` | event counts that day |
| `*_raw` | exact levels |
| `through_block`, `as_of_time` | head of Dune's `ethereum.blocks` at execution |

### staking_period_stake

One row per completed Aegis reward period and (staker, validator) with stake in it, from `staking_events` and production `validator_staker_history`. `refresh: none`.

| Field | Meaning |
| --- | --- |
| `period_start`, `period_end`, `period_seconds` | the period |
| `stake_seconds_all_raw`, `stake_seconds_raw`, `self_stake_seconds_raw` | balance × seconds in the period (base units × s): all, while the validator was registered, and the registered part held by its registered staker |
| `avg_stake_all`, `avg_stake`, `avg_self_stake` | the same ÷ period seconds, in SAFE |

### staking_period_validators

One row per completed period and validator with stake. Fields: `avg_stake`, `avg_stake_all`, `avg_self_stake`, `avg_delegated_stake`, `stakers`, `signed`, `transactions`, `participation`, `eligible`, `settlement_block`, `settlement_time`. `refresh: none`.

### safenet_reward_breakdown

Generated by `npm run sync:validator-rewards` from `dune/data/validator-rewards.json`. `refresh: none`.

- **`kind_row = 'period'`**: one row per published Aegis period, summed over the per-address payouts: `payout_raw`, `stake_rewards_raw`, `sentinel_raw`, `kyc_withheld_raw`, `kyc_withheld_stake_raw`, `payout_addresses`, and `commission_raw` with `scripts_commit` if verified.
- **`kind_row = 'validator'`**: one row per (period, validator) of a verified split: `avg_stake_raw`, `avg_self_stake_raw`, `signed`, `transactions`, `eligible`, `commission_charged`, `reward_raw`, `self_reward_raw`, `delegator_reward_raw`, `commission_raw`, `beneficiary`.

The per-address payouts (`payouts` in the JSON, about 850 rows per period) are kept in the repository as reconciliation evidence and are not uploaded to Dune.

## Freshness and empty states

- `staking_overview` and `staking_daily` report `through_block` and `as_of_time`, the newest Ethereum block Dune had when the query ran, and `computed_at`. The *Staking data as of* panel shows them.
- Results change only when the queries are refreshed: daily, after a deploy, or manually ([refreshes.md](../refreshes.md)). Waiting/claimable status is as of the refresh.
- The outstanding table shows one row, *No outstanding withdrawals*, when the queue is empty.
- Charts with no data in range show Dune's empty chart.
- Counters show 0, not blank, when nothing is outstanding or claimable.

## Sources

- Contract source and semantics: `safe-research/safenet` `contracts/src/Staking.sol`, `contracts/src/Consensus.sol` (`setValidatorStaker`, `getValidatorStaker`) and `docs/configuration.md` §Staking, at `4ed5101`.
- Decoded tables on Dune: `safe_ethereum.Staking_evt_StakeIncreased`, `_WithdrawalInitiated`, `_WithdrawalClaimed`, `_ValidatorUpdated`, `_WithdrawDelayChanged`, `_TokensRecovered`. The table names are confirmed by the Validate workflow's SQL check, and the coverage by the verification below.
- Constants and topic0 values are in `src/safenet.ts` (`STAKING`, `VALIDATOR_STAKER_SET`, `PRODUCTION_START_TIME`). `test/safenet.test.ts` recomputes every topic0 and checks that the SQL uses these constants.
- Names: `safe-fndn/safenet-data` `assets/validator-info.json`, via `safenet_participant_labels`.
- The separately maintained [safe/safenet-staking](https://dune.com/safe/safenet-staking) dashboard was reference material only. Nothing in it is read or changed.

## Validation

`npm run verify:staking` (`scripts/verify-staking.ts`) checks the section without Dune, then against Dune when `DUNE_API_KEY` is set. It runs in every preview and in the daily *Refresh*.

### Checks

1. **Replay vs contract state at the same block.** It pins the latest block B and fetches every Staking log from the deploy block to B. It replays them with the contract's rules (`scripts/lib/staking.ts`) and compares at B:
   - `totalStakedAmount`, `totalPendingWithdrawals`, the withdrawal count (`nextWithdrawalId − 1`) and `withdrawDelay`;
   - `totalValidatorStakes` and `isValidator` for every validator;
   - `stakes(staker, validator)` for every pair that ever staked, including pairs now at zero;
   - `getPendingWithdrawals(staker)` for every staker with outstanding withdrawals: each entry's amount and `claimableAt`, which checks the claimable-date rule;
   - the contract's SAFE `balanceOf` = staked + pending, as a sanity check only.
2. **Registered stakers.** It compares every validator's `ValidatorStakerSet` from logs with `Consensus.getValidatorStaker`.
3. **Dune vs replay**, with the replay truncated at the `through_block` Dune reports:
   - the counters, including waiting and claimable at the execution time;
   - every day of `staking_daily`: flows, levels and era;
   - the all-time flow row;
   - every outstanding withdrawal: ID, amount, earliest withdrawal, staker, validator and status, plus the sort order;
   - stake by validator: total, status and self-stake, with the rows summing to the headline active stake;
   - `inconsistent_withdrawals` = 0.

   The 24 h, 7 d and 30 d windows depend on the exact execution time and are not compared.
4. **Receipts.** It reads `eth_getTransactionReceipt` for representative transactions and checks the receipt holds the event with the same amount. The cases are the latest deposit, a waiting withdrawal, a claimable withdrawal, and a completed withdrawal (request and claim). It also reports the largest self-stake, with the registering Gnosis transaction and `stakes()` read at B, and the stake on deregistered validators.

### RPC

Most free public Ethereum endpoints refuse this check: they require an archive token, limit `eth_getLogs` to 50–100 blocks, or both. The default is Tenderly's public gateway, which serves archive state and long log ranges. Set `ETHEREUM_RPC_URL` to use another endpoint. Blockscout's log API was tried and is not used, because it misses a deposit in block 25294792.

### Result on 2026-10-26, without Dune (`verification/staking.json`)

At block 26278309, every contract check matched the replay exactly, in base units. Counts were 1399 deposits, 118 withdrawal requests, 97 claims, 8 validator updates and 1 delay change.

| Check | Contract | Replay |
| --- | --- | --- |
| `totalStakedAmount` | 69,555,583.211255109215240029 SAFE | same |
| `totalPendingWithdrawals` | 5,924,343.977566872354969673 SAFE | same |
| withdrawals | 118 | 118 |
| SAFE balance | 75,479,927.188821981570209702 | staked + pending |
| `stakes()` pairs | 1073 pairs | 0 mismatches |
| outstanding queue entries | 21 entries for 16 stakers, amount and `claimableAt` | 0 mismatches |
| registered stakers | 7 validators | match `getValidatorStaker` |

Stakers with active stake: 887. Outstanding withdrawals: 1,580,929.27 SAFE waiting and 4,343,414.71 SAFE claimable. The Dune comparison runs in the pull request's preview, and its result is in the preview comment.

### Realized APR (`verification/rewards_apr.json`)

`npm run verify:rewards-apr` (`scripts/verify-rewards-apr.ts`, `scripts/lib/rewards-apr.ts`) runs in every preview that executes the APR or reward queries, and in the daily *Refresh*. It is independent of Dune and of the reward scripts' run.

1. **Published source.**
   - The ENS contenthash history is replayed, every rewards DB is fetched as a CAR, and every block is verified against its CID.
   - Proofs add up to `tokenTotal`. The distributor's `merkleRoot()` is the latest root, and every period root appears in `MerkelRootUpdated`.
   - The per-address payouts recomputed from IPFS equal the recorded ones.
   - Budget identity: `tokenTotal − sentinelTokenTotal − Beta total + unpaid = 5M × elapsed / 52 weeks`.
2. **Stake.** The Staking events are replayed from Ethereum logs and time-weighted per second, with registration and registered-staker intervals. Per validator, stake and self-stake must equal the reward scripts'.
3. **Participation.** It is rebuilt from Consensus and FROSTCoordinator logs up to the settlement block, and must equal the scripts' signed / transactions and eligibility.
4. **Rewards.**
   - The allocation formula applied to the replayed stake and participation gives the recorded per-validator rewards.
   - Every address's payout is re-derived from them and its replayed stake.
   - Every staker with eligible stake is paid, and stakers only on ineligible validators are not.
5. **Dune.** With `DUNE_API_KEY`, `staking_rewards_apr`, `staking_rewards_apr_by_validator` and `validator_rewards_periods` are compared with the replay.
6. **Representative cases** with Etherscan links: a deposit and a withdrawal request during the period, a staker on an ineligible validator, the KYC-withheld Sentinel grants, the commission beneficiary, and an address that withdrew everything before the period.

Result on 2026-11-05, without Dune: all 30 checks passed at Ethereum block 26348270 and Gnosis block 49121614.

- The replay reproduces every validator's reward to **0 base units**.
- All **844 staking payouts** are re-derived with a maximum difference of **0 base units**.
- The split derived from the payouts reproduces all 893 addresses exactly and equals the reward scripts' own split (`8401845`, test fixture) for all 846 recipients.

The Dune comparison runs in the pull request's preview comment.

## Limitations

- **Status is as of the refresh.** *Waiting* turns into *claimable* as time passes, and Dune results update daily, so a withdrawal can be claimable before the dashboard says so.
- **No live membership.** Registration in the Staking contract and labels say nothing about the live validator set.
- **Self-stake depends on the registered staker.** A validator that has not called `setValidatorStaker` gets no self-stake split; its stake shows as *No registered staker*.
- **Fixed windows only.** No dashboard-wide date range, because the dashboard has no parameter widgets. The history charts are all time.
- **Decoding lag.** If Dune's decoded tables lag behind `ethereum.blocks`, an event in that gap is missing from a result that reports a later `through_block`. The verification would show it as a mismatch.
- **No USD values.**
- **APR is realized, not projected.** It covers completed and published periods only. A period that has ended but whose rewards are not published shows its stake and *not yet published*, with no APR.
- **Per-validator rewards and commission need a verified split.** The sync derives it ([Commission split](#commission-split)). If the published payouts cannot be reproduced, for example after a change of the reward rules, the period shows only the pool APR and the APR on all stake.
- **Reward rules are restated in code.** The derivation uses the 5% commission, the 3.5M SAFE self-stake threshold and the beneficiary rule of the reward scripts. The exact-match check makes a wrong rule visible as *split not verified*, not as wrong numbers.
- **Rewards are published on chain**, through the ENS contenthash of `rewards.safenet-gov.eth` and IPFS. [safenet-data](https://github.com/safe-fndn/safenet-data/tree/main/assets/rewards) was a mirror and is no longer updated after Beta. The sync needs an IPFS gateway that serves the content (`IPFS_GATEWAY_URL`; default Filebase, then Pinata). Every CAR is verified against its CID, so a gateway can withhold data but not alter it.
- **The reward methodology is a proposal pending SafeDAO approval.** The APR describes what was published and set on chain.
