-- Parity check before replacing the raw-log decoding in safenet_events with Dune's decoded tables
-- (docs/decoding.md). Run on Dune as an unsaved query once the contracts are decoded.
--
-- 1. Replace the table names below with the ones `npm run dune -- check-decoded` reports. Dune
--    names decoded event tables <namespace>_gnosis.<Contract>_evt_<Event>. The names used here
--    assume namespace "safenet".
-- 2. Replace query_<SAFENET_EVENTS_ID> with the production ID of safenet_events (dune/state.json).
-- 3. Set the block range. from_block must be the deploy block, so the decoded tables are shown
--    to cover the full history; to_block must be at least a day old.
--
-- Every row of the result is a difference. The replacement may only be merged when the result is
-- empty for the full range from the deploy blocks.

with

params as (
    select 48635843 as from_block, 0 /* TO_BLOCK */ as to_block
),

raw as (
    select event, block_number, tx_hash, log_index, request_id, safe_tx_hash, safe_chain_id, safe_address, epoch
    from query_0 /* SAFENET_EVENTS_ID */, params
    where block_number between from_block and to_block
        and event in ('request', 'attestation')
),

decoded as (
    select
        'request' as event, p.evt_block_number as block_number, p.evt_tx_hash as tx_hash, p.evt_index as log_index,
        r.requestId as request_id, p.safeTxHash as safe_tx_hash,
        bytearray_to_bigint(bytearray_substring(p.safeId, 5, 8)) as safe_chain_id,
        bytearray_substring(p.safeId, 13, 20) as safe_address,
        cast(p.epoch as bigint) as epoch
    from safenet_gnosis.Consensus_evt_TransactionProposed as p
    cross join params
    -- The n-th proposal of a transaction pairs with the n-th oracle request, as in safenet_events.
    left join (
        select evt_tx_hash, requestId, row_number() over (partition by evt_tx_hash order by evt_index) as n
        from safenet_gnosis.SentinelOracle_evt_NewRequest
    ) as r
        on r.evt_tx_hash = p.evt_tx_hash
        and r.n = (select count(*) from safenet_gnosis.Consensus_evt_TransactionProposed as q
                   where q.evt_tx_hash = p.evt_tx_hash and q.evt_index <= p.evt_index
                       and q.oracle = 0x4f61b8832978e83b80d69551aef07557dbe41d03)
    where p.contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and p.oracle = 0x4f61b8832978e83b80d69551aef07557dbe41d03
        and p.evt_block_number between from_block and to_block
    union all
    select
        'attestation', a.evt_block_number, a.evt_tx_hash, a.evt_index,
        cast(null as varbinary), a.safeTxHash,
        bytearray_to_bigint(bytearray_substring(a.safeId, 5, 8)),
        bytearray_substring(a.safeId, 13, 20),
        cast(a.epoch as bigint)
    from safenet_gnosis.Consensus_evt_TransactionAttested as a
    cross join params
    where a.contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and a.oracle = 0x4f61b8832978e83b80d69551aef07557dbe41d03
        and a.evt_block_number between from_block and to_block
)

-- The oracle outcome events (OracleResult, DisputeResolved, RequestTimedOut, DisputeOutOfScope,
-- ArbitrationTimedOut, DisputeTriggered) are compared the same way: add them to both sides with
-- their request_id and the event column as decoded in safenet_events.
select 'only in raw logs' as difference, * from (select * from raw except all select * from decoded)
union all
select 'only in decoded tables' as difference, * from (select * from decoded except all select * from raw)
order by block_number, log_index
