-- Safenet Aegis attestation set over time: one row per (epoch, validator) for the members of
-- the epoch's FROST group. Definitions: docs/metrics/validators.md#validator_membership. Shared model.
--
-- Members are the participants that confirmed the group's key generation
-- (FROSTCoordinator.KeyGenConfirmed(gid, participant, confirmed)). The coordinator is shared with the
-- Aegis testnet; only groups named by Aegis Consensus (validator_epochs) are kept, so a failed
-- or testnet key generation never adds a member. This is attestation-set membership, separate from
-- registration in the Ethereum Staking contract. Reads Dune's decoded FROSTCoordinator tables
-- (docs/decoding.md).

with

confirmed as (
    select
        gid as group_id,
        participant as validator,
        min(evt_block_time) as confirmed_at
    from safe_gnosis.SafenetAegisFROSTCoordinator_evt_KeyGenConfirmed
    where contract_address = 0xc6b34da4c99c043a093214d58423a8be39585b78
        and evt_block_number >= 48617821
    group by 1, 2
)

select
    e.epoch,
    e.group_id,
    c.validator,
    c.confirmed_at,
    e.active_from_block,
    e.active_to_block,
    e.active_from,
    e.active_to,
    e.status as epoch_status,
    e.as_of_block,
    e.as_of_time
from {{query:validator_epochs}} as e
join confirmed as c on c.group_id = e.group_id
