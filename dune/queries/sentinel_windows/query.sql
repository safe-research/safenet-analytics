-- Safenet production: Sentinel participation over the last 24 hours, 7 days, 30 days and all time
-- (production only, since the first production request). One row per Sentinel, one column group
-- per window. Definitions: docs/metrics/sentinels.md#participation.
--
-- The population of a window is the requests proposed in it (Charter chains, as in the overview)
-- that the Sentinel was eligible for and whose response window has closed. Pending responses are
-- left out of both numerator and denominator; a window with no eligible request shows no rate
-- (null), not 0.

with

counts as (
    select
        sentinel,
        name,
        sentinel_url,
        max(through_block) as through_block,
        count(*) as eligible_all,
        count_if(valid_response) as valid_all,
        count_if(proposed_at >= now() - interval '30' day) as eligible_30d,
        count_if(proposed_at >= now() - interval '30' day and valid_response) as valid_30d,
        count_if(proposed_at >= now() - interval '30' day and response_state = 'no_commit') as no_commit_30d,
        count_if(proposed_at >= now() - interval '30' day and response_state = 'reverted_commit') as reverted_commit_30d,
        count_if(proposed_at >= now() - interval '30' day and response_state = 'missing_response') as missing_30d,
        count_if(proposed_at >= now() - interval '7' day) as eligible_7d,
        count_if(proposed_at >= now() - interval '7' day and valid_response) as valid_7d,
        count_if(proposed_at >= now() - interval '24' hour) as eligible_24h,
        count_if(proposed_at >= now() - interval '24' hour and valid_response) as valid_24h
    from {{query:safenet_sentinel_responses}}
    where covered_chain and eligible and window_closed
    group by 1, 2, 3
)

select
    '<a href="' || sentinel_url || '" target="_blank">' || name || '</a>' as sentinel_link,
    name,
    '0x' || lower(to_hex(sentinel)) as address,
    eligible_24h,
    if(eligible_24h > 0, cast(valid_24h as double) / eligible_24h) as rate_24h,
    eligible_7d,
    if(eligible_7d > 0, cast(valid_7d as double) / eligible_7d) as rate_7d,
    eligible_30d,
    if(eligible_30d > 0, cast(valid_30d as double) / eligible_30d) as rate_30d,
    no_commit_30d,
    reverted_commit_30d,
    missing_30d,
    eligible_all,
    if(eligible_all > 0, cast(valid_all as double) / eligible_all) as rate_all,
    now() as computed_at,
    max(through_block) over () as through_block -- for the verification
from counts
order by eligible_all desc, rate_all desc, name
