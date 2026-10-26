-- Safenet production: requests by the number of valid Sentinel responses (revealed votes) they
-- received, for the last 30 days and all time. Definitions: docs/metrics/sentinels.md#coverage.
--
-- Requests on the Charter's chains whose response window has closed (a verdict, a dispute, a
-- timeout, or the reveal deadline passed), by proposal time. Every bucket from 0 to the number of
-- Sentinels that were ever active is listed, so requests with no valid response show as an explicit 0
-- bucket. Commits without a reveal do not count. Requests still in their response window are
-- reported in pending_requests and are in no bucket.

with

head as (
    select max(as_of_block) as as_of_block from {{query:safenet_sentinel_terms}}
),

requests as (
    select
        r.request_id,
        r.proposed_at,
        r.reveals,
        r.verdict is not null or r.status = 'disputed' or h.as_of_block > e.reveal_deadline as window_closed
    from {{query:safenet_requests}} as r
    join (select request_id, reveal_deadline from {{query:safenet_events}} where event = 'request') as e
        on e.request_id = r.request_id
    cross join head as h
    where r.covered_chain
),

buckets as (
    select b as valid_responses
    from (
        select greatest(
            (select count(distinct sentinel) from {{query:safenet_sentinel_terms}}
                where not never_active and active_from_block <= as_of_block),
            (select coalesce(max(reveals), 0) from requests)
        ) as n
    ) as m
    cross join unnest(sequence(0, m.n)) as t (b)
),

since as (
    select now() - interval '30' day as d30
)

select
    b.valid_responses,
    cast(b.valid_responses as varchar) || if(b.valid_responses = 1, ' response', ' responses') as bucket,
    count_if(r.request_id is not null and r.proposed_at >= s.d30) as requests_30d,
    count(r.request_id) as requests_all,
    (select count_if(window_closed and proposed_at >= (select d30 from since)) from requests) as decided_30d,
    (select count_if(window_closed) from requests) as decided_all,
    (select count_if(not window_closed) from requests) as pending_requests,
    (select max(block_number) from {{query:safenet_events}}) as through_block -- for the verification
from buckets as b
cross join since as s
left join requests as r on r.reveals = b.valid_responses and r.window_closed
group by 1, 2
order by 1
