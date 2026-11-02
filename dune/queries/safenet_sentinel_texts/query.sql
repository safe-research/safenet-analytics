-- Safenet production: text recorded on chain with Sentinel votes and arbitration, one row per event,
-- from Dune's decoded SentinelOracle tables (docs/decoding.md); kept out of safenet_events so the
-- shared model stays small. Definitions: docs/metrics/sentinels.md#disputes-and-arbitration.
--
-- source_event      text
--   Revealed        reason (empty for approvals, Charter rule IDs for denials), with the sentinel
--   DisputeResolved the arbitrator's context
--   DisputeOutOfScope the arbitrator's context
-- Empty text is null, as when this model decoded raw logs.

with

texts as (
    select 'Revealed' as source_event, requestId, sentinel, reason as text, evt_block_number, evt_tx_hash, contract_address
    from safe_gnosis.SafenetAegisSentinelOracle_evt_Revealed
    union all
    select 'DisputeResolved', requestId, cast(null as varbinary), context, evt_block_number, evt_tx_hash, contract_address
    from safe_gnosis.SafenetAegisSentinelOracle_evt_DisputeResolved
    union all
    select 'DisputeOutOfScope', requestId, cast(null as varbinary), context, evt_block_number, evt_tx_hash, contract_address
    from safe_gnosis.SafenetAegisSentinelOracle_evt_DisputeOutOfScope
)

select
    source_event,
    requestId as request_id,
    sentinel,
    nullif(text, '') as text,
    evt_block_number as block_number,
    'https://gnosisscan.io/tx/0x' || lower(to_hex(evt_tx_hash)) as tx_url
from texts
where contract_address = 0x4f61b8832978e83b80d69551aef07557dbe41d03 -- production SentinelOracle
    and evt_block_number >= 48635850
