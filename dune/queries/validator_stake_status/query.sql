-- Safenet active stake now by validator status: what backs the live attestation set, and what does
-- not. Current snapshot. Definitions: docs/metrics/validators.md#stake-backing-the-live-set.
-- Stake amounts are the Staking section's (staking_validators); attestation-set membership is the
-- active epoch's group (validator_membership). The rows add up to all active stake in the contract.

with

current_set as (
    select distinct validator
    from {{query:validator_membership}}
    where epoch_status = 'active'
),

v as (
    select
        s.validator,
        s.name,
        s.total_stake,
        s.staking_status,
        c.validator is not null as member_now
    from {{query:staking_validators}} as s
    left join current_set as c on c.validator = s.validator
    where s.total_stake > 0
),

grouped as (
    select
        case
            when staking_status = 'registered' and member_now then 1
            when staking_status = 'registered' then 2
            else 3
        end as status_group,
        total_stake,
        name
    from v
),

-- one pass: a row per status and the total (grouping set ())
summary as (
    select
        coalesce(status_group, 9) as sort_order,
        sum(total_stake) as stake,
        count(*) as validators,
        array_join(array_agg(name order by total_stake desc), ', ') as names
    from grouped
    group by grouping sets ((status_group), ())
)

select
    case sort_order
        when 1 then 'Backing the live attestation set (registered and in the set)'
        when 2 then 'Registered for staking, not in the attestation set'
        when 3 then 'On validators deregistered from staking'
        else 'Total active stake in the Staking contract'
    end as status,
    stake,
    stake / max(if(sort_order = 9, stake)) over () as share_of_contract_stake,
    validators,
    if(sort_order = 9, null, names) as names,
    sort_order
from summary
order by sort_order
