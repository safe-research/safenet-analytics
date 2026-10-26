-- Safenet staking positions now: one row per (staker, validator) with positive active stake.
-- Definitions: docs/metrics/staking.md#staking_positions. Shared model.
--
-- Active stake = deposits - withdrawal requests (Staking.sol: a request leaves active stake at once).
-- It equals the contract's stakes(staker, validator); the sum over all rows is totalStakedAmount.
-- Never the contract's token balance, which also holds outstanding withdrawals.
-- is_self_stake: the staker is the validator's registered staker (staking_validator_stakers); null
-- when the validator has no registered staker, so self-stake is unknown rather than zero.

with

positions as (
    select
        staker,
        validator,
        sum(if(event = 'deposit', amount_raw, -amount_raw)) as active_stake_raw,
        sum(if(event = 'deposit', amount_raw, 0)) as deposited_raw,
        min(if(event = 'deposit', block_time)) as first_deposit_at,
        max(block_time) as last_change_at
    from {{query:staking_events}}
    where event in ('deposit', 'withdrawal_requested')
    group by 1, 2
)

select
    p.staker,
    p.validator,
    p.active_stake_raw,
    cast(p.active_stake_raw as double) / 1e18 as active_stake,
    cast(p.deposited_raw as double) / 1e18 as deposited,
    p.first_deposit_at,
    p.last_change_at,
    s.staker as validator_staker,
    if(s.staker is null, null, s.staker = p.staker) as is_self_stake,
    'https://etherscan.io/address/0x' || lower(to_hex(p.staker)) as staker_url
from positions as p
left join {{query:staking_validator_stakers}} as s on s.validator = p.validator
where p.active_stake_raw > 0
