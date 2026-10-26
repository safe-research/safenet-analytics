-- Safenet active stake by validator, now: self-stake and delegated stake. Current state, independent
-- of the history charts. Definitions: docs/metrics/staking.md#stake-by-validator.
--
-- Self-stake is the stake of the validator's registered staker (Consensus.ValidatorStakerSet), never
-- inferred from names. Series, so every SAFE of active stake appears exactly once:
--   self_stake             registered validator, its registered staker's stake
--   delegated_stake        registered validator, everyone else's stake
--   unattributed_stake     registered validator without a registered staker: self/delegated unknown
--   deregistered_stake     validator deregistered in the Staking contract: stake not yet withdrawn,
--                          not backing a registered validator
-- The rows add up to the headline active stake; share_of_active_stake sums to 1 and
-- unreconciled_stake (the same on every row) is expected 0. The verification checks both.

with

v as (
    select * from {{query:staking_validators}}
    where total_stake_raw > 0 or staking_status = 'registered'
),

rows_ as (
    select
        name || if(staking_status = 'registered', '', ' (' || staking_status || ')') as validator_label,
        '<a href="' || validator_url || '" target="_blank">' || name || '</a>' as validator,
        staking_status,
        if(staker is null, 'not registered',
            '<a href="' || staker_url || '" target="_blank">0x' || substr(lower(to_hex(staker)), 1, 4) || '…'
                || substr(lower(to_hex(staker)), 37, 4) || '</a>') as registered_staker,
        if(staking_status = 'registered' and staker is not null, self_stake, 0) as self_stake,
        if(staking_status = 'registered' and staker is not null, delegated_stake, 0) as delegated_stake,
        if(staking_status = 'registered' and staker is null, total_stake, 0) as unattributed_stake,
        if(staking_status <> 'registered', total_stake, 0) as deregistered_stake,
        self_stake as self_stake_any_status,
        if(staker is null, null, total_stake - self_stake) as delegated_stake_any_status,
        total_stake,
        total_stake_raw,
        stakers,
        '0x' || lower(to_hex(validator)) as validator_address
    from v
),

headline as (
    select sum(active_stake_raw) as active_raw from {{query:staking_positions}}
)

select
    validator_label, validator, staking_status, registered_staker,
    self_stake, delegated_stake, unattributed_stake, deregistered_stake, self_stake_any_status,
    delegated_stake_any_status, total_stake,
    total_stake / (cast(h.active_raw as double) / 1e18) as share_of_active_stake,
    stakers,
    validator_address,
    (sum(cast(total_stake_raw as double)) over () - cast(h.active_raw as double)) / 1e18 as unreconciled_stake
from rows_
cross join headline as h
order by total_stake desc, validator_label
