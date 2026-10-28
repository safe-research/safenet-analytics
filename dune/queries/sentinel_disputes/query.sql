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
-- ruling. Reasons and context are shown as recorded on chain (safenet_sentinel_texts, HTML
-- escaped); nothing is added when none was recorded. All disputes are listed, test traffic marked.
--
-- Timing (docs/metrics/sentinels.md#arbitration-rate-and-resolution-time): the request's proposal,
-- the dispute (DisputeTriggered, the freeze), the terminal outcome (ruling, out of scope or
-- arbitration timeout), the hours from freeze to ruling for ruled cases only, and for cases still
-- awaiting an outcome the hours since the freeze as of the execution (computed_at).

with

texts as (
    select
        request_id,
        max(if(source_event <> 'Revealed', text)) as context,
        array_agg(sentinel) filter (where source_event = 'Revealed') as reason_sentinel,
        array_agg(text) filter (where source_event = 'Revealed') as reason_text
    from {{query:safenet_sentinel_texts}}
    group by 1
),

-- Proposals and attestations, read once (the Sentinel queries keep safenet_events reads to three:
-- test/safenet.test.ts). Same request events as safenet_requests.
lifecycle_events as (
    select event, request_id, safe_tx_hash, epoch, block_time, tx_url
    from {{query:safenet_events}}
    where event in ('request', 'attestation')
),

-- Each committed Sentinel's own vote and recorded reason.
votes as (
    select
        r.*,
        if(coalesce(array_position(x.reason_sentinel, r.sentinel), 0) > 0,
            element_at(x.reason_text, array_position(x.reason_sentinel, r.sentinel))) as reason,
        x.context
    from {{query:safenet_sentinel_responses}} as r
    left join texts as x on x.request_id = r.request_id
    where r.disputed and r.committed_at is not null
),

disputes as (
    select
        request_id,
        max(disputed_at) as disputed_at,
        max(dispute_tx_url) as dispute_tx_url,
        max(safe_chain_id) as safe_chain_id,
        bool_or(covered_chain) as covered_chain,
        max(safe_tx_hash) as safe_tx_hash,
        max(epoch) as epoch,
        max(safe_tx_url) as safe_tx_url,
        max(verdict) as verdict,
        max(outcome_event) as outcome_event,
        max(outcome_at) as outcome_at,
        max(outcome_tx_url) as outcome_tx_url,
        max(dispute_slashed) as slashed,
        max(context) as context,
        array_join(array_agg(
            name || ': ' || case response_state
                when 'secure' then 'secure'
                when 'insecure' then 'insecure'
                when 'missing_response' then 'no reveal (missing response)'
                else 'reveal pending'
            end
            || if(reason is not null, ' (' || replace(replace(reason, '<', '&lt;'), '>', '&gt;') || ')', '')
            order by response_state, name
        ), '; ') as sentinel_votes,
        count_if(response_state = 'secure') as secure_votes,
        count_if(response_state = 'insecure') as insecure_votes,
        max(through_block) as through_block
    from votes
    group by 1
),

lifecycle as (
    select
        d.request_id,
        max(if(e.event = 'request', e.block_time)) as proposed_at,
        max(if(e.event = 'request', e.tx_url)) as proposal_tx_url,
        bool_or(e.event = 'attestation') as attested
    from disputes as d
    join lifecycle_events as e
        on (e.event = 'request' and e.request_id = d.request_id)
        or (e.event = 'attestation' and e.safe_tx_hash = d.safe_tx_hash and e.epoch = d.epoch)
    group by 1
)

select
    d.disputed_at as triggered_at,
    l.proposed_at,
    '<a href="' || l.proposal_tx_url || '" target="_blank">' || format_datetime(l.proposed_at, 'yyyy-MM-dd HH:mm') || '</a>' as proposal_tx,
    '<a href="' || d.dispute_tx_url || '" target="_blank">' || format_datetime(d.disputed_at, 'yyyy-MM-dd HH:mm') || '</a>' as dispute_tx,
    case d.safe_chain_id when 1 then 'Ethereum' when 100 then 'Gnosis Chain' when 42161 then 'Arbitrum One' when 137 then 'Polygon'
        else 'Chain ' || cast(d.safe_chain_id as varchar) end
        || if(d.covered_chain, '', ' (test traffic)') as safe_chain,
    '<a href="' || d.safe_tx_url || '" target="_blank">0x' || substr(lower(to_hex(d.safe_tx_hash)), 1, 10) || '…</a>' as safe_tx,
    d.sentinel_votes,
    d.secure_votes,
    d.insecure_votes,
    'none: votes differed' as oracle_result,
    case
        when d.outcome_event = 'DisputeResolved' then 'Ruled'
        when d.outcome_event = 'DisputeOutOfScope' then 'Out of scope (no ruling)'
        when d.outcome_event = 'ArbitrationTimedOut' then 'Arbitration timed out (no ruling)'
        else 'Awaiting ruling'
    end as arbitration_status,
    case when d.outcome_event = 'DisputeResolved' then if(d.verdict = 'approved', 'Secure', 'Insecure') end as ruling,
    case
        when d.context is null then null
        when length(d.context) > 160 then replace(replace(substr(d.context, 1, 160), '<', '&lt;'), '>', '&gt;') || '…'
        else replace(replace(d.context, '<', '&lt;'), '>', '&gt;')
    end as arbitrator_context,
    if(d.outcome_tx_url is null, '', '<a href="' || d.outcome_tx_url || '" target="_blank">' || format_datetime(d.outcome_at, 'yyyy-MM-dd HH:mm') || '</a>') as ruling_tx,
    d.outcome_at,
    if(d.outcome_event = 'DisputeResolved', date_diff('millisecond', d.disputed_at, d.outcome_at) / 3600000e0) as hours_to_ruling,
    if(d.outcome_event is null, date_diff('millisecond', d.disputed_at, now()) / 3600000e0) as open_hours,
    d.slashed / 1e6 as slashed_usdc,
    if(coalesce(l.attested, false), 'Yes (unexpected)', 'No') as attested,
    d.request_id,
    now() as computed_at,
    d.through_block -- for the verification
from disputes as d
left join lifecycle as l on l.request_id = d.request_id
order by d.disputed_at desc
