-- Safenet production: USDC.e transfers of Sentinel accounts on Gnosis Chain, one row per transfer
-- and Sentinel side, decoded from raw logs. Used for the Sentinels' available USDC.e (the bond
-- token held in their own account). Temporary decoding like safenet_events (docs/decoding.md).
-- Definitions: docs/metrics/sentinels.md#bonds.
--
-- Transfer(address indexed from, address indexed to, uint256 value) of USDC.e
-- 0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0. Sentinels are every address in a production
-- SentinelScheduled event. Transfers are read from 2026-10-07, when the Sentinel Oracle was
-- deployed; scripts/verify-sentinels.ts checks that the resulting balances equal balanceOf on chain,
-- which holds only if no Sentinel held USDC.e before that date.
--
-- Transfers are capped at the last block of safenet_events (through_block), the block every other
-- Sentinel figure ends at. safenet_events reads Dune's decoded tables, which can trail the raw logs
-- read here by a minute or so; without the cap, a claim in that gap made available bond and
-- locked bond end at different blocks (verification mismatch, 2026-11-02).

with

sentinels as (
    select distinct sentinel, 0x000000000000000000000000 || sentinel as topic, through_block
    from (
        select event, sentinel, max(block_number) over () as through_block
        from {{query:safenet_events}}
    )
    where event = 'sentinel_scheduled'
),

transfers as (
    select block_time, block_number, tx_hash, "index" as log_index, topic1, topic2, bytearray_to_uint256(data) as amount
    from gnosis.logs
    where contract_address = 0x2a22f9c3b484c3629090feed35f17ff8f88f76f0
        and topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef -- Transfer
        and (topic1 in (select topic from sentinels) or topic2 in (select topic from sentinels))
        and block_number >= 48635850
        and block_date >= date '2026-10-07'
)

-- One row per side: a transfer between two Sentinels, or from a Sentinel to itself, is both an
-- 'out' and an 'in' row, so balances net correctly.
select s.sentinel, 'in' as direction, bytearray_substring(t.topic1, 13, 20) as counterparty, t.amount, t.block_time,
    t.block_number, t.tx_hash, t.log_index, 'https://gnosisscan.io/tx/0x' || lower(to_hex(t.tx_hash)) as tx_url
from transfers as t
join sentinels as s on s.topic = t.topic2
where t.block_number <= s.through_block
union all
select s.sentinel, 'out' as direction, bytearray_substring(t.topic2, 13, 20) as counterparty, t.amount, t.block_time,
    t.block_number, t.tx_hash, t.log_index, 'https://gnosisscan.io/tx/0x' || lower(to_hex(t.tx_hash)) as tx_url
from transfers as t
join sentinels as s on s.topic = t.topic1
where t.block_number <= s.through_block
