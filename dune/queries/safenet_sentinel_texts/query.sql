-- Safenet production: text recorded on chain with Sentinel votes and arbitration, one row per event,
-- decoded from raw logs of the SentinelOracle. Temporary decoding like safenet_events
-- (docs/decoding.md); kept out of safenet_events so the shared model stays small. Definitions:
-- docs/metrics/sentinels.md#disputes-and-arbitration.
--
-- source_event      text
--   Revealed        reason (empty for approvals, Charter rule IDs for denials); sentinel = topic2
--   DisputeResolved the arbitrator's context
--   DisputeOutOfScope the arbitrator's context
-- The text is an ABI string: its offset is in data word 2 (Revealed, DisputeResolved) or word 0
-- (DisputeOutOfScope), followed by a length word and the bytes. Empty text is null.

with

logs as (
    select
        topic0,
        topic1 as request_id,
        if(topic0 = 0xd2cdead965dbd376703d9a79240f31f1228055ab42384b68353332fcd2af939a, bytearray_substring(topic2, 13, 20)) as sentinel,
        block_number,
        tx_hash,
        data,
        if(topic0 = 0xe32b95dcf423c9ed3915554e30a0db65ad08358b5e5bdb1138c98dcb745dbe81,
            bytearray_to_bigint(bytearray_substring(data, 25, 8)),
            bytearray_to_bigint(bytearray_substring(data, 89, 8))) as string_at
    from gnosis.logs
    where contract_address = 0x4f61b8832978e83b80d69551aef07557dbe41d03 -- production SentinelOracle
        and topic0 in (
            0xd2cdead965dbd376703d9a79240f31f1228055ab42384b68353332fcd2af939a, -- Revealed
            0x7e739d167696b2e67be44f7ceb3afa7ad9e8ad5ee53d016de97ae7ab0b416a70, -- DisputeResolved
            0xe32b95dcf423c9ed3915554e30a0db65ad08358b5e5bdb1138c98dcb745dbe81  -- DisputeOutOfScope
        )
        and block_number >= 48635850
        and block_date >= date '2026-10-07' -- partition pruning; the oracle was deployed on 2026-10-07
),

lengths as (
    select *, bytearray_to_bigint(bytearray_substring(data, string_at + 25, 8)) as text_length
    from logs
)

select
    case topic0
        when 0xd2cdead965dbd376703d9a79240f31f1228055ab42384b68353332fcd2af939a then 'Revealed'
        when 0x7e739d167696b2e67be44f7ceb3afa7ad9e8ad5ee53d016de97ae7ab0b416a70 then 'DisputeResolved'
        else 'DisputeOutOfScope'
    end as source_event,
    request_id,
    sentinel,
    if(text_length > 0, from_utf8(bytearray_substring(data, string_at + 33, text_length))) as text,
    block_number,
    'https://gnosisscan.io/tx/0x' || lower(to_hex(tx_hash)) as tx_url
from lengths
