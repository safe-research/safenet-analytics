-- Safenet production: transaction-check requests, completed checks and attestations per UTC day.
-- Definitions, sources and limitations: docs/metrics/transaction-checks.md
-- Contracts (Gnosis Chain, production "Aegis"):
--   Consensus       0xc855761D619f6002923507cE68B84d7689C2aa96 (deployed at block 48635843)
--   SentinelOracle  0x4F61B8832978e83b80D69551AEf07557DBE41d03 (deployed at block 48635850)
-- Raw logs are used because the contracts are not decoded on Dune. topic0 values are checked
-- against the Solidity event signatures in test/safenet.test.ts.

with

-- Consensus.TransactionProposed with oracle = production SentinelOracle.
-- topic1 = safeTxHash, topic2 = safeId (chainId in the top 12 bytes, Safe in the low 20), topic3 = oracle.
proposals as (
    select
        block_time,
        tx_hash,
        topic2 as safe_id,
        row_number() over (partition by tx_hash order by "index") as n
    from gnosis.logs
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and topic0 = 0x47d867ce4d91d0487fa4d2ac80b13e7466ce53dd018a8eef564fc60c92b53d03
        and topic3 = 0x0000000000000000000000004f61b8832978e83b80d69551aef07557dbe41d03
        and block_number >= 48635843
        and block_date >= date '2026-10-07' -- partition pruning; the contracts were deployed on 2026-10-07
),

-- SentinelOracle.NewRequest; topic1 = requestId (the EIP-712 proposal message).
-- Emitted in the same transaction as, and after, its TransactionProposed, so the n-th proposal
-- of a transaction pairs with the n-th request of that transaction.
oracle_requests as (
    select
        tx_hash,
        topic1 as request_id,
        row_number() over (partition by tx_hash order by "index") as n
    from gnosis.logs
    where contract_address = 0x4f61b8832978e83b80d69551aef07557dbe41d03
        and topic0 = 0x8ec61272960f97d43d7f8f85ed630aa512818577f3d1e548e7627b06dbbbda86
        and block_number >= 48635850
        and block_date >= date '2026-10-07'
),

requests as (
    select
        p.block_time,
        r.request_id,
        -- null (reported as unmatched) if no oracle request pairs with the proposal
        if(r.request_id is not null, bytearray_substring(p.safe_id, 1, 12) in (
            0x000000000000000000000001, -- Ethereum
            0x000000000000000000000064, -- Gnosis Chain
            0x00000000000000000000a4b1  -- Arbitrum One
        )) as covered_chain
    from proposals as p
    left join oracle_requests as r
        on r.tx_hash = p.tx_hash
        and r.n = p.n
),

-- Terminal oracle outcomes. Each request ends in exactly one of these.
outcomes as (
    select
        block_time,
        topic1 as request_id,
        case
            when topic0 = 0x7843c453c4f7442b00e1bf3873e741f18f3447e18a13304c58bef95efd311757 -- OracleResult(bytes result, bool approved)
                then if(bytearray_substring(data, 64, 1) = 0x01, 'approved', 'denied')
            when topic0 = 0x7e739d167696b2e67be44f7ceb3afa7ad9e8ad5ee53d016de97ae7ab0b416a70 -- DisputeResolved(uint8 outcome, ...): 3 approved, 4 denied
                then if(bytearray_substring(data, 32, 1) = 0x03, 'approved', 'denied')
            else 'no_verdict' -- RequestTimedOut, DisputeOutOfScope, ArbitrationTimedOut
        end as outcome
    from gnosis.logs
    where contract_address = 0x4f61b8832978e83b80d69551aef07557dbe41d03
        and topic0 in (
            0x7843c453c4f7442b00e1bf3873e741f18f3447e18a13304c58bef95efd311757, -- OracleResult
            0x7e739d167696b2e67be44f7ceb3afa7ad9e8ad5ee53d016de97ae7ab0b416a70, -- DisputeResolved
            0xf1ca1e9147be737b04a2b018a79405f687a97de8dd8a2559bbe62357343af414, -- RequestTimedOut
            0xe32b95dcf423c9ed3915554e30a0db65ad08358b5e5bdb1138c98dcb745dbe81, -- DisputeOutOfScope
            0x5f19817b3ad988fdb5a7fb3f657a755e58a107bf47431574b7c516a6dc1551e6  -- ArbitrationTimedOut
        )
        and block_number >= 48635850
        and block_date >= date '2026-10-07'
),

-- Consensus.TransactionAttested with oracle = production SentinelOracle; topic2 = safeId.
attestations as (
    select
        block_time,
        bytearray_substring(topic2, 1, 12) in (
            0x000000000000000000000001,
            0x000000000000000000000064,
            0x00000000000000000000a4b1
        ) as covered_chain
    from gnosis.logs
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and topic0 = 0x1980afd018b6bb99a313d3b7a88274259621396f9b8acaa712ef114872977357
        and topic3 = 0x0000000000000000000000004f61b8832978e83b80d69551aef07557dbe41d03
        and block_number >= 48635843
        and block_date >= date '2026-10-07' -- partition pruning; the contracts were deployed on 2026-10-07
),

events as (
    select block_time, 'request' as event, covered_chain from requests
    union all
    select o.block_time, o.outcome as event, r.covered_chain
    from outcomes as o
    left join requests as r on r.request_id = o.request_id
    union all
    select block_time, 'attestation' as event, covered_chain from attestations
)

select
    cast(date_trunc('day', block_time) as date) as day,
    count_if(event = 'request' and covered_chain) as requests,
    count_if(event in ('approved', 'denied') and covered_chain) as completed_checks,
    count_if(event = 'approved' and covered_chain) as checks_approved,
    count_if(event = 'denied' and covered_chain) as checks_denied,
    count_if(event = 'no_verdict' and covered_chain) as closed_without_verdict,
    count_if(event = 'attestation' and covered_chain) as attestations,
    count_if(event = 'request' and not covered_chain) as uncovered_chain_requests,
    count_if(event in ('approved', 'denied') and not covered_chain) as uncovered_chain_completed_checks,
    count_if(event = 'attestation' and not covered_chain) as uncovered_chain_attestations,
    -- Should always be 0: outcomes without a matching request, or requests without an oracle request.
    count_if(covered_chain is null) as unmatched_events
from events
group by 1
order by 1
