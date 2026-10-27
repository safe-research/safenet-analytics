-- Safenet staking now: headline counters and data freshness, one row. Current state, independent of
-- the history charts. Definitions: docs/metrics/staking.md#headline.
--
--   active_stake              SAFE staked and not requested for withdrawal (contract totalStakedAmount)
--   active_stakers            addresses with positive active stake, counted once across validators
--   outstanding_withdrawals   requested, not claimed (contract totalPendingWithdrawals), reconstructed
--                             per withdrawal ID; split into waiting and claimable now
--   deregistered_stake        part of active_stake on validators deregistered in the Staking contract

with

positions as (
    select
        sum(p.active_stake_raw) as active_raw,
        count(distinct p.staker) as active_stakers,
        count(distinct p.validator) as validators_with_stake,
        sum(if(v.is_registered = false, p.active_stake_raw, 0)) as deregistered_raw
    from {{query:staking_positions}} as p
    left join (
        select validator, max_by(is_registered, block_number * 100000 + log_index) as is_registered
        from {{query:staking_events}}
        where event = 'validator_updated'
        group by 1
    ) as v on v.validator = p.validator
),

withdrawals as (
    select
        coalesce(sum(if(status <> 'completed', amount_raw)), 0) as outstanding_raw,
        coalesce(sum(if(status = 'waiting', amount_raw)), 0) as waiting_raw,
        coalesce(sum(if(status = 'claimable', amount_raw)), 0) as claimable_raw,
        count_if(status = 'waiting') as waiting_count,
        count_if(status = 'claimable') as claimable_count,
        count_if(not consistent) as inconsistent_withdrawals
    from {{query:staking_withdrawals}}
),

head as (
    select max(number) as through_block, max(time) as as_of_time
    from ethereum.blocks
    where time > now() - interval '2' day
)

select
    cast(p.active_raw as double) / 1e18 as active_stake,
    p.active_stakers,
    cast(w.outstanding_raw as double) / 1e18 as outstanding_withdrawals,
    cast(w.waiting_raw as double) / 1e18 as waiting_withdrawals,
    cast(w.claimable_raw as double) / 1e18 as claimable_withdrawals,
    w.waiting_count,
    w.claimable_count,
    cast(p.deregistered_raw as double) / 1e18 as deregistered_stake,
    p.validators_with_stake,
    p.active_raw as active_stake_raw,
    w.outstanding_raw as outstanding_withdrawals_raw,
    w.inconsistent_withdrawals, -- expected 0
    h.as_of_time,
    h.through_block, -- for the verification
    now() as computed_at
from positions as p
cross join withdrawals as w
cross join head as h
