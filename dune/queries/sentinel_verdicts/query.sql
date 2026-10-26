-- Safenet production: Sentinel responses by kind, per Sentinel, for the last 30 days and all time.
-- Definitions: docs/metrics/sentinels.md#verdicts.
--
-- Eligible rows of safenet_sentinel_responses for requests on the Charter's chains whose response
-- window has closed, by proposal time. Each is exactly one of:
--   secure / insecure   the Sentinel's own revealed vote (not the Oracle result, not a ruling)
--   missing_response    committed, never revealed
--   reverted_commit     tried to commit, every attempt reverted (late or invalid)
--   no_commit           never committed or tried: abstained or offline (indistinguishable on chain)
-- So secure + insecure + missing + reverted_commit + no_commit = eligible requests in the overview.

select
    name as sentinel,
    '0x' || lower(to_hex(sentinel)) as address,
    count_if(response_state = 'secure' and proposed_at >= now() - interval '30' day) as secure_30d,
    count_if(response_state = 'insecure' and proposed_at >= now() - interval '30' day) as insecure_30d,
    count_if(response_state = 'missing_response' and proposed_at >= now() - interval '30' day) as missing_30d,
    count_if(response_state = 'reverted_commit' and proposed_at >= now() - interval '30' day) as reverted_commit_30d,
    count_if(response_state = 'no_commit' and proposed_at >= now() - interval '30' day) as no_commit_30d,
    count_if(proposed_at >= now() - interval '30' day) as total_30d,
    count_if(response_state = 'secure') as secure_all,
    count_if(response_state = 'insecure') as insecure_all,
    count_if(response_state = 'missing_response') as missing_all,
    count_if(response_state = 'reverted_commit') as reverted_commit_all,
    count_if(response_state = 'no_commit') as no_commit_all,
    count(*) as total_all,
    max(max(through_block)) over () as through_block -- for the verification
from {{query:safenet_sentinel_responses}}
where covered_chain and window_closed and eligible
group by 1, 2
order by total_all desc, sentinel
