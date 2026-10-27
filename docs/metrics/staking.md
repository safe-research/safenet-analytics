# Staking

The **Staking** section of [dune.com/safe/safenet](https://dune.com/safe/safenet) covers SAFE staked toward Safenet validators: active stake, deposits, withdrawal requests, outstanding withdrawals and completed withdrawals, and stake by validator with self-stake and delegated stake. The shared models below are also the basis for the Validators section.

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

The dashboard has no parameter widgets ([deployment.md](../deployment.md#what-is-managed)), so the charts show all time. The flow table gives the 24 h, 7 d and 30 d summaries. The counters, the outstanding withdrawals and stake by validator are always current state, whatever range a chart shows; their titles say *now*.

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

One row per validator: the latest `ValidatorStakerSet` on the production Consensus (`0xc855…aa96`, Gnosis Chain), decoded from `gnosis.logs` because Consensus is not decoded on Dune. Fields: `validator`, `staker`, `set_at`, `set_block`, `set_tx`, `set_tx_url`.

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

## Limitations

- **Status is as of the refresh.** *Waiting* turns into *claimable* as time passes, and Dune results update daily, so a withdrawal can be claimable before the dashboard says so.
- **No live membership.** Registration in the Staking contract and labels say nothing about the live validator set.
- **Self-stake depends on the registered staker.** A validator that has not called `setValidatorStaker` gets no self-stake split; its stake shows as *No registered staker*.
- **Fixed windows only.** No dashboard-wide date range, because the dashboard has no parameter widgets. The history charts are all time.
- **Decoding lag.** If Dune's decoded tables lag behind `ethereum.blocks`, an event in that gap is missing from a result that reports a later `through_block`. The verification would show it as a mismatch.
- **No USD values and no APY.**
