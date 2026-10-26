-- Safenet production: every USDC.e transfer into or out of the production SentinelOracle, one row
-- per Transfer log, classified by the oracle events of the same transaction (never by amount):
--
--   fee_in        from the sponsor of a request proposed in the transaction (NewRequest)
--   bond_in       from a Sentinel that committed in the transaction (Committed)
--   claim_out     to a Sentinel that claimed in the transaction (Claimed: bond return + fee reward)
--   refund_out    to the sponsor of a request that ended in the transaction without a verdict, or
--                 after an arbitrated dispute (the contract emits no refund event)
--   receiver_out  to the protocol funds receiver (DAO share, split remainder, slashes; no event)
--   unclassified  anything else; expected to be none (scripts/verify-network-revenue.ts)
--
-- USDC.e on Gnosis Chain: 0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0 (6 decimals); amounts are
-- base units. Protocol funds receiver: 0x9D02bed59170cdE96782Ea9a9b17F9bCF4916127
-- (docs/configuration.md); no ProtocolFundsReceiverScheduled event has changed it.

with

transfers as (
    select
        block_time,
        block_number,
        tx_hash,
        "index" as log_index,
        bytearray_substring(topic1, 13, 20) as from_address,
        bytearray_substring(topic2, 13, 20) as to_address,
        bytearray_to_bigint(bytearray_substring(data, 25, 8)) as amount
    from gnosis.logs
    where contract_address = 0x2a22f9c3b484c3629090feed35f17ff8f88f76f0
        and topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef -- Transfer
        and (topic1 = 0x0000000000000000000000004f61b8832978e83b80d69551aef07557dbe41d03
            or topic2 = 0x0000000000000000000000004f61b8832978e83b80d69551aef07557dbe41d03)
        and block_number >= 48635850
        and block_date >= date '2026-10-07'
),

-- Counterparties expected in each transaction, from one read of safenet_events (Dune inlines a
-- CTE each time it is used): the sponsor of a request (fee_in), a committing Sentinel (bond_in), a
-- claiming Sentinel (claim_out), and the sponsor of a request ending without a verdict or after an
-- arbitrated dispute (refund_out).
expected as (
    select distinct
        tx_hash,
        case event
            when 'request' then 'fee_in'
            when 'committed' then 'bond_in'
            when 'claimed' then 'claim_out'
            else 'refund_out'
        end as flow,
        if(event in ('committed', 'claimed'), sentinel, sponsor) as counterparty
    from {{query:safenet_events}}
    where event in ('request', 'committed', 'claimed', 'no_verdict')
        or (event in ('approved', 'denied') and source_event = 'DisputeResolved')
)

select
    t.block_time,
    t.block_number,
    t.tx_hash,
    t.log_index,
    t.from_address,
    t.to_address,
    t.amount,
    if(t.to_address = 0x4f61b8832978e83b80d69551aef07557dbe41d03, 'in', 'out') as direction,
    case
        when t.to_address = 0x4f61b8832978e83b80d69551aef07557dbe41d03 then
            coalesce(
                max(if(e.flow = 'fee_in' and e.counterparty = t.from_address, 'fee_in')),
                max(if(e.flow = 'bond_in' and e.counterparty = t.from_address, 'bond_in')),
                'unclassified')
        when t.to_address = 0x9d02bed59170cde96782ea9a9b17f9bcf4916127 then 'receiver_out'
        else
            coalesce(
                max(if(e.flow = 'claim_out' and e.counterparty = t.to_address, 'claim_out')),
                max(if(e.flow = 'refund_out' and e.counterparty = t.to_address, 'refund_out')),
                'unclassified')
    end as flow,
    'https://gnosisscan.io/tx/0x' || lower(to_hex(t.tx_hash)) as tx_url
from transfers as t
left join expected as e on e.tx_hash = t.tx_hash
group by 1, 2, 3, 4, 5, 6, 7
