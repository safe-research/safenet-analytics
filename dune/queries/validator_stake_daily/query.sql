-- Safenet active stake per validator at the end of each UTC day, all time (Beta and production in one
-- Staking contract). Definitions: docs/metrics/validators.md#stake-history. Active stake follows the
-- Staking section: deposits minus withdrawal requests (staking_events), per validator; the rows of a
-- day add up to staking_daily.active_stake. The current day is partial.

with

changes as (
    select
        cast(block_time as date) as day,
        validator,
        sum(if(event = 'deposit', amount_raw, -amount_raw)) as delta_raw
    from {{query:staking_events}}
    where event in ('deposit', 'withdrawal_requested')
    group by 1, 2
),

-- each validator's level from its first change, carried over days without changes
levels as (
    select
        validator,
        day,
        sum(delta_raw) over (partition by validator order by day) as stake_raw,
        lead(day) over (partition by validator order by day) as next_day
    from changes
),

days as (
    select day from unnest(sequence(date '2026-03-04', current_date)) as t (day)
),

labels as (
    select address, label from {{query:safenet_participant_labels}} where role = 'validator'
)

select
    d.day,
    if(d.day >= date '2026-10-07', 'production', 'beta') as era,
    coalesce(lb.label, '0x' || lower(to_hex(l.validator))) as validator,
    cast(l.stake_raw as double) / 1e18 as active_stake,
    l.stake_raw as active_stake_raw,
    '0x' || lower(to_hex(l.validator)) as address
from days as d
join levels as l on l.day <= d.day and (l.next_day is null or d.day < l.next_day)
left join labels as lb on lb.address = l.validator
order by d.day, validator
