-- Safenet production: transaction-check requests, completed checks and attestations per UTC day,
-- for the last 30 days (zero-filled). Definitions, sources and limitations:
-- docs/metrics/transaction-checks.md and docs/metrics/network-and-revenue.md.
-- Events are decoded once, in safenet_events (production contracts on Gnosis Chain).
--
-- Rows are ordered newest first. requests_cumulative on the first row is the all-time request
-- count shown by the counter, summed over every day before the 30-day window is applied, from the
-- same execution as the chart. through_block is the highest Gnosis block among the events read;
-- the verification recounts up to exactly that block.

with

events as (
    select * from {{query:safenet_events}}
    -- lifecycle events only: disputes, votes, claims and governance events are counted elsewhere
    where event in ('request', 'approved', 'denied', 'no_verdict', 'attestation')
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
),

days as (
    select day from unnest(sequence(
        least(current_date - interval '29' day, (select min(day) from daily)), current_date, interval '1' day
    )) as t (day)
),

filled as (
    select
        d.day,
        coalesce(x.requests, 0) as requests,
        coalesce(x.completed_checks, 0) as completed_checks,
        coalesce(x.checks_approved, 0) as checks_approved,
        coalesce(x.checks_denied, 0) as checks_denied,
        coalesce(x.closed_without_verdict, 0) as closed_without_verdict,
        coalesce(x.attestations, 0) as attestations,
        coalesce(x.uncovered_chain_requests, 0) as uncovered_chain_requests,
        coalesce(x.uncovered_chain_completed_checks, 0) as uncovered_chain_completed_checks,
        coalesce(x.uncovered_chain_attestations, 0) as uncovered_chain_attestations,
        coalesce(x.unmatched_events, 0) as unmatched_events
    from days as d
    left join daily as x on x.day = d.day
),

with_totals as (
    select
        *,
        sum(requests) over (order by day rows between unbounded preceding and current row) as requests_cumulative
    from filled
)

select
    *,
    (select max(block_number) from events) as through_block
from with_totals
where day >= current_date - interval '29' day
order by day desc
