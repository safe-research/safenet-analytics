-- Safenet production: Sentinel transaction-fee rewards accrued per UTC day and Sentinel, last 30 days,
-- in USDC.e. A reward accrues on the day its request is decided (OracleResult, or the arbitrator's
-- ruling), and is paid when the Sentinel claims it. SAFE subsidies are a different token and are
-- never added here (sentinel_earnings). Definitions: docs/metrics/sentinels.md#earnings.

with

names as (
    select sentinel, max_by(name, scheduled_block) as name
    from {{query:safenet_sentinel_terms}}
    group by 1
)

select
    cast(date_trunc('day', r.outcome_at) as date) as day,
    n.name as sentinel,
    sum(r.fee_reward_accrued) / 1e6 as fee_reward_usdc,
    count(*) as rewarded_requests,
    (select max(block_number) from {{query:safenet_events}}) as through_block -- for the verification
from {{query:safenet_sentinel_responses}} as r
join names as n on n.sentinel = r.sentinel
where r.fee_reward_accrued > 0
    and r.outcome_at >= date_trunc('day', now()) - interval '29' day
group by 1, 2
order by 1 desc, 2
