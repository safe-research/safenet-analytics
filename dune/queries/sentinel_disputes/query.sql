-- Safenet production: every disputed request, with each Sentinel's own vote, the Oracle result and
-- the arbitration status and ruling as separate columns. Definitions:
-- docs/metrics/sentinels.md#disputes-and-arbitration.
--
-- A dispute starts when revealed votes disagree: the Oracle then gives no result (DisputeTriggered
-- instead of OracleResult) and the request waits for the arbitrator (the Safenet Security Council's
-- Arbitrator Safe 0xc89Ae483…8348). It ends with DisputeResolved (ruling secure or insecure, with
-- the slashed total and the arbitrator's recorded context), DisputeOutOfScope (no ruling, context
-- recorded), or ArbitrationTimedOut (no ruling within about 28 days). A ruling is not the
-- Sentinels' consensus, and disputed requests are never attested by the validators, whatever the
-- ruling. Reasons and context are shown as recorded on chain (HTML escaped); nothing is added when
-- none was recorded. All disputes are listed, test traffic marked.

with

events as (
    select * from {{query:safenet_events}}
    where request_id is not null
),

disputes as (
    select request_id, min(block_time) as triggered_at, min_by(tx_url, block_number) as trigger_tx_url
    from events
    where event = 'dispute'
    group by 1
),

endings as (
    select request_id, source_event, event as verdict, block_time as ended_at, tx_url as end_tx_url, slashed, reason as context
    from events
    where event in ('approved', 'denied', 'no_verdict')
),

names as (
    select sentinel, max_by(name, scheduled_block) as name
    from {{query:safenet_sentinel_terms}}
    group by 1
),

-- Each committed Sentinel's own vote and recorded reason.
votes as (
    select
        r.request_id,
        array_join(array_agg(
            n.name || ': ' || case r.response_state
                when 'secure' then 'secure'
                when 'insecure' then 'insecure'
                when 'missing_response' then 'no reveal (missing response)'
                else 'reveal pending'
            end
            || if(r.reason is not null, ' (' || replace(replace(r.reason, '<', '&lt;'), '>', '&gt;') || ')', '')
            order by r.response_state, n.name
        ), '; ') as sentinel_votes,
        count_if(r.response_state = 'secure') as secure_votes,
        count_if(r.response_state = 'insecure') as insecure_votes
    from {{query:safenet_sentinel_responses}} as r
    join names as n on n.sentinel = r.sentinel
    where r.committed_at is not null
    group by 1
),

esc as (
    select
        e.*,
        replace(replace(e.context, '<', '&lt;'), '>', '&gt;') as context_html
    from endings as e
)

select
    d.triggered_at,
    '<a href="' || d.trigger_tx_url || '" target="_blank">' || format_datetime(d.triggered_at, 'yyyy-MM-dd HH:mm') || '</a>' as dispute_tx,
    case q.safe_chain_id when 1 then 'Ethereum' when 100 then 'Gnosis Chain' when 42161 then 'Arbitrum One' when 137 then 'Polygon'
        else 'Chain ' || cast(q.safe_chain_id as varchar) end
        || if(q.covered_chain, '', ' (test traffic)') as safe_chain,
    '<a href="' || q.safe_tx_url || '" target="_blank">0x' || substr(lower(to_hex(q.safe_tx_hash)), 1, 10) || '…</a>' as safe_tx,
    v.sentinel_votes,
    v.secure_votes,
    v.insecure_votes,
    'none: votes differed' as oracle_result,
    case
        when x.source_event = 'DisputeResolved' then 'Ruled'
        when x.source_event = 'DisputeOutOfScope' then 'Out of scope (no ruling)'
        when x.source_event = 'ArbitrationTimedOut' then 'Arbitration timed out (no ruling)'
        else 'Awaiting ruling'
    end as arbitration_status,
    case when x.source_event = 'DisputeResolved' then if(x.verdict = 'approved', 'Secure', 'Insecure') end as ruling,
    case
        when x.context_html is null then null
        when length(x.context_html) > 160 then substr(x.context_html, 1, 160) || '…'
        else x.context_html
    end as arbitrator_context,
    if(x.end_tx_url is null, '', '<a href="' || x.end_tx_url || '" target="_blank">' || format_datetime(x.ended_at, 'yyyy-MM-dd HH:mm') || '</a>') as ruling_tx,
    coalesce(x.slashed, 0) / 1e6 as slashed_usdc,
    if(q.attested_at is null, 'No', 'Yes (unexpected)') as attested,
    q.request_id,
    (select max(block_number) from events) as through_block -- for the verification
from disputes as d
join {{query:safenet_requests}} as q on q.request_id = d.request_id
left join votes as v on v.request_id = d.request_id
left join esc as x on x.request_id = d.request_id
order by d.triggered_at desc
