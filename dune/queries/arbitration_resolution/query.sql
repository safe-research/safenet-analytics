-- Safenet production: how long arbitration takes, and the arbitrations still open. Definitions:
-- docs/metrics/sentinels.md#arbitration-rate-and-resolution-time. Model: scripts/lib/arbitration.ts.
--
-- Resolution time: from DisputeTriggered, emitted when SentinelOracle `finalize` freezes the
-- request (State.FROZEN), to DisputeResolved, the arbitrator's secure or insecure ruling. Only
-- ruled cases count. Unresolved cases are excluded; out-of-scope outcomes (DisputeOutOfScope) and
-- arbitration timeouts (ArbitrationTimedOut) end without a ruling and are counted separately, never
-- as resolved. One row per window of ruling time. Median and p90 interpolate linearly between the
-- closest ranks (position q * (n - 1) in the sorted durations); max is the longest ruled case. No
-- ruled case: no statistics, and the label says so instead of showing a duration of 0.
--
-- Open arbitrations (frozen, no outcome yet) and the oldest one's age are as of the execution
-- (computed_at) and the same on every row. Population as arbitration_windows: Charter chains.

with

cases as (
    select
        request_id,
        disputed_at,
        outcome_event,
        outcome_at,
        if(outcome_event = 'DisputeResolved', date_diff('millisecond', disputed_at, outcome_at) / 3600000e0) as hours_to_ruling,
        if(outcome_event is null, date_diff('millisecond', disputed_at, now()) / 3600000e0) as open_hours
    from {{query:safenet_requests}}
    where covered_chain and disputed_at is not null
),

windows as (
    select * from (
        values
            ('Ruled in the last 30 days', 1, now() - interval '30' day),
            ('Ruled since production start', 2, timestamp '2026-10-07 00:00:00 UTC')
    ) as t (time_window, sort_order, since)
),

ruled as (
    select
        w.time_window,
        w.sort_order,
        coalesce(array_sort(array_agg(c.hours_to_ruling) filter (where c.hours_to_ruling is not null and c.outcome_at >= w.since)), array[]) as hours,
        count_if(c.outcome_event = 'DisputeOutOfScope' and c.outcome_at >= w.since) as out_of_scope,
        count_if(c.outcome_event = 'ArbitrationTimedOut' and c.outcome_at >= w.since) as timed_out
    from windows as w
    left join cases as c on true
    group by 1, 2
),

stats as (
    select
        *,
        cardinality(hours) as ruled_cases,
        0.5 * (cardinality(hours) - 1) as p50_pos,
        0.9 * (cardinality(hours) - 1) as p90_pos
    from ruled
),

percentiles as (
    select
        *,
        if(ruled_cases > 0,
            element_at(hours, cast(floor(p50_pos) as bigint) + 1)
            + (p50_pos - floor(p50_pos)) * (element_at(hours, cast(ceil(p50_pos) as bigint) + 1) - element_at(hours, cast(floor(p50_pos) as bigint) + 1))
        ) as median_hours,
        if(ruled_cases > 0,
            element_at(hours, cast(floor(p90_pos) as bigint) + 1)
            + (p90_pos - floor(p90_pos)) * (element_at(hours, cast(ceil(p90_pos) as bigint) + 1) - element_at(hours, cast(floor(p90_pos) as bigint) + 1))
        ) as p90_hours
    from stats
),

open_cases as (
    select count(*) as open_arbitrations, max(open_hours) as oldest_open_hours
    from cases
    where outcome_event is null
),

bound as (
    select max(block_number) as through_block from {{query:safenet_events}}
)

select
    p.time_window,
    p.ruled_cases,
    p.median_hours,
    p.p90_hours,
    if(p.ruled_cases > 0, format('%.1f h', p.median_hours), 'no ruled cases') as median_label,
    if(p.ruled_cases > 0, format('%.1f h', p.p90_hours), 'no ruled cases') as p90_label,
    element_at(p.hours, -1) as max_hours, -- sorted ascending: the last is the longest; null when empty
    if(p.ruled_cases > 0, format('%.1f h', element_at(p.hours, -1)), 'no ruled cases') as max_label,
    p.out_of_scope,
    p.timed_out,
    o.open_arbitrations,
    o.oldest_open_hours,
    if(o.open_arbitrations > 0, format('%.1f h', o.oldest_open_hours), 'none open') as oldest_open_label,
    now() as computed_at,
    b.through_block
from percentiles as p
cross join open_cases as o
cross join bound as b
order by p.sort_order
