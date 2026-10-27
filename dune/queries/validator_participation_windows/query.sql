-- Safenet validator signing participation over the last 24 hours, 7 days, 30 days and all of
-- production (rolling windows up to the query run). Definitions:
-- docs/metrics/validators.md#observed-signing-participation.
--
--   observed_participation   recognised shares / completed ceremonies of the validator's groups
--                            (eligible); null = no eligible ceremony in the window
--   reward_basis_rate        the reward scripts' basis: recognised shares on attested transactions /
--                            all attested transactions completed in the window, member or not. It
--                            is not a reward period and not settled; it shows the denominator the
--                            payouts use.

with

windows as (
    select * from (
        values
            (1, '24 hours', now() - interval '1' day),
            (2, '7 days', now() - interval '7' day),
            (3, '30 days', now() - interval '30' day),
            (4, 'Production (since 2026-10-07)', timestamp '2026-10-07 13:51:55 UTC')
    ) as t (sort_order, time_window, since)
),

counts as (
    select
        w.sort_order,
        w.time_window,
        c.validator,
        count(*) as eligible,
        count_if(c.signed) as signed,
        count_if(c.purpose = 'transaction' and c.signed) as signed_transactions,
        count_if(c.purpose = 'transaction' and c.first_row) as first_rows_transactions
    from windows as w
    join {{query:validator_ceremonies}} as c
        on c.completed and c.completed_at >= w.since
    group by 1, 2, 3
),

with_totals as (
    select
        *,
        sum(first_rows_transactions) over (partition by sort_order) as transactions
    from counts
)

select
    t.time_window,
    coalesce(l.label, '0x' || lower(to_hex(t.validator))) as validator,
    t.eligible,
    t.signed,
    1.0 * t.signed / t.eligible as observed_participation,
    t.transactions,
    t.signed_transactions,
    if(t.transactions = 0, null, 1.0 * t.signed_transactions / t.transactions) as reward_basis_rate,
    '0x' || lower(to_hex(t.validator)) as address,
    t.sort_order
from with_totals as t
left join {{query:safenet_participant_labels}} as l on l.address = t.validator and l.role = 'validator'
order by t.sort_order, validator
