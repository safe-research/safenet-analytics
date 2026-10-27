# Validators

The **Validators** section of [dune.com/safe/safenet](https://dune.com/safe/safenet) shows who attests for Safenet production. It covers:

- membership of the attestation set and Ethereum staking registration, which are separate;
- stake, with self-stake, delegated stake and stake shares;
- observed signing participation;
- published rewards;
- outstanding withdrawals per validator.

Stake and withdrawals reuse the [Staking](staking.md) models and definitions unchanged.

## Panels

| Panel | Query / visualization | Scope |
| --- | --- | --- |
| Data as of | `validator_overview/freshness` | Gnosis Chain block and time |
| Validator overview | `validator_overview/table` | now |
| Stake by validator status | `validator_stake_status/table` | now |
| Signing participation by window | `validator_participation_windows/table` | rolling 24 h, 7 d, 30 d, production |
| Participation history | `validator_participation_daily/heatmap` (pivot) | last 30 days |
| Stake distribution history | `validator_stake_daily/area` (stacked by validator), `validator_stake_split_daily/area` (self / delegated / unattributed) | all time, Beta then production |
| Reward history | `validator_rewards_periods/bars` and `/table` | published periods |
| Validator staker rewards | `validator_rewards_by_staker/table` | latest published root |
| Withdrawal exposure | `validator_withdrawal_exposure/bars` (horizontal, stacked) | now |

Panels titled *now* show current state. The others are history, and the two are never mixed in one panel.

Each validator has one colour in every chart and image (`src/validators.ts`, checked by `test/validators.test.ts`). Names come from [safenet-data](https://github.com/safe-fndn/safenet-data/blob/main/assets/validator-info.json) through `safenet_participant_labels`; unknown validators show their address. Validator addresses link to gnosisscan, staker addresses to Etherscan, and ceremony and share transactions to gnosisscan.

## How production attests

Sources are `safe-research/safenet` at `4ed5101`: `contracts/src/Consensus.sol`, `FROSTCoordinator.sol` and `interfaces/IConsensus.sol`.

- **Epochs and groups.** Each epoch has its own FROST signing group.
  - Epoch 0 uses the *genesis group* given to the Consensus constructor (`getEpochGroupId(0)` = `0x965f…0000`).
  - Every later epoch is staged by `EpochStaged(activeEpoch, proposedEpoch, rolloverBlock, groupId, …)`. It becomes active at its `rolloverBlock` (`_epochsWithRollover`); `EpochRolledOver` is lazy bookkeeping.
  - An epoch lasts until the next one's rollover block, which is a few hours.
  - At block 48971624 (2026-10-27) there were 155 epochs, and 34008 was active.
- **Members.** Members of a group are the participants that confirmed its key generation: `FROSTCoordinator.KeyGenConfirmed(gid, participant, …)`.
  - The coordinator (`0xc6b3…5b78`, deployed at Gnosis block 48617821) is shared with the Aegis testnet. Only groups named by production Consensus count; testnet and failed key generations never do.
  - The genesis group's key was generated on 2026-10-14, with context 0. Its `KeyGen` therefore does not name Consensus, which is why groups are taken from Consensus, not from the KeyGen context.
  - Nothing could be attested before 2026-10-14, consistent with the first production request that day.
- **Ceremonies.**
  - `Sign(initiator, gid, message, sid, sequence)` starts a ceremony, and `SignCompleted(sid, selectionRoot, signature)` completes it.
  - `SignShared(sid, selectionRoot, participant, z)` is one validator's share. The contract warns that a share is evidence of signing only under a selection root the consumer recognises.
  - Rule: **a validator signed a ceremony if and only if it has a `SignShared` with the selection root of that ceremony's `SignCompleted`.** This is also how safenet-data's `participation_rate_14d` and the Safenet explorer count.
  - An aggregate attestation (`TransactionAttested`) never counts for an individual validator.
- **Production ceremonies** are those whose `Sign` initiator is production Consensus.
  - Anyone can call `sign()` on any group. One ceremony on epoch 33994's group was started by the Core Contributors validator address itself; it is not an attestation and is excluded.
  - The purpose is *transaction* when the signature id appears in a `TransactionAttested`, as the reward scripts count it. It is *epoch_rollover* when the id appears in an `EpochStaged`.

## Definitions

### Attestation set and staking registration

They are separate attributes.

- **Attestation set**: membership of the active epoch's group, now. For history, it is the epoch's own group at the time, never today's set applied backwards.
- **Staking registration**: `staking_validators.staking_status` from the Staking section: registered, deregistered or never registered.

Being listed in safenet-data establishes neither.

At block 48971624:

| Validator | Attestation set | Staking registration |
| --- | --- | --- |
| Gnosis, Greenfield, Core Contributors, Safe Labs | member (epoch 34008) | registered |
| RockawayX | left: last member in epoch 33924, out from 33925 (block 48852000) | registered |
| Blockchain Capital | never a member | deregistered on 2026-10-23, 2.8M SAFE still staked |

### Stake backing the live set

Stake comes from the Staking section (`staking_validators`): active stake, and self-stake from the production registered staker.

- **Total contract stake** is the Staking headline.
- **Stake backing the live set** is stake on validators both registered for staking *and* in the current attestation set.
- `validator_stake_status` splits the total into:
  - backing the live set;
  - registered but not in the set;
  - on deregistered validators.

  The rows add up to the total.
- Shares in the overview have explicit denominators:
  - **share of contract stake** = validator stake / total contract stake;
  - **share of live-set stake** = validator stake / stake backing the live set, blank for validators outside it.

### Observed signing participation

Observed signing participation = recognised signature shares ÷ completed production ceremonies of the validator's groups.

- Ceremonies are counted by completion time.
- Pending ceremonies (no `SignCompleted`) are no opportunity.
- With no eligible ceremony (not a member, or none happened) the rate is *n/a*: blank in the heatmap, "n/a" in the overview, no row in the windows table. It is never 0%.
- **Last signature share** is the time and transaction of the last recognised share. It never reflects staking activity.

Production all time, at block 48971624:

| Validator | Signed / eligible |
| --- | --- |
| Gnosis, Greenfield, Safe Labs | 617 / 617 |
| Core Contributors | 616 / 617 |
| RockawayX | 122 / 126 (member until epoch 33924) |

### Participation used for rewards

This follows the reward scripts (`safe-fndn/safenet-staking-scripts`, `src/data/attestations.ts`): recognised shares on transaction ceremonies ÷ **all** attested transaction ceremonies completed in the period, member or not, counted up to the period's settlement block.

- The overview shows it for the current, unsettled two-week period, and the windows table as *reward basis*.
- Payouts use settled periods, a 75% threshold and a 3.5M SAFE minimum self-stake for commission. These are part of the rewards proposal pending SafeDAO approval; the dashboard shows the rates, not payout decisions.

### Stake history

`validator_stake_daily` applies the Staking rules (deposits − withdrawal requests, `staking_events`) per validator and UTC day, from 2026-03-04. A day's rows add up to `staking_daily.active_stake`.

`validator_stake_split_daily` splits each day into three parts, using the staker registered at the end of that day (`validator_staker_history`):

| Part | Meaning |
| --- | --- |
| self-stake | stake of the validator's registered staker that day |
| delegated | everyone else's stake |
| unattributed | stake on a validator with no registered staker that day; the split is unknown |

Registrations are by era: `ValidatorStakerSet` on the Beta Consensus `0x2236…cEE9` before the production start (2026-10-07 13:51:55 UTC), and on production Consensus after. Days from 2026-10-07 are production.

### Rewards

The source is [safenet-data `assets/rewards`](https://github.com/safe-fndn/safenet-data/tree/main/assets/rewards), copied by `npm run sync:validator-rewards` into `dune/data/validator-rewards.json` and the `safenet_validator_rewards` query.

- **Periods.**
  - Each published `latest.json` is a Merkle root of the Ethereum distributor.
  - Roots since the launch reset (the last index with `tokenTotal` 0, "Clear rewards of test data for launch") are recorded; earlier ones were test data.
  - A root with a new `rewardsUntil` ends a period. A root with the same `rewardsUntil` is a re-issue, such as a KYC release, and is merged into its period.
  - So far: 16 roots, 13 Beta periods from 2026-04-07 to 2026-10-06, of about 346,151 SAFE each.
  - Production periods are two weeks from 2026-10-13. 2026-10-06 to 2026-10-13 is the gap between the programmes.
  - An ended production period that is not published appears as *not yet published*, with no amounts.
- **Allocated** in a period = change in cumulative published amounts (cumulative + KYC-withheld) from the previous period's last root. It splits by recipient:

  | Recipient | Allocation |
  | --- | --- |
  | Validator stakers | addresses registered as a validator's staker during the period, Beta or production: their **commission and own-stake reward together**; the published files do not split them |
  | Delegators | the rest, minus Sentinel grants |
  | Sentinel grants | from `sentinelTokenTotal`; none in Beta |

- **Commission.** Not published. A split is recorded only from `cmd:rewards --split` of the reward scripts at a pinned commit, and only if its per-address totals equal the published amounts exactly. No production period is published yet, so there are no split rows: production reads *split not verified*, Beta reads *not published*. Older Beta parameters are not assumed to apply.
- **Claimed / claimable.**
  - Claims are the distributor's `Claimed(account, amount)` events (`safenet_reward_events`), attributed by **address only**.
  - Claimable = published cumulative (not withheld) − claimed, shown when the latest root is set on chain.
  - A validator staker's amount may also include rewards on its delegations to other validators.
  - Delegators' claims are not attributed to validators.

### Withdrawal exposure

Outstanding withdrawal requests per validator now come from `staking_withdrawals`: waiting and claimable, as in the Staking section. Labels add *(not in attestation set)* or *(deregistered)*.

## Models

All are shared, with `refresh: none`. Raw-log models read `gnosis.logs`, because Consensus and the FROSTCoordinator are not decoded on Dune (see [decoding.md](../decoding.md)).

### validator_epochs

One row per production epoch:

- `epoch`, `group_id`;
- `active_from_block`, `active_to_block` (exclusive);
- `active_from`, `active_to`;
- `status`: active, past or staged;
- `rollover_signature_id`, `staged_at`, `staged_tx`;
- `as_of_block`, `as_of_time`.

### validator_membership

One row per (epoch, validator) in its group: the epoch's fields, plus `confirmed_at` and `epoch_status`.

### validator_ceremonies

One row per production ceremony and member of its group:

- `sid`, `group_id`, `epoch`, `validator`, `initiated_at`;
- `completed`, `completed_at`, `completed_block`, `completed_tx`, `completed_tx_url`;
- `purpose`, `attested_at`, `attested_block`;
- `signed` (share under the completed root), `signed_at`, `share_tx`, `share_tx_url`;
- `first_row`: one row per ceremony, for counting ceremonies.

### validator_staker_history

One row per `ValidatorStakerSet` on Beta or production Consensus: `era`, `validator`, `staker`, `valid_from`, `valid_to` (exclusive), `tx_url`.

### safenet_validator_rewards

Generated. `kind_row` is `root` or `entry`:

- **roots**: `root_order`, `merkle_root`, `rewards_until`, `root_kind` (period / reissue), `token_total`, `sentinel_amount` (sentinelTokenTotal), `unpaid_amount`;
- **entries**: per validator staker address, `cumulative_amount` and `kyc_amount` under each root.

## Freshness and empty states

- `validator_overview` reports `as_of_time` and `through_block`: the Gnosis Chain head Dune had at execution.
- Stake columns follow the Staking queries' Ethereum data of the same refresh.
- Empty or not-applicable states:

  | Case | Shown as |
  | --- | --- |
  | no eligible ceremonies | n/a, or blank in the heatmap |
  | unpublished periods | *not yet published*, no amounts |
  | no outstanding withdrawals | no bars |
  | no registered staker | *none registered*; self-stake blank |

## Decoding and coverage

- **Gnosis Chain raw logs.**
  - Consensus from block 48635843 (2026-10-07).
  - FROSTCoordinator from block 48617821 (2026-10-06).
  - Beta Consensus `ValidatorStakerSet` from block 45210396 (2026-03-18), in `validator_staker_history` only.
  - Partition pruning uses `block_date`.
  - Topic0 values are in `src/safenet.ts` (`VALIDATOR_EVENTS`); `test/validators.test.ts` recomputes them from their signatures.
- **Migration to decoded tables.** If `check-decoded` shows Consensus and the FROSTCoordinator decoded with full history, switch to decoded tables only under these conditions:
  - the rows of `validator_epochs`, `validator_membership` and `validator_ceremonies` from decoded tables equal the raw-log versions over identical block ranges (`scripts/decoded-parity.sql` pattern);
  - the preview reconciliation shows no mismatches.

  Output columns stay the same.

## Validation

`npm run verify:validators` (`scripts/verify-validators.ts`, `scripts/lib/validators.ts`) runs in every preview and in the daily *Refresh*.

1. **Membership against contract state** at a pinned Gnosis block B:
   - `Consensus.getActiveEpoch()` = rebuilt active epoch and group;
   - `getEpochGroupId(e)` = rebuilt group for every epoch;
   - `FROSTCoordinator.participantKey(gid, v)` succeeds exactly for the rebuilt members of every group, for every known validator (it reverts for non-members);
   - `groupSignCount(gid)` = `Sign` events per group.

   Reads are batched through Multicall3.
2. **Participation**: every validator-day of `validator_participation_daily` and the production-wide window are recounted from logs at Dune's `through_block`.
3. **Stake**:
   - overview stake columns = `staking_by_validator` of the same refresh;
   - stake-status rows add up to the total, and the total = the Staking headline;
   - outstanding withdrawals per validator = the Staking replay (`scripts/lib/staking.ts`) at the Staking `through_block`.
4. **Rewards**:
   - the latest root's 208 proof files add up exactly to `tokenTotal` (cumulative + KYC-withheld);
   - `tokenTotal` never decreases;
   - each period's final root appears in the distributor's on-chain root updates;
   - no staker has claimed more than its published amount;
   - Dune rows match the published amounts and the on-chain claims.
5. **Representative cases** with gnosisscan links: RockawayX leaving after epoch 33924, ceremonies a member did not sign, an epoch-rollover ceremony, and the excluded self-initiated ceremony.

Result on 2026-10-27 (`verification/validators.json`, without Dune): every membership and reward check passed at block 48971624. The Dune comparison runs in the pull request's preview comment.

## Limitations

- **No published production rewards yet.** The first production period (2026-10-13 to 2026-10-27) is not published, so there is no production commission split, and Beta has none.
- **Claims are attributed by address.** A validator staker's claim also covers its own delegations, and delegators' claims are not attributed to validators.
- **The reward methodology is a proposal pending SafeDAO approval.** Rates are shown, not payout decisions.
- **Status is as of the refresh.** Current-state panels are as of the latest refresh. The overview's reward-basis rate covers an unsettled period.
- **Coordinator events are shared with the testnet.** Attribution relies on production Consensus naming the groups and initiating the ceremonies.
- **No APY, USD values or reward estimates.**
