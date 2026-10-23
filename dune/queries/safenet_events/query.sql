-- Safenet production ("Aegis") events on Gnosis Chain: one row per event, decoded from raw logs.
-- This is the only query that decodes contract events. Metric queries read it through a managed
-- query reference (src/config.ts). Replacing it with Dune's decoded tables: docs/decoding.md.
-- Contracts, event signatures and topic0 values: src/safenet.ts, checked in test/safenet.test.ts.
--   Consensus       0xc855761D619f6002923507cE68B84d7689C2aa96 (deployed at block 48635843)
--   SentinelOracle  0x4F61B8832978e83b80D69551AEf07557DBE41d03 (deployed at block 48635850)
--
-- event                one row per
--   request            production proposal: Consensus.TransactionProposed with oracle = production
--                      SentinelOracle, paired with its SentinelOracle.NewRequest (request_id)
--   approved, denied   verdict: OracleResult, or DisputeResolved after a dispute
--   no_verdict         RequestTimedOut, DisputeOutOfScope, ArbitrationTimedOut
--   dispute            DisputeTriggered (not an outcome; the request continues to one of the above)
--   attestation        Consensus.TransactionAttested with oracle = production SentinelOracle
--
-- covered_chain: the Safe is on a chain the Charter covers (Ethereum, Gnosis Chain, Arbitrum One).
-- Other chains are likely test traffic. It is null when an event cannot be matched: a proposal
-- without an oracle request, or an outcome or dispute without a production request.
-- URL columns: see src/links.ts.

with

-- topic1 = safeTxHash, topic2 = safeId (chainId in the top 12 bytes, Safe in the low 20),
-- topic3 = oracle, data word 0 = epoch (uint64).
proposals as (
    select
        block_time,
        block_number,
        tx_hash,
        "index" as log_index,
        topic1 as safe_tx_hash,
        topic2 as safe_id,
        bytearray_to_bigint(bytearray_substring(data, 25, 8)) as epoch,
        row_number() over (partition by tx_hash order by "index") as n
    from gnosis.logs
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and topic0 = 0x47d867ce4d91d0487fa4d2ac80b13e7466ce53dd018a8eef564fc60c92b53d03 -- TransactionProposed
        and topic3 = 0x0000000000000000000000004f61b8832978e83b80d69551aef07557dbe41d03
        and block_number >= 48635843
        and block_date >= date '2026-10-07' -- partition pruning; the contracts were deployed on 2026-10-07
),

-- NewRequest: topic1 = requestId (the EIP-712 proposal message), topic2 = sponsor.
-- Emitted in the same transaction as, and after, its TransactionProposed, so the n-th proposal
-- of a transaction pairs with the n-th request of that transaction.
oracle_requests as (
    select
        tx_hash,
        topic1 as request_id,
        bytearray_substring(topic2, 13, 20) as sponsor,
        row_number() over (partition by tx_hash order by "index") as n
    from gnosis.logs
    where contract_address = 0x4f61b8832978e83b80d69551aef07557dbe41d03
        and topic0 = 0x8ec61272960f97d43d7f8f85ed630aa512818577f3d1e548e7627b06dbbbda86 -- NewRequest
        and block_number >= 48635850
        and block_date >= date '2026-10-07'
),

requests as (
    select p.*, r.request_id, r.sponsor
    from proposals as p
    left join oracle_requests as r
        on r.tx_hash = p.tx_hash
        and r.n = p.n
),

