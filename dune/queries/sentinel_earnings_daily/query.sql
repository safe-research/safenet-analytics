-- Safenet production: Sentinel transaction-fee rewards accrued per UTC day and Sentinel, last 30 days,
-- in USDC.e. A reward accrues on the day its request is decided (OracleResult, or the arbitrator's
-- ruling), and is paid when the Sentinel claims it. SAFE subsidies are a different token and are
-- never added here (sentinel_earnings). Definitions: docs/metrics/sentinels.md#earnings.

select
    cast(date_trunc('day', outcome_at) as date) as day,
    name as sentinel,
    sum(fee_reward_accrued) / 1e6 as fee_reward_usdc,
    count(*) as rewarded_requests,
    max(max(through_block)) over () as through_block -- for the verification
from {{query:safenet_sentinel_responses}}
where fee_reward_accrued > 0
    and outcome_at >= date_trunc('day', now()) - interval '29' day
group by 1, 2
order by 1 desc, 2
