-- Safenet production attestation set over time: one row per (epoch, validator) for the members of
-- the epoch's FROST group. Definitions: docs/metrics/validators.md#validator_membership. Shared model.
--
-- Members are the participants that confirmed the group's key generation
-- (FROSTCoordinator.KeyGenConfirmed(gid, participant, confirmed)). The coordinator is shared with the
-- Aegis testnet; only groups named by production Consensus (validator_epochs) are kept, so a failed
-- or testnet key generation never adds a member. This is attestation-set membership, separate from
-- registration in the Ethereum Staking contract.

with

confirmed as (
    select
        topic1 as group_id,
        bytearray_substring(data, 13, 20) as validator,
        min(block_time) as confirmed_at
    from gnosis.logs
    where contract_address = 0xc6b34da4c99c043a093214d58423a8be39585b78
        and topic0 = 0x2553b3b5476eaf8b6ccc0c1656cd21552f8e85959654fd47d733f6e94bc65202 -- KeyGenConfirmed
        and block_number >= 48617821
        and block_date >= date '2026-10-06' -- partition pruning; coordinator deployed on 2026-10-06
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
