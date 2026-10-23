-- Safenet production: transaction-check requests, completed checks and attestations per UTC day.
-- Definitions, sources and limitations: docs/metrics/transaction-checks.md
-- Events are decoded once, in safenet_events (production contracts on Gnosis Chain).
--
-- Rows are ordered newest first. requests_cumulative on the first row is the all-time request
-- count shown by the counter, from the same execution as the chart. through_block is the highest
-- Gnosis block among the events read; the verification recounts up to exactly that block.

with

events as (
    select * from {{query:safenet_events}}
    where event <> 'dispute' -- disputes are not an outcome; the request still ends in one
),

daily as (
    select
        cast(date_trunc('day', block_time) as date) as day,
        count_if(event = 'request' and covered_chain) as requests,
        count_if(event in ('approved', 'denied') and covered_chain) as completed_checks,
        count_if(event = 'approved' and covered_chain) as checks_approved,
        count_if(event = 'denied' and covered_chain) as checks_denied,
        count_if(event = 'no_verdict' and covered_chain) as closed_without_verdict,
        count_if(event = 'attestation' and covered_chain) as attestations,
        count_if(event = 'request' and not covered_chain) as uncovered_chain_requests,
        count_if(event in ('approved', 'denied') and not covered_chain) as uncovered_chain_completed_checks,
        count_if(event = 'attestation' and not covered_chain) as uncovered_chain_attestations,
        -- Should always be 0: outcomes without a matching request, or requests without an oracle request.
        count_if(covered_chain is null) as unmatched_events
    from events
    group by 1
)

select
    *,
    sum(requests) over (order by day rows between unbounded preceding and current row) as requests_cumulative,
    (select max(block_number) from events) as through_block
from daily
order by day desc
