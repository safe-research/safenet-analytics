-- Safenet production epochs (Gnosis Chain), one row per epoch with the FROST group that attests in it.
-- Definitions: docs/metrics/validators.md#validator_epochs. Shared model. Reads Dune's decoded
-- Consensus tables (docs/decoding.md).
--
-- Epoch 0 uses the genesis group passed to the Consensus constructor (getEpochGroupId(0)); its key
-- was generated on 2026-10-14, so nothing could be attested before. Every later epoch is staged by
-- EpochStaged(activeEpoch, proposedEpoch, rolloverBlock, groupId, groupKey, signatureId,
-- attestation) and becomes active at its rolloverBlock (Consensus._epochsWithRollover; the later
-- EpochRolledOver event is lazy bookkeeping). An epoch is active until the next one's rolloverBlock.
--   status   active / past / staged (rolloverBlock not reached yet), at the Gnosis head

with

staged as (
    select
        cast(proposedEpoch as bigint) as epoch,
        cast(rolloverBlock as bigint) as active_from_block,
        groupId as group_id,
        signatureId as rollover_signature_id,
        evt_block_time as staged_at,
        evt_tx_hash as staged_tx
    from safe_gnosis.SafenetAegisConsensus_evt_EpochStaged
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and evt_block_number >= 48635843
),

epochs as (
    select
        cast(0 as bigint) as epoch,
        cast(48635843 as bigint) as active_from_block, -- Consensus deployment
        0x965f661dcdfa091ff92d5f6a81877bb714b87aa17507b3270000000000000000 as group_id,
        cast(null as varbinary) as rollover_signature_id,
        cast(null as timestamp(3) with time zone) as staged_at,
        cast(null as varbinary) as staged_tx
    union all
    select epoch, active_from_block, group_id, rollover_signature_id, staged_at, staged_tx from staged
),

head as (
    select max(number) as as_of_block, max(time) as as_of_time
    from gnosis.blocks
    where time > now() - interval '2' day
),

bounds as (
    select
        e.*,
        lead(e.active_from_block) over (order by e.active_from_block) as active_to_block -- exclusive
    from epochs as e
),

times as (
    select number, time
    from gnosis.blocks
    where date >= date '2026-10-07'
        and number in (select active_from_block from epochs)
)

select
    b.epoch,
    b.group_id,
    b.active_from_block,
    b.active_to_block,
    f.time as active_from,
    t.time as active_to,
    case
        when b.active_from_block > h.as_of_block then 'staged'
        when b.active_to_block is null or b.active_to_block > h.as_of_block then 'active'
        else 'past'
    end as status,
    b.rollover_signature_id,
    b.staged_at,
    b.staged_tx,
    h.as_of_block,
    h.as_of_time
from bounds as b
cross join head as h
left join times as f on f.number = b.active_from_block
left join times as t on t.number = b.active_to_block
