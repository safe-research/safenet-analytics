-- Safenet production: transaction fees actually collected per UTC day, last 30 days, in USDC.e,
-- with the all-time cumulative total. Gross fees: the fee each request paid into the Sentinel Oracle
-- (the amount recorded in its NewRequest, equal to the USDC.e transfer in the same transaction;
-- scripts/verify-network-revenue.ts checks both). Refunds are shown separately on the day they
-- were paid and do not change gross fees. Includes every request, test traffic too.
-- Not estimated from request counts; no USD values. docs/metrics/network-and-revenue.md#revenue.

with

days as (
    select day from unnest(sequence(current_date - interval '29' day, current_date, interval '1' day)) as t (day)
),

requests as (
    select * from {{query:safenet_requests}}
),

fees as (
    select cast(date_trunc('day', proposed_at) as date) as day, sum(fee) as fee
    from requests
    group by 1
),

refunds as (
    select cast(date_trunc('day', outcome_at) as date) as day, sum(sponsor_refund) as refund
    from requests
    where sponsor_refund > 0
    group by 1
),

-- Fees before the 30-day window, so the running total counts from the first production request.
before_window as (
    select coalesce(sum(fee), 0) as fee from fees where day < current_date - interval '29' day
)

select
    d.day,
    coalesce(f.fee, 0) / 1e6 as gross_fees_usdc,
    coalesce(r.refund, 0) / 1e6 as refunds_usdc,
    (b.fee + sum(coalesce(f.fee, 0)) over (order by d.day rows between unbounded preceding and current row)) / 1e6
        as cumulative_gross_fees_usdc
from days as d
cross join before_window as b
left join fees as f on f.day = d.day
left join refunds as r on r.day = d.day
order by 1
