-- Safenet validators in the Staking contract, one row per validator ever registered there or holding
-- stake. Definitions: docs/metrics/staking.md#staking_validators. Shared model.
--
--   staking_status    registered / deregistered (registered before, not now) / never registered:
--                     from ValidatorUpdated in the Staking contract.
--                     Stake on a deregistered validator stays until withdrawn; it is reported, not
--                     dropped, and does not back a registered validator. Neither status says whether
--                     the validator is in the live consensus validator set.
--   staker            registered staker (Consensus.ValidatorStakerSet); null if none
--   self_stake        the registered staker's stake on this validator; null when no staker is set
--   delegated_stake   everyone else's stake (all stake when no staker is set)
--   name              label from safe-fndn/safenet-data, else the address (labels are not membership)

with

registration as (
    select
        validator,
        max_by(is_registered, block_number * 100000 + log_index) as is_registered,
        max(block_time) as status_since,
        min(if(is_registered, block_time)) as first_registered_at
    from {{query:staking_events}}
    where event = 'validator_updated'
    group by 1
),

stake as (
    select
        validator,
        sum(active_stake_raw) as total_stake_raw,
        sum(if(is_self_stake, active_stake_raw, 0)) as self_stake_raw,
        count(*) as stakers
    from {{query:staking_positions}}
    group by 1
),

validators as (
    select validator from registration
    union
    select validator from stake
),

labels as (
    select address, source_address, label from {{query:safenet_participant_labels}} where role = 'validator'
)

select
    v.validator,
    coalesce(l.label, '0x' || lower(to_hex(v.validator))) as name,
    l.source_address,
    case
        when r.is_registered then 'registered'
        when r.first_registered_at is not null then 'deregistered'
        else 'never registered' -- e.g. a deregistration without an earlier registration
    end as staking_status,
    r.status_since,
    r.first_registered_at,
    k.staker,
    coalesce(cast(s.total_stake_raw as double), 0) / 1e18 as total_stake,
    if(k.staker is null, null, coalesce(cast(s.self_stake_raw as double), 0) / 1e18) as self_stake,
    (coalesce(cast(s.total_stake_raw as double), 0) - if(k.staker is null, 0, coalesce(cast(s.self_stake_raw as double), 0))) / 1e18 as delegated_stake,
    coalesce(s.total_stake_raw, 0) as total_stake_raw,
    coalesce(s.stakers, 0) as stakers,
    'https://etherscan.io/address/0x' || lower(to_hex(v.validator)) as validator_url,
    if(k.staker is null, null, 'https://etherscan.io/address/0x' || lower(to_hex(k.staker))) as staker_url
from validators as v
left join registration as r on r.validator = v.validator
left join stake as s on s.validator = v.validator
left join {{query:staking_validator_stakers}} as k on k.validator = v.validator
left join labels as l on l.address = v.validator
