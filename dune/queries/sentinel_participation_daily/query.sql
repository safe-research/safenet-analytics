-- Safenet production: daily Sentinel participation for the last 30 UTC days, one row per Sentinel
-- and day, for the participation heatmap. Definitions: docs/metrics/sentinels.md#participation.
--
-- A day's population is the requests proposed that day (Charter chains) that the Sentinel was
-- eligible for and whose response window has closed. participation_pct = valid reveals / that
-- population, in percent. Days on which the Sentinel was not eligible for any request (not yet a
-- member, removed, or no requests) have no row and stay blank in the heatmap, never 0.

with

responses as (
    select * from {{query:safenet_sentinel_responses}}
    where covered_chain and eligible and window_closed
        and proposed_at >= date_trunc('day', now()) - interval '29' day
),

names as (
    select sentinel, max_by(name, scheduled_block) as name
    from {{query:safenet_sentinel_terms}}
    group by 1
)

select
    cast(date_trunc('day', r.proposed_at) as date) as day,
    n.name as sentinel,
    '0x' || lower(to_hex(r.sentinel)) as address,
    count(*) as eligible_requests,
    count_if(r.valid_response) as valid_reveals,
    count_if(r.response_state = 'no_commit') as no_commit,
    count_if(r.response_state = 'reverted_commit') as reverted_commit,
    count_if(r.response_state = 'missing_response') as missing_responses,
    round(100.0 * count_if(r.valid_response) / count(*), 1) as participation_pct,
    (select max(block_number) from {{query:safenet_events}}) as through_block -- for the verification
from responses as r
join names as n on n.sentinel = r.sentinel
group by 1, 2, 3
order by day desc, sentinel
