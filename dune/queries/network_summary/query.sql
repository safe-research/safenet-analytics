-- Safenet production: network activity and fee totals for the last 24 hours, 7 days, 30 days and
-- all time (production only; Beta is a different network and is not read). Definitions:
-- docs/metrics/network-and-revenue.md. One row per window, all time first (the counters read it).
--
-- Flows are counted when they happen: requests at proposal, completed results at their verdict,
-- Sentinel responses at reveal, attestations at attestation, fees at payment, refunds when paid.
-- Activity columns cover Safes on the Charter's chains (Ethereum, Gnosis Chain, Arbitrum One) and
-- include Safenet's own operational Safes (operational_requests); requests for Safes on other
-- chains are likely tests and only counted in test_requests. Fee columns are money actually
-- collected or refunded and include every request, test traffic too.

with

requests as (
    select * from {{query:safenet_requests}}
),

attestations as (
    select block_time from {{query:safenet_events}}
    where event = 'attestation' and covered_chain
),

responses as (
    select block_time from {{query:safenet_events}}
    where event = 'revealed' and covered_chain
),

windows as (
    select * from (
        values
            ('All time', 1, timestamp '2026-10-07 00:00:00 UTC'), -- before the first production event
            ('Last 30 days', 2, now() - interval '30' day),
            ('Last 7 days', 3, now() - interval '7' day),
            ('Last 24 hours', 4, now() - interval '24' hour)
    ) as t (time_window, sort_order, since)
),

freshness as (
    select max(time) as gnosis_data_as_of from gnosis.blocks where time > now() - interval '2' day
),

-- Highest Gnosis block among the events read; the verification recounts up to exactly this block.
bound as (
    select max(block_number) as through_block from {{query:safenet_events}}
),

safe_key as (
    select
        *,
        cast(safe_chain_id as varchar) || ':' || lower(to_hex(safe_address)) as safe_id_key,
        cast(safe_chain_id as varchar) || ':' || lower(to_hex(safe_address)) || ':' || lower(to_hex(safe_tx_hash)) as safe_tx_key
    from requests
),

request_totals as (
    select
        w.time_window,
        count_if(r.covered_chain and r.proposed_at >= w.since) as requests,
        count(distinct if(r.covered_chain and r.proposed_at >= w.since, r.safe_tx_key)) as unique_safe_transactions,
        count_if(r.covered_chain and r.completed and r.completed_at >= w.since) as completed_results,
        count(distinct if(r.covered_chain and r.proposed_at >= w.since, r.safe_id_key)) as safes_with_requests,
        count(distinct if(r.covered_chain and r.completed and r.completed_at >= w.since, r.safe_id_key)) as safes_with_completed_checks,
        count_if(r.traffic_class = 'operational' and r.proposed_at >= w.since) as operational_requests,
        count_if(not r.covered_chain and r.proposed_at >= w.since) as test_requests,
        coalesce(sum(if(r.proposed_at >= w.since, r.fee)), 0) / 1e6 as gross_fees_usdc,
        coalesce(sum(if(r.outcome_at >= w.since, r.sponsor_refund)), 0) / 1e6 as refunds_usdc,
        max(r.proposed_at) as latest_request_at
    from windows as w
    cross join safe_key as r
    group by 1
),

attestation_totals as (
    select w.time_window, count_if(a.block_time >= w.since) as attestations
    from windows as w
    cross join attestations as a
    group by 1
),

response_totals as (
    select w.time_window, count_if(s.block_time >= w.since) as sentinel_responses
    from windows as w
    cross join responses as s
    group by 1
)

select
    w.time_window,
    coalesce(r.requests, 0) as requests,
    coalesce(r.unique_safe_transactions, 0) as unique_safe_transactions,
    coalesce(s.sentinel_responses, 0) as sentinel_responses,
    coalesce(r.completed_results, 0) as completed_results,
    coalesce(a.attestations, 0) as attestations,
    coalesce(r.safes_with_requests, 0) as safes_with_requests,
    coalesce(r.safes_with_completed_checks, 0) as safes_with_completed_checks,
    coalesce(r.operational_requests, 0) as operational_requests,
    coalesce(r.test_requests, 0) as test_requests,
    coalesce(r.gross_fees_usdc, 0) as gross_fees_usdc,
    coalesce(r.refunds_usdc, 0) as refunds_usdc,
    f.gnosis_data_as_of,
    r.latest_request_at,
    now() as computed_at,
    b.through_block
from windows as w
cross join freshness as f
cross join bound as b
left join request_totals as r on r.time_window = w.time_window
left join attestation_totals as a on a.time_window = w.time_window
left join response_totals as s on s.time_window = w.time_window
order by w.sort_order
