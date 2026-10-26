-- Safenet production: requests by the number of valid Sentinel responses (revealed votes) they
-- received, for the last 30 days and all time. Definitions: docs/metrics/sentinels.md#coverage.
--
-- Requests on the Charter's chains whose response window has closed (a verdict, a dispute, a
-- timeout, or the reveal deadline passed), by proposal time. Every bucket from 0 to the number of
-- Sentinels that were ever eligible is listed, so requests with no valid response show as an
-- explicit 0 bucket. Commits without a reveal do not count. Requests still in their response window
-- are reported in pending_requests and are in no bucket. Requests come from
-- safenet_sentinel_responses, so a request is included once any Sentinel was eligible for it
-- (every production request so far; the verification recounts all requests).

with

requests as (
    select
        request_id,
        max(proposed_at) as proposed_at,
        max(request_reveals) as reveals,
        bool_and(request_window_closed) as window_closed,
        count(distinct if(eligible, sentinel)) as eligible_sentinels,
        max(through_block) as through_block
    from {{query:safenet_sentinel_responses}}
    where covered_chain
    group by 1
),

-- One row with the valid-response counts of all decided requests, so the model is read once.
totals as (
    select
        array_agg(reveals) filter (where window_closed) as reveals_all,
        array_agg(reveals) filter (where window_closed and proposed_at >= now() - interval '30' day) as reveals_30d,
        greatest(max(eligible_sentinels), max(reveals)) as max_bucket,
        count_if(not window_closed) as pending_requests,
        max(through_block) as through_block
    from requests
)

select
    b as valid_responses,
    cast(b as varchar) || if(b = 1, ' response', ' responses') as bucket,
    coalesce(cardinality(filter(t.reveals_30d, x -> x = b)), 0) as requests_30d,
    coalesce(cardinality(filter(t.reveals_all, x -> x = b)), 0) as requests_all,
    coalesce(cardinality(t.reveals_30d), 0) as decided_30d,
    coalesce(cardinality(t.reveals_all), 0) as decided_all,
    t.pending_requests,
    t.through_block -- for the verification
from totals as t
cross join unnest(sequence(0, coalesce(t.max_bucket, 0))) as u (b)
order by 1
