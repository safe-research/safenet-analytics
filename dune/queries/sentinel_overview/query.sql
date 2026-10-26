-- Safenet production: one row per Sentinel ever scheduled on the production Sentinel Oracle, with
-- its current membership and all-time participation. Definitions: docs/metrics/sentinels.md.
--
-- Current status (now) comes from the latest membership term. The counts are history: requests for
-- Safes on the Charter's chains (covered_chain, as in the Network & revenue section; Safenet's own
-- operational Safes included, test traffic excluded) since the first production request.
--   eligible_requests   requests the Sentinel could respond to, response window closed
--   participation_rate  valid_reveals / eligible_requests (pending responses excluded from both)
--   no_commit           eligible, never committed or tried: abstained or offline (indistinguishable)
--   reverted_commit     eligible, every commit attempt reverted (late or invalid): no response
--   missing_responses   committed but never revealed (not an abstention, not a response)
--   reverted_calls      late or invalid commit/reveal calls that reverted (no event; from traces)

with

responses as (
    select * from {{query:safenet_sentinel_responses}}
    where covered_chain
),

terms as (
    select * from {{query:safenet_sentinel_terms}}
),

-- Latest term per Sentinel: its current status.
current_term as (
    select
        sentinel,
        max_by(name, scheduled_block) as name,
        max_by(sentinel_url, scheduled_block) as sentinel_url,
        max_by(term_status, scheduled_block) as status,
        max_by(active_from_block, scheduled_block) as active_from_block,
        max_by(removed_block, scheduled_block) as removed_block,
        min(scheduled_at) as first_scheduled_at,
        max(as_of_block) as as_of_block,
        max(as_of_time) as as_of_time
    from terms
    group by 1
),

failed as (
    select
        sentinel,
        count(*) as reverted_calls,
        count_if(f.call_kind = 'commit') as reverted_commits,
        count_if(f.call_kind = 'reveal') as reverted_reveals,
        max(block_time) as last_reverted_at,
        max_by(revert_reason, block_number) as last_revert_reason
    from {{query:safenet_sentinel_failed_calls}} as f
    group by 1
),

counts as (
    select
        sentinel,
        count_if(eligible and window_closed) as eligible_requests,
        count_if(committed_at is not null) as commits,
        count_if(valid_response) as valid_reveals,
        count_if(valid_response and eligible and window_closed) as valid_reveals_eligible,
        count_if(response_state = 'secure') as secure,
        count_if(response_state = 'insecure') as insecure,
        count_if(response_state = 'no_commit') as no_commit,
        count_if(response_state = 'reverted_commit') as reverted_commit,
        count_if(response_state = 'missing_response') as missing_responses,
        count_if(response_state in ('pending_commit', 'pending_reveal')) as pending,
        max(last_activity_at) as last_activity_at,
        max_by(coalesce(claim_tx_url, reveal_tx_url, commit_tx_url), last_activity_at) as last_activity_tx_url
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
    coalesce(f.reverted_calls, 0) as reverted_calls,
    f.last_revert_reason,
    case
        when c.last_activity_at is null and f.last_reverted_at is null then 'none observed'
        when f.last_reverted_at > coalesce(c.last_activity_at, timestamp '1970-01-01 00:00:00 UTC')
            then format_datetime(f.last_reverted_at, 'yyyy-MM-dd HH:mm') || ' UTC (reverted call)'
        else '<a href="' || c.last_activity_tx_url || '" target="_blank">' || format_datetime(c.last_activity_at, 'yyyy-MM-dd HH:mm') || ' UTC</a>'
    end as last_activity,
    c.last_activity_at,
    t.first_scheduled_at,
    t.active_from_block,
    t.removed_block,
    t.as_of_time,
    t.as_of_block,
    now() as computed_at,
    (select max(block_number) from {{query:safenet_events}}) as through_block -- for the verification
from current_term as t
left join counts as c on c.sentinel = t.sentinel
left join failed as f on f.sentinel = t.sentinel
order by t.status = 'active' desc, coalesce(c.valid_reveals, 0) desc, t.name
