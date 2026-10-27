-- Safenet outstanding withdrawal requests per validator now: SAFE requested and not yet claimed,
-- waiting or claimable. Current snapshot. Definitions: docs/metrics/validators.md#withdrawal-exposure.
-- Withdrawals and their status follow the Staking section (staking_withdrawals); labels add the
-- validator's attestation-set and staking status.

with

outstanding as (
    select
        validator,
        sum(if(status = 'waiting', amount, 0)) as waiting,
        sum(if(status = 'claimable', amount, 0)) as claimable,
        count(*) as requests,
        min(claimable_at) filter (where status = 'waiting') as next_claimable_at
    from {{query:staking_withdrawals}}
    where status <> 'completed'
    group by 1
),

current_set as (
    select distinct validator from {{query:validator_membership}} where epoch_status = 'active'
)

select
    v.name || case
        when v.staking_status <> 'registered' then ' (deregistered)'
        when c.validator is null then ' (not in attestation set)'
        else ''
    end as validator_label,
    o.waiting,
    o.claimable,
    o.waiting + o.claimable as outstanding,
    o.requests,
    o.next_claimable_at,
    v.total_stake as active_stake,
    (o.waiting + o.claimable) / nullif(v.total_stake + o.waiting + o.claimable, 0) as outstanding_share,
    '0x' || lower(to_hex(o.validator)) as validator_address
from outstanding as o
join {{query:staking_validators}} as v on v.validator = o.validator
left join current_set as c on c.validator = o.validator
order by outstanding desc
