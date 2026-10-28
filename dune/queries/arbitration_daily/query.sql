-- Safenet production: arbitration rate per UTC proposal day, from the first production request to
-- today, days without requests included (no rate). Same population and states as
-- arbitration_windows (docs/metrics/sentinels.md#arbitration-rate-and-resolution-time). A day's
-- requests are counted in their latest state: requests of recent days still being voted on
-- (still_voting) can still enter arbitration, so recent rates can rise. Dispute dates are not used.

with

requests as (
    select * from {{query:safenet_requests}}
    where covered_chain
),

days as (
    select day
    from unnest(sequence((select cast(min(proposed_at) as date) from requests), current_date, interval '1' day)) as t (day)
),

daily as (
    select
        cast(date_trunc('day', proposed_at) as date) as day,
        count(*) as requests,
        count(disputed_at) as arbitrated,
        count_if(disputed_at is null and verdict is null) as still_voting
    from requests
    group by 1
),

bound as (
    select max(block_number) as through_block from {{query:safenet_events}}
)

select
    d.day,
    coalesce(x.requests, 0) as requests,
    coalesce(x.arbitrated, 0) as arbitrated,
    if(coalesce(x.requests, 0) > 0, 100 * cast(x.arbitrated as double) / x.requests) as arbitration_pct,
    coalesce(x.still_voting, 0) as still_voting,
    b.through_block
from days as d
left join daily as x on x.day = d.day
cross join bound as b
order by d.day