-- Terminal outcomes (each request ends in exactly one) and dispute triggers; topic1 = requestId.
oracle_events as (
    select
        block_time,
        block_number,
        tx_hash,
        "index" as log_index,
        topic1 as request_id,
        case
            when topic0 = 0x7843c453c4f7442b00e1bf3873e741f18f3447e18a13304c58bef95efd311757 -- OracleResult(bytes result, bool approved)
                then if(bytearray_substring(data, 64, 1) = 0x01, 'approved', 'denied')
            when topic0 = 0x7e739d167696b2e67be44f7ceb3afa7ad9e8ad5ee53d016de97ae7ab0b416a70 -- DisputeResolved(uint8 outcome, ...): 3 approved, 4 denied
                then if(bytearray_substring(data, 32, 1) = 0x03, 'approved', 'denied')
            when topic0 = 0x86e8b85731e4787f033d85108356db1e068dea243be32d422e6dc5681ff49cc1 -- DisputeTriggered
                then 'dispute'
            else 'no_verdict' -- RequestTimedOut, DisputeOutOfScope, ArbitrationTimedOut
        end as event
    from gnosis.logs
    where contract_address = 0x4f61b8832978e83b80d69551aef07557dbe41d03
        and topic0 in (
            0x7843c453c4f7442b00e1bf3873e741f18f3447e18a13304c58bef95efd311757, -- OracleResult
            0x7e739d167696b2e67be44f7ceb3afa7ad9e8ad5ee53d016de97ae7ab0b416a70, -- DisputeResolved
            0xf1ca1e9147be737b04a2b018a79405f687a97de8dd8a2559bbe62357343af414, -- RequestTimedOut
            0xe32b95dcf423c9ed3915554e30a0db65ad08358b5e5bdb1138c98dcb745dbe81, -- DisputeOutOfScope
            0x5f19817b3ad988fdb5a7fb3f657a755e58a107bf47431574b7c516a6dc1551e6, -- ArbitrationTimedOut
            0x86e8b85731e4787f033d85108356db1e068dea243be32d422e6dc5681ff49cc1  -- DisputeTriggered
        )
        and block_number >= 48635850
        and block_date >= date '2026-10-07'
),

-- TransactionAttested: topic1 = safeTxHash, topic2 = safeId, topic3 = oracle, data word 0 = epoch.
attestations as (
    select
        block_time,
        block_number,
        tx_hash,
        "index" as log_index,
        topic1 as safe_tx_hash,
        topic2 as safe_id,
        bytearray_to_bigint(bytearray_substring(data, 25, 8)) as epoch
    from gnosis.logs
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and topic0 = 0x1980afd018b6bb99a313d3b7a88274259621396f9b8acaa712ef114872977357 -- TransactionAttested
        and topic3 = 0x0000000000000000000000004f61b8832978e83b80d69551aef07557dbe41d03
        and block_number >= 48635843
        and block_date >= date '2026-10-07'
),

events as (
    select
        'request' as event, block_time, block_number, tx_hash, log_index,
        request_id, safe_tx_hash, safe_id, epoch, sponsor,
        request_id is not null as matched
    from requests
    union all
    select
        o.event, o.block_time, o.block_number, o.tx_hash, o.log_index,
        o.request_id, r.safe_tx_hash, r.safe_id, r.epoch, r.sponsor,
        r.request_id is not null as matched
    from oracle_events as o
    left join requests as r on r.request_id = o.request_id
    union all
    select
        'attestation' as event, block_time, block_number, tx_hash, log_index,
        cast(null as varbinary) as request_id, safe_tx_hash, safe_id, epoch, cast(null as varbinary) as sponsor,
        true as matched
    from attestations
),

decoded as (
    select
        event,
        block_time,
        block_number,
        tx_hash,
        log_index,
        request_id,
        safe_tx_hash,
        bytearray_to_bigint(bytearray_substring(safe_id, 5, 8)) as safe_chain_id,
        bytearray_substring(safe_id, 13, 20) as safe_address,
        epoch,
        sponsor,
        if(matched, bytearray_substring(safe_id, 1, 12) in (
            0x000000000000000000000001, -- Ethereum
            0x000000000000000000000064, -- Gnosis Chain
            0x00000000000000000000a4b1  -- Arbitrum One
        )) as covered_chain
    from events
)

select
    *,
    case safe_chain_id when 1 then 'https://etherscan.io' when 100 then 'https://gnosisscan.io' when 137 then 'https://polygonscan.com' when 42161 then 'https://arbiscan.io' end || '/address/0x' || lower(to_hex(safe_address)) as safe_url,
    'https://gnosisscan.io/tx/0x' || lower(to_hex(tx_hash)) as tx_url,
    'https://safenet-explorer.eth.limo/#/safeTx?chainId=' || cast(safe_chain_id as varchar) || '&safeTxHash=0x' || lower(to_hex(safe_tx_hash)) as safe_tx_url
from decoded
