-- Safenet production: Sentinel participation over the last 24 hours, 7 days, 30 days and all time
-- (production only, since the first production request). One row per Sentinel, one column group
-- per window. Definitions: docs/metrics/sentinels.md#participation.
--
-- The population of a window is the requests proposed in it (Charter chains, as in the overview)
-- that the Sentinel was eligible for and whose response window has closed. Pending responses are
-- left out of both numerator and denominator; a window with no eligible request shows no rate
-- (null), not 0.

with

responses as (
    select r.*, t.name, t.sentinel_url
    from {{query:safenet_sentinel_responses}} as r
    join (
        select sentinel, max_by(name, scheduled_block) as name, max_by(sentinel_url, scheduled_block) as sentinel_url
        from {{query:safenet_sentinel_terms}}
        group by 1
    ) as t on t.sentinel = r.sentinel
    where r.covered_chain and r.eligible and r.window_closed
),

windows as (
    select * from (
        values
            ('all', timestamp '2026-10-07 00:00:00 UTC'),
            ('30d', now() - interval '30' day),
            ('7d', now() - interval '7' day),
            ('24h', now() - interval '24' hour)
    ) as t (w, since)
),

counts as (
    select
        r.sentinel,
        r.name,
        r.sentinel_url,
        w.w,
        count_if(r.proposed_at >= w.since) as eligible,
        count_if(r.proposed_at >= w.since and r.valid_response) as valid,
        count_if(r.proposed_at >= w.since and r.response_state = 'no_commit') as no_commit,
        count_if(r.proposed_at >= w.since and r.response_state = 'reverted_commit') as reverted_commit,
        count_if(r.proposed_at >= w.since and r.response_state = 'missing_response') as missing
    from responses as r
    cross join windows as w
    group by 1, 2, 3, 4
)

select
    '<a href="' || sentinel_url || '" target="_blank">' || name || '</a>' as sentinel_link,
    name,
    '0x' || lower(to_hex(sentinel)) as address,
    max(if(w = '24h', eligible)) as eligible_24h,
    max(if(w = '24h' and eligible > 0, cast(valid as double) / eligible)) as rate_24h,
    max(if(w = '7d', eligible)) as eligible_7d,
    max(if(w = '7d' and eligible > 0, cast(valid as double) / eligible)) as rate_7d,
    max(if(w = '30d', eligible)) as eligible_30d,
    max(if(w = '30d' and eligible > 0, cast(valid as double) / eligible)) as rate_30d,
    max(if(w = '30d', no_commit)) as no_commit_30d,
    max(if(w = '30d', reverted_commit)) as reverted_commit_30d,
    max(if(w = '30d', missing)) as missing_30d,
    max(if(w = 'all', eligible)) as eligible_all,
    max(if(w = 'all' and eligible > 0, cast(valid as double) / eligible)) as rate_all,
    now() as computed_at,
    (select max(block_number) from {{query:safenet_events}}) as through_block -- for the verification
from counts
group by 1, 2, 3
order by eligible_all desc, rate_all desc, name
