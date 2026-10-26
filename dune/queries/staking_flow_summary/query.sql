-- Safenet staking flows over the last 24 hours, 7 days, 30 days and all time (rolling windows up to
-- the query run). Definitions: docs/metrics/staking.md#flow-summary.
--
--   net_capital_flow      deposits - completed withdrawals: SAFE that entered or left the contract
--   active_stake_change   deposits - withdrawal requests: change in active stake
-- The two differ by the change in outstanding withdrawals (requested, not yet claimed).

with

windows as (
    select * from (
        values
            (1, '24 hours', now() - interval '1' day),
            (2, '7 days', now() - interval '7' day),
            (3, '30 days', now() - interval '30' day),
            (4, 'All time (since 2026-03-04)', timestamp '2026-03-04 00:00:00 UTC')
    ) as t (sort_order, period, since)
)

select
    w.period,
    coalesce(sum(if(e.event = 'deposit', e.amount)), 0) as deposits,
    coalesce(sum(if(e.event = 'withdrawal_requested', e.amount)), 0) as withdrawals_requested,
    coalesce(sum(if(e.event = 'withdrawal_claimed', e.amount)), 0) as withdrawals_completed,
    coalesce(sum(if(e.event = 'deposit', e.amount)), 0) - coalesce(sum(if(e.event = 'withdrawal_claimed', e.amount)), 0) as net_capital_flow,
    coalesce(sum(if(e.event = 'deposit', e.amount)), 0) - coalesce(sum(if(e.event = 'withdrawal_requested', e.amount)), 0) as active_stake_change,
    count_if(e.event = 'deposit') as deposit_count,
    count(distinct if(e.event = 'deposit', e.staker)) as depositors,
    count_if(e.event = 'withdrawal_requested') as request_count,
    count_if(e.event = 'withdrawal_claimed') as claim_count,
    w.sort_order
from windows as w
left join {{query:staking_events}} as e
    on e.block_time >= w.since
    and e.event in ('deposit', 'withdrawal_requested', 'withdrawal_claimed')
group by w.period, w.sort_order
order by w.sort_order
