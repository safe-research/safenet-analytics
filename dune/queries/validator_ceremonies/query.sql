-- Safenet production signing ceremonies: one row per (ceremony, member of its group), with whether
-- that member's signature share counted. Definitions: docs/metrics/validators.md#validator_ceremonies.
-- Shared model.
--
-- Ceremonies are FROSTCoordinator.Sign(initiator, gid, message, sid, sequence) with initiator =
-- production Consensus, on a group of validator_membership. The coordinator is shared with the
-- Aegis testnet; the initiator and the group keep only production.
--   completed   SignCompleted(sid, selectionRoot, signature) exists. Pending ceremonies have no
--               result yet and are no opportunity in any rate.
--   signed      the member has a SignShared(sid, selectionRoot, participant, z) with the selectionRoot
--               of the ceremony's SignCompleted. Shares under any other root are not evidence of
--               signing (warning on SignShared in FROSTCoordinator.sol) and are ignored.
--   purpose     transaction: its signature id is in a TransactionAttested (any oracle), as in the
--               reward scripts (safe-fndn/safenet-staking-scripts src/data/attestations.ts);
--               epoch_rollover: in an EpochStaged; other: neither (yet)
-- An aggregate attestation alone never makes a member "signed". first_row marks one row per ceremony.

with

coordinator as (
    select topic0, topic1, topic2, topic3, data, block_time, block_number, tx_hash
    from gnosis.logs
    where contract_address = 0xc6b34da4c99c043a093214d58423a8be39585b78
        and topic0 in (
            0xb48d242879f9f3df555c800db966f65cba128c7213198748fa202ed54e092691, -- Sign
            0x25a4d6e8d11a9fdc20ffdd826473485ae4cdd453271726c072a16836c1882e7c, -- SignShared
            0x7f1641fa8e46c311f05dc0cb9f69f0ac0f27dd12388a5587c7983de9e99a028d  -- SignCompleted
        )
        and block_number >= 48617821
        and block_date >= date '2026-10-06'
),

-- One pass over the coordinator logs per signature id: the ceremony and its result.
ceremonies as (
    select
        sid,
        max(if(kind = 'sign', group_id)) as group_id,
        max(if(kind = 'sign', block_time)) as initiated_at,
        max(if(kind = 'completed', selection_root)) as selection_root,
        max(if(kind = 'completed', block_time)) as completed_at,
        max(if(kind = 'completed', block_number)) as completed_block,
        max(if(kind = 'completed', tx_hash)) as completed_tx
    from (
        select
            if(topic0 = 0xb48d242879f9f3df555c800db966f65cba128c7213198748fa202ed54e092691, 'sign', 'completed') as kind,
            if(topic0 = 0xb48d242879f9f3df555c800db966f65cba128c7213198748fa202ed54e092691, bytearray_substring(data, 1, 32), topic1) as sid,
            if(topic0 = 0xb48d242879f9f3df555c800db966f65cba128c7213198748fa202ed54e092691, topic2) as group_id,
            if(topic0 = 0x7f1641fa8e46c311f05dc0cb9f69f0ac0f27dd12388a5587c7983de9e99a028d, topic2) as selection_root,
            block_time, block_number, tx_hash
        from coordinator
        where (topic0 = 0xb48d242879f9f3df555c800db966f65cba128c7213198748fa202ed54e092691
                and topic1 = 0x000000000000000000000000c855761d619f6002923507ce68b84d7689c2aa96) -- initiator
            or topic0 = 0x7f1641fa8e46c311f05dc0cb9f69f0ac0f27dd12388a5587c7983de9e99a028d
    )
    group by 1
    having max(if(kind = 'sign', 1)) = 1
),

shares as (
    select
        topic1 as sid,
        topic2 as selection_root,
        bytearray_substring(data, 13, 20) as validator,
        block_time,
        tx_hash
    from coordinator
    where topic0 = 0x25a4d6e8d11a9fdc20ffdd826473485ae4cdd453271726c072a16836c1882e7c
),

-- Signature ids of attested transactions and staged epochs (production Consensus).
purposes as (
    select
        if(topic0 = 0x1980afd018b6bb99a313d3b7a88274259621396f9b8acaa712ef114872977357,
            bytearray_substring(data, 65, 32), bytearray_substring(data, 129, 32)) as sid,
        if(topic0 = 0x1980afd018b6bb99a313d3b7a88274259621396f9b8acaa712ef114872977357, 'transaction', 'epoch_rollover') as purpose,
        block_time as attested_at,
        block_number as attested_block
    from gnosis.logs
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and topic0 in (
            0x1980afd018b6bb99a313d3b7a88274259621396f9b8acaa712ef114872977357, -- TransactionAttested
            0xd22757d0334b80219cf27dedaf82211008f84fc412a29a27e3000dc1c6160b86  -- EpochStaged
        )
        and block_number >= 48635843
        and block_date >= date '2026-10-07'
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
