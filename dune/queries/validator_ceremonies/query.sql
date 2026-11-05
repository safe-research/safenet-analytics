-- Safenet Aegis signing ceremonies: one row per (ceremony, member of its group), with whether
-- that member's signature share counted. Definitions: docs/metrics/validators.md#validator_ceremonies.
-- Shared model.
--
-- Ceremonies are FROSTCoordinator.Sign(initiator, gid, message, sid, sequence) with initiator =
-- Aegis Consensus, on a group of validator_membership. The coordinator is shared with the
-- Aegis testnet; the initiator and the group keep only Aegis.
--   completed   SignCompleted(sid, selectionRoot, signature) exists. Pending ceremonies have no
--               result yet and are no opportunity in any rate.
--   signed      the member has a SignShared(sid, selectionRoot, participant, z) with the selectionRoot
--               of the ceremony's SignCompleted. Shares under any other root are not evidence of
--               signing (warning on SignShared in FROSTCoordinator.sol) and are ignored.
--   purpose     transaction: its signature id is in a TransactionAttested (any oracle), as in the
--               reward scripts (safe-fndn/safenet-staking-scripts src/data/attestations.ts);
--               epoch_rollover: in an EpochStaged; other: neither (yet)
-- An aggregate attestation alone never makes a member "signed". first_row marks one row per ceremony.
-- Reads Dune's decoded FROSTCoordinator and Consensus tables (docs/decoding.md).

with

-- One row per signature id: the ceremony (Sign by Aegis Consensus) and its result. The
-- coordinator is shared with the Aegis testnet; ceremonies need an Aegis Sign.
ceremonies as (
    select
        sid,
        max(group_id) as group_id,
        max(initiated_at) as initiated_at,
        max(selection_root) as selection_root,
        max(completed_at) as completed_at,
        max(completed_block) as completed_block,
        max(completed_tx) as completed_tx
    from (
        select sid, gid as group_id, evt_block_time as initiated_at,
            cast(null as varbinary) as selection_root, cast(null as timestamp(3) with time zone) as completed_at,
            cast(null as bigint) as completed_block, cast(null as varbinary) as completed_tx, 1 as is_sign
        from safe_gnosis.SafenetAegisFROSTCoordinator_evt_Sign
        where contract_address = 0xc6b34da4c99c043a093214d58423a8be39585b78
            and initiator = 0xc855761d619f6002923507ce68b84d7689c2aa96 -- Aegis Consensus
            and evt_block_number >= 48617821
        union all
        select sid, null, null, selectionRoot, evt_block_time, evt_block_number, evt_tx_hash, 0
        from safe_gnosis.SafenetAegisFROSTCoordinator_evt_SignCompleted
        where contract_address = 0xc6b34da4c99c043a093214d58423a8be39585b78
            and evt_block_number >= 48617821
    )
    group by 1
    having max(is_sign) = 1
),

shares as (
    select
        sid,
        selectionRoot as selection_root,
        participant as validator,
        evt_block_time as block_time,
        evt_tx_hash as tx_hash
    from safe_gnosis.SafenetAegisFROSTCoordinator_evt_SignShared
    where contract_address = 0xc6b34da4c99c043a093214d58423a8be39585b78
        and evt_block_number >= 48617821
),

-- Signature ids of attested transactions and staged epochs (Aegis Consensus).
purposes as (
    select signatureId as sid, 'transaction' as purpose, evt_block_time as attested_at, evt_block_number as attested_block
    from safe_gnosis.SafenetAegisConsensus_evt_TransactionAttested
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and evt_block_number >= 48635843
    union all
    select signatureId, 'epoch_rollover', evt_block_time, evt_block_number
    from safe_gnosis.SafenetAegisConsensus_evt_EpochStaged
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and evt_block_number >= 48635843
),

groups as (
    select group_id, validator, min(epoch) as epoch from {{query:validator_membership}} group by 1, 2
)

select
    c.sid,
    c.group_id,
    g.epoch,
    g.validator,
    c.initiated_at,
    c.completed_at is not null as completed,
    c.completed_at,
    c.completed_block,
    c.completed_tx,
    'https://gnosisscan.io/tx/0x' || lower(to_hex(c.completed_tx)) as completed_tx_url,
    coalesce(p.purpose, 'other') as purpose,
    p.attested_at,
    p.attested_block,
    s.validator is not null as signed,
    s.block_time as signed_at,
    s.tx_hash as share_tx,
    'https://gnosisscan.io/tx/0x' || lower(to_hex(s.tx_hash)) as share_tx_url,
    -- exactly one row per ceremony has this, for counting ceremonies without count(distinct)
    row_number() over (partition by c.sid order by g.validator) = 1 as first_row
from ceremonies as c
join groups as g on g.group_id = c.group_id
left join purposes as p on p.sid = c.sid
left join shares as s
    on s.sid = c.sid
    and s.validator = g.validator
    and s.selection_root = c.selection_root
