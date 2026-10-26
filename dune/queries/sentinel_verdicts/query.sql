-- Safenet production: Sentinel responses by kind, per Sentinel, for the last 30 days and all time.
-- Definitions: docs/metrics/sentinels.md#verdicts.
--
-- Rows of safenet_sentinel_responses for requests on the Charter's chains whose response window has
-- closed, by proposal time. Each eligible (request, Sentinel) pair is exactly one of:
--   secure / insecure   the Sentinel's own revealed vote (not the Oracle result, not a ruling)
--   missing_response    committed, never revealed
--   reverted_commit     tried to commit, every attempt reverted (late or invalid)
--   no_commit           never committed or tried: abstained or offline (indistinguishable on chain)
-- So secure + insecure + missing + reverted_commit + no_commit = eligible requests in the overview.

with

responses as (
    select * from {{query:safenet_sentinel_responses}}
    where covered_chain and window_closed and eligible
),

names as (
    select sentinel, max_by(name, scheduled_block) as name
    from {{query:safenet_sentinel_terms}}
    group by 1
),

since as (
    select now() - interval '30' day as d30
)

select
    n.name as sentinel,
    '0x' || lower(to_hex(r.sentinel)) as address,
    count_if(r.response_state = 'secure' and r.proposed_at >= s.d30) as secure_30d,
    count_if(r.response_state = 'insecure' and r.proposed_at >= s.d30) as insecure_30d,
    count_if(r.response_state = 'missing_response' and r.proposed_at >= s.d30) as missing_30d,
    count_if(r.response_state = 'reverted_commit' and r.proposed_at >= s.d30) as reverted_commit_30d,
    count_if(r.response_state = 'no_commit' and r.proposed_at >= s.d30) as no_commit_30d,
    count_if(r.proposed_at >= s.d30) as total_30d,
    count_if(r.response_state = 'secure') as secure_all,
    count_if(r.response_state = 'insecure') as insecure_all,
    count_if(r.response_state = 'missing_response') as missing_all,
    count_if(r.response_state = 'reverted_commit') as reverted_commit_all,
    count_if(r.response_state = 'no_commit') as no_commit_all,
    count(*) as total_all,
    (select max(block_number) from {{query:safenet_events}}) as through_block -- for the verification
from responses as r
cross join since as s
join names as n on n.sentinel = r.sentinel
group by 1, 2
order by total_all desc, sentinel
