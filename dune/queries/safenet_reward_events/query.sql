-- Safe Foundation's SAFE rewards distributor on Ethereum ("Safenet Aegis Rewards",
-- CumulativeMerkleDrop 0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2, deployed at block 24749707 on
-- 2026-03-27), one row per event, decoded from raw logs. Temporary decoding like safenet_events
-- (docs/decoding.md); topic0 values in src/safenet.ts. Definitions: docs/metrics/sentinels.md#safe-subsidies.
--
-- event          one row per
--   claimed      Claimed(address indexed account, uint256 amount): SAFE paid to account
--   root_updated MerkelRootUpdated(bytes32 oldMerkleRoot, bytes32 newMerkleRoot) (the contract's spelling)
-- Amounts are SAFE base units (18 decimals). The distributor pays every SAFE reward type; a claim
-- does not say which part was a Sentinel subsidy.

select
    if(topic0 = 0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a, 'claimed', 'root_updated') as event,
    block_time,
    block_number,
    tx_hash,
    "index" as log_index,
    if(topic0 = 0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a, bytearray_substring(topic1, 13, 20)) as account,
    if(topic0 = 0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a, bytearray_to_uint256(data)) as amount,
    if(topic0 = 0x936fd71fceff3b4f98f4935ac269e4f94b4b25e3e38c519d3ff3db222a27117a, bytearray_substring(data, 1, 32)) as old_root,
    if(topic0 = 0x936fd71fceff3b4f98f4935ac269e4f94b4b25e3e38c519d3ff3db222a27117a, bytearray_substring(data, 33, 32)) as new_root,
    'https://etherscan.io/tx/0x' || lower(to_hex(tx_hash)) as tx_url
from ethereum.logs
where contract_address = 0xe5139fc0fb8eae81e30d8a85c22e88c6757120f2
    and topic0 in (
        0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a, -- Claimed
        0x936fd71fceff3b4f98f4935ac269e4f94b4b25e3e38c519d3ff3db222a27117a  -- MerkelRootUpdated
    )
    and block_number >= 24749707
    and block_date >= date '2026-03-27' -- partition pruning; deployed on 2026-03-27
