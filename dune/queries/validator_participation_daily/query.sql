-- Safenet validator signing participation per UTC day, last 30 days, for the heatmap. One row per
-- validator and day with at least one eligible ceremony. Definitions:
-- docs/metrics/validators.md#observed-signing-participation.
--
-- Eligible: completed production signing ceremonies of a group the validator belonged to, by the
-- day of SignCompleted. Signed: the validator's share has the completed selection root. Days
-- without an eligible ceremony (not a member, or no ceremonies) have no row and stay blank, never 0.

select
    cast(c.completed_at as date) as day,
    coalesce(l.label, '0x' || lower(to_hex(c.validator))) as validator,
    '0x' || lower(to_hex(c.validator)) as address,
    count(*) as eligible_ceremonies,
    count_if(c.signed) as signed,
    round(100.0 * count_if(c.signed) / count(*), 1) as participation_pct,
    max(max(c.completed_block)) over () as through_block -- for the verification
from {{query:validator_ceremonies}} as c
left join {{query:safenet_participant_labels}} as l on l.address = c.validator and l.role = 'validator'
where c.completed
    and c.completed_at >= date_trunc('day', now()) - interval '29' day
group by 1, 2, 3
order by day desc, validator
