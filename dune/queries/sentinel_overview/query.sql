-- Safenet production: one row per Sentinel ever scheduled on the production Sentinel Oracle, with
-- its current membership and all-time participation. Definitions: docs/metrics/sentinels.md.
--
-- Current status (now) comes from the latest membership term. The counts are history: requests for
-- Safes on the Charter's chains (covered_chain, as in the Network & revenue section; Safenet's own
-- operational Safes included, test traffic excluded) since the first production request.
--   eligible_requests   requests the Sentinel could respond to, response window closed
--   participation_rate  valid reveals on them / eligible_requests (pending excluded from both)
--   no_commit           eligible, never committed or tried: abstained or offline (indistinguishable)
--   reverted_commit     eligible, every commit attempt reverted (late or invalid): no response
--   missing_responses   committed but never revealed (not an abstention, not a response)
--   reverted_calls      reverted commit and reveal calls (no event; from traces)

with

responses as (
    select * from {{query:safenet_sentinel_responses}}
),

terms as (
    select
        sentinel,
        max_by(name, scheduled_block) as name,
        max_by(sentinel_url, scheduled_block) as sentinel_url,
        max_by(term_status, scheduled_block) as status,
        max(as_of_block) as as_of_block,
        max(as_of_time) as as_of_time
    from {{query:safenet_sentinel_terms}}
    group by 1
),

counts as (
    select
        sentinel,
        count_if(covered_chain and eligible and window_closed) as eligible_requests,
        count_if(covered_chain and committed_at is not null) as commits,
        count_if(covered_chain and valid_response) as valid_reveals,
        count_if(covered_chain and valid_response and eligible and window_closed) as valid_reveals_eligible,
        count_if(covered_chain and response_state = 'secure') as secure,
        count_if(covered_chain and response_state = 'insecure') as insecure,
        count_if(covered_chain and response_state = 'no_commit') as no_commit,
        count_if(covered_chain and response_state = 'reverted_commit') as reverted_commit,
        count_if(covered_chain and response_state = 'missing_response') as missing_responses,
        count_if(covered_chain and response_state in ('pending_commit', 'pending_reveal')) as pending,
        -- Reverted calls on any request, test traffic included: they are the Sentinel's own calls.
        sum(failed_commits + failed_reveals) as reverted_calls,
        max(last_reverted_at) as last_reverted_at,
        max_by(revert_reason, last_reverted_at) as last_revert_reason,
        max(last_activity_at) as last_activity_at,
        max_by(last_activity_tx_url, last_activity_at) as last_activity_tx_url,
        max(through_block) as through_block
    from responses
    group by 1
)

select
    '<a href="' || t.sentinel_url || '" target="_blank">' || t.name || '</a>' as sentinel_link,
    t.name,
    '0x' || lower(to_hex(t.sentinel)) as address,
    case t.status
        when 'active' then 'Active'
        when 'scheduled' then 'Scheduled (not yet active)'
        when 'removed' then 'Removed'
    end as current_status,
    coalesce(c.eligible_requests, 0) as eligible_requests,
    coalesce(c.commits, 0) as commits,
    coalesce(c.valid_reveals, 0) as valid_reveals,
    if(c.eligible_requests > 0, cast(c.valid_reveals_eligible as double) / c.eligible_requests) as participation_rate,
    coalesce(c.secure, 0) as secure,
    coalesce(c.insecure, 0) as insecure,
    coalesce(c.no_commit, 0) as no_commit,
    coalesce(c.reverted_commit, 0) as reverted_commit,
    coalesce(c.missing_responses, 0) as missing_responses,
    coalesce(c.pending, 0) as pending,
    coalesce(c.reverted_calls, 0) as reverted_calls,
    c.last_revert_reason,
    case
        when c.last_activity_at is null and c.last_reverted_at is null then 'none observed'
        when c.last_reverted_at > coalesce(c.last_activity_at, timestamp '1970-01-01 00:00:00 UTC')
            then format_datetime(c.last_reverted_at, 'yyyy-MM-dd HH:mm') || ' UTC (reverted call)'
        else '<a href="' || c.last_activity_tx_url || '" target="_blank">' || format_datetime(c.last_activity_at, 'yyyy-MM-dd HH:mm') || ' UTC</a>'
    end as last_activity,
    c.last_activity_at,
    t.as_of_time,
    t.as_of_block,
    now() as computed_at,
    max(c.through_block) over () as through_block -- for the verification
from terms as t
left join counts as c on c.sentinel = t.sentinel
order by t.status = 'active' desc, coalesce(c.valid_reveals, 0) desc, t.name
