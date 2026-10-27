-- Safenet active stake per UTC day split into self-stake and delegated stake, all time. Definitions:
-- docs/metrics/validators.md#stake-history.
--
-- Self-stake on a day is each validator's stake from the staker registered for it at the end of that
-- day (validator_staker_history: Beta Consensus before the production start, production Consensus
-- after); delegated stake is everyone else's. Stake on a validator without a registered staker that
-- day is unattributed (split unknown), never counted as delegated. The three add up to
-- staking_daily.active_stake.

with

pairs as (
    select
        cast(block_time as date) as day,
        staker,
        validator,
        sum(if(event = 'deposit', amount_raw, -amount_raw)) as delta_raw
    from {{query:staking_events}}
    where event in ('deposit', 'withdrawal_requested')
    group by 1, 2, 3
),

pair_levels as (
    select
        staker,
        validator,
        day,
        sum(delta_raw) over (partition by staker, validator order by day) as stake_raw,
        lead(day) over (partition by staker, validator order by day) as next_day
    from pairs
),

days as (
    select day from unnest(sequence(date '2026-03-04', current_date)) as t (day)
),

-- staker registered for each validator at the end of each day (the latest setting in force)
in_force as (
    select
        d.day,
        h.validator,
        max_by(h.staker, h.valid_from) as staker
    from days as d
    join {{query:validator_staker_history}} as h
        on h.valid_from < cast(d.day as timestamp) + interval '1' day
        and (h.valid_to is null or h.valid_to >= cast(d.day as timestamp) + interval '1' day)
    group by 1, 2
),

levels as (
    select
        d.day,
        p.staker,
        p.validator,
        p.stake_raw,
        f.staker as validator_staker
    from days as d
    join pair_levels as p on p.day <= d.day and (p.next_day is null or d.day < p.next_day)
    left join in_force as f on f.day = d.day and f.validator = p.validator
)

select
    day,
    if(day >= date '2026-10-07', 'production', 'beta') as era,
    cast(sum(if(validator_staker is not null and staker = validator_staker, stake_raw, 0)) as double) / 1e18 as self_stake,
    cast(sum(if(validator_staker is not null and staker <> validator_staker, stake_raw, 0)) as double) / 1e18 as delegated_stake,
    cast(sum(if(validator_staker is null, stake_raw, 0)) as double) / 1e18 as unattributed_stake,
    cast(sum(stake_raw) as double) / 1e18 as active_stake
from levels
group by 1, 2
order by 1
