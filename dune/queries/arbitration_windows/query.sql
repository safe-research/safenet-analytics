-- Safenet production: arbitration rate by request cohort. One row per window: requests proposed in
-- the last 24 hours, 7 days, 30 days and since production start. Definitions:
-- docs/metrics/sentinels.md#arbitration-rate-and-resolution-time. Model: scripts/lib/arbitration.ts.
--
-- Population: requests for Safes on the Charter's chains, as in Network & revenue (operational
-- Safes included; requests for Safes on other chains are test traffic and excluded). Cohorts are
-- selected by proposal time; each request counts once, in its latest state. A request enters
-- arbitration with DisputeTriggered (the freeze, SentinelOracle State.FROZEN) and ends with a
-- ruling (DisputeResolved, secure or insecure), out of scope (DisputeOutOfScope) or an arbitration
-- timeout (ArbitrationTimedOut); until then it is awaiting an outcome. Requests still being voted
-- on (still_voting) can still enter arbitration, so recent cohorts' rates can rise.

with

requests as (
    select * from {{query:safenet_requests}}
    where covered_chain
),

windows as (
    select * from (
        values
            ('Last 24 hours', 1, now() - interval '24' hour),
            ('Last 7 days', 2, now() - interval '7' day),
            ('Last 30 days', 3, now() - interval '30' day),
            ('Production, all time', 4, timestamp '2026-10-07 00:00:00 UTC') -- as network_summary
    ) as t (time_window, sort_order, since)
),

-- Highest Gnosis block among the events read; the verification recounts up to exactly this block.
bound as (
    select max(block_number) as through_block from {{query:safenet_events}}
),

counts as (
    select
        w.time_window,
        w.sort_order,
        w.since,
        count(r.request_id) as requests,
        count(r.disputed_at) as arbitrated,
        count_if(r.disputed_at is not null and r.outcome_event is null) as awaiting,
        count_if(r.disputed_at is not null and r.outcome_event = 'DisputeResolved' and r.verdict = 'approved') as ruled_secure,
        count_if(r.disputed_at is not null and r.outcome_event = 'DisputeResolved' and r.verdict = 'denied') as ruled_insecure,
        count_if(r.disputed_at is not null and r.outcome_event = 'DisputeOutOfScope') as out_of_scope,
        count_if(r.disputed_at is not null and r.outcome_event = 'ArbitrationTimedOut') as timed_out,
        count_if(r.disputed_at is null and r.verdict is null) as still_voting
    from windows as w
    left join requests as r on r.proposed_at >= w.since
    group by 1, 2, 3
)

select
    time_window,
    requests,
    arbitrated,
    if(requests > 0, cast(arbitrated as double) / requests) as arbitration_rate,
    if(requests > 0, 100 * cast(arbitrated as double) / requests) as arbitration_pct,
    if(requests > 0, format('%.2f%%', 100 * cast(arbitrated as double) / requests), 'no requests') as arbitration_rate_label,
    awaiting,
    ruled_secure,
    ruled_insecure,
    out_of_scope,
    timed_out,
    still_voting,
    since as cohort_start,
    now() as computed_at,
    b.through_block
from counts
cross join bound as b
order by sort_order
