### Staking definitions

- **Active stake**: deposits minus withdrawal requests, from the contract's events. It equals the contract's `totalStakedAmount`. It is not the contract's SAFE balance, which also holds requested withdrawals until they are claimed.
- **Stakers**: addresses with positive active stake, each counted once even if it stakes toward several validators.
- **Outstanding withdrawals**: requested and not yet claimed, rebuilt per withdrawal ID. **Waiting**: the earliest withdrawal date has not passed. **Claimable now**: it has, but the staker has not claimed yet. The earliest withdrawal date is the request time plus the withdrawal delay in force at the request. Completed withdrawals are not outstanding.
- **Deposits / completed withdrawals**: SAFE moved into or out of the contract. **Net capital flow** is their running difference. It differs from active stake by exactly the outstanding withdrawals. Withdrawal requests move no tokens.
- **Self-stake**: the stake of the validator's **registered staker**, the Ethereum account the validator set on the Safenet Consensus contract (`setValidatorStaker`). Never inferred from names. Without a registered staker, the split is shown as unknown.
- **Delegated stake**: everyone else's stake on that validator.
- **Deregistered**: removed from the Staking contract's validator list. Its stake stays until withdrawn and is shown separately, not as backing the validator set. Registration in the Staking contract does not by itself mean membership of the live validator set.
- Names come from [safenet-data](https://github.com/safe-fndn/safenet-data/blob/main/assets/validator-info.json) and are labels only. Unknown validators show their address.
- **Production start**: the deployment of the production Consensus on Gnosis Chain, 2026-10-07 13:51 UTC. Earlier staking backed Beta.

[Full definitions, models, sources and validation](https://github.com/safe-research/safenet-analytics/blob/main/docs/metrics/staking.md)
