### Validator definitions

- **Attestation set**: the members of the active epoch's signing group. Those are the validators that confirmed the group's key on the FROST coordinator, for the group production Consensus named for that epoch. History uses each epoch's own group. The first production group signed from 2026-10-14.
- **Staking registration**: the validator's registration in the Ethereum Staking contract, as in the Staking section. It is a separate attribute from the attestation set.
- **Stake backing the live set**: active stake on validators that are both registered for staking and in the current attestation set. *Share of contract stake* divides by all active stake in the Staking contract. *Share of live-set stake* divides by stake backing the live set.
- **Self-stake / delegated stake**: stake of the validator's registered staker, and of everyone else, as in the Staking section. History uses the staker registered on each day: Beta registrations until 2026-10-07, production after.
- **Observed signing participation**: recognised signature shares ÷ completed ceremonies of the validator's groups. A share counts only under the completed signature's selection root. Pending ceremonies are not counted.
- **Used for rewards**: the reward scripts' rate, signed attested transactions ÷ all attested transactions in the period. Payouts use settled two-week periods (from 2026-10-13) and thresholds that are part of the rewards proposal pending SafeDAO approval.
- **Last signature share**: the validator's latest recognised share. It never reflects staking activity.
- **Rewards**: allocations as published in [safenet-data](https://github.com/safe-fndn/safenet-data/tree/main/assets/rewards), by period. A validator staker's amount combines commission and own-stake reward; the split is not published. Claims count per address. Unpublished periods have no amounts, which is not 0.
- **Outstanding withdrawals**: requested, not yet claimed, as in the Staking section.
- Names come from [safenet-data](https://github.com/safe-fndn/safenet-data/blob/main/assets/validator-info.json) and are labels only; unknown validators show their address.

[Full definitions, models, sources and validation](https://github.com/safe-research/safenet-analytics/blob/main/docs/metrics/validators.md)
