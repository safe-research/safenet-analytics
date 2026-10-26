-- Safenet staking per UTC day, all time (Beta and production, one contract), for the history charts.
-- Definitions: docs/metrics/staking.md#staking_daily. Also readable by other queries.
--
--   deposits                 SAFE staked that day (StakeIncreased): external inflow
--   withdrawals_requested    SAFE requested for withdrawal (WithdrawalInitiated): leaves active stake,
--                            still held by the contract until claimed
--   withdrawals_completed    SAFE claimed (WithdrawalClaimed): external outflow
--   active_stake             active stake at the end of the day (deposits - requests, cumulative)
--   outstanding_withdrawals  requested, not yet claimed, at the end of the day
--   net_flow                 deposits - completed withdrawals, cumulative. It differs from active
--                            stake by exactly the outstanding withdrawals.
-- The *_beta / *_production columns split a series at the production start (2026-10-07, the
-- production Consensus deployment), so the charts colour the two eras. The current day is partial.

with

daily as (
    select
        cast(block_time as date) as day,
        sum(if(event = 'deposit', amount_raw, 0)) as deposits_raw,
        sum(if(event = 'withdrawal_requested', amount_raw, 0)) as requested_raw,
        sum(if(event = 'withdrawal_claimed', amount_raw, 0)) as completed_raw,
        count_if(event = 'deposit') as deposit_count,
        count_if(event = 'withdrawal_requested') as request_count,
        count_if(event = 'withdrawal_claimed') as claim_count
    from {{query:staking_events}}
    where event in ('deposit', 'withdrawal_requested', 'withdrawal_claimed')
    group by 1
),

days as (
    select day
    from unnest(sequence(date '2026-03-04', current_date)) as t (day)
),

head as (
    select max(number) as through_block, max(time) as as_of_time
    from ethereum.blocks
    where time > now() - interval '2' day
),

series as (
    select
        d.day,
        coalesce(x.deposits_raw, 0) as deposits_raw,
        coalesce(x.requested_raw, 0) as requested_raw,
        coalesce(x.completed_raw, 0) as completed_raw,
        coalesce(x.deposit_count, 0) as deposit_count,
        coalesce(x.request_count, 0) as request_count,
        coalesce(x.claim_count, 0) as claim_count,
        sum(coalesce(x.deposits_raw, 0) - coalesce(x.requested_raw, 0)) over (order by d.day) as active_raw,
        sum(coalesce(x.requested_raw, 0) - coalesce(x.completed_raw, 0)) over (order by d.day) as outstanding_raw,
        sum(coalesce(x.deposits_raw, 0) - coalesce(x.completed_raw, 0)) over (order by d.day) as net_flow_raw
    from days as d
    left join daily as x on x.day = d.day
)

select
    s.day,
    if(s.day >= date '2026-10-07', 'production', 'beta') as era,
    cast(s.deposits_raw as double) / 1e18 as deposits,
    cast(s.requested_raw as double) / 1e18 as withdrawals_requested,
    cast(s.completed_raw as double) / 1e18 as withdrawals_completed,
    0 - cast(s.completed_raw as double) / 1e18 as withdrawals_completed_negative, -- 0 - x: no "-0"
    cast(s.active_raw as double) / 1e18 as active_stake,
    cast(s.outstanding_raw as double) / 1e18 as outstanding_withdrawals,
    cast(s.net_flow_raw as double) / 1e18 as net_flow,
    -- the boundary day is in both, so the two areas meet
    if(s.day <= date '2026-10-07', cast(s.active_raw as double) / 1e18) as active_stake_beta,
    if(s.day >= date '2026-10-07', cast(s.active_raw as double) / 1e18) as active_stake_production,
    if(s.day < date '2026-10-07', cast(s.requested_raw as double) / 1e18) as withdrawals_requested_beta,
    if(s.day >= date '2026-10-07', cast(s.requested_raw as double) / 1e18) as withdrawals_requested_production,
    s.deposit_count,
    s.request_count,
    s.claim_count,
    s.active_raw as active_stake_raw,
    s.outstanding_raw as outstanding_withdrawals_raw,
    s.net_flow_raw,
    h.through_block, -- for the verification
    h.as_of_time
from series as s
cross join head as h
order by s.day
