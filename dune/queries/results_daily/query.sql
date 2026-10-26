-- Safenet production: requests of the last 30 days by UTC proposal day and their current status.
-- A status count, not a flow: each request appears once, on the day it was proposed, in its status
-- as of the latest data; a day's bars change as its requests are decided. Safes on the Charter's
-- chains only (test traffic on other chains excluded). Definitions:
-- docs/metrics/network-and-revenue.md#result-breakdown.

with

days as (
    select day from unnest(sequence(current_date - interval '29' day, current_date, interval '1' day)) as t (day)
),

bound as (
    select max(block_number) as through_block from {{query:safenet_events}}
),

requests as (
    select cast(date_trunc('day', proposed_at) as date) as day, status, dispute_ruling
    from {{query:safenet_requests}}
    where covered_chain and proposed_at >= current_date - interval '29' day
)

select
    d.day,
    count_if(r.status = 'secure_unanimous') as secure_unanimous,
    count_if(r.status = 'disputed') as disputed,
    count_if(r.status = 'insecure_unanimous') as insecure_unanimous,
    count_if(r.status = 'no_verdict') as timed_out,
    count_if(r.status = 'pending') as pending,
    count_if(r.status = 'disputed' and r.dispute_ruling = 'awaiting') as disputed_awaiting_ruling,
    count(r.status) as requests,
    b.through_block -- highest Gnosis block read, for the verification
from days as d
cross join bound as b
left join requests as r on r.day = d.day
group by d.day, b.through_block
order by 1
