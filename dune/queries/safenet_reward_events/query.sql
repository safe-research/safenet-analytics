-- Safe Foundation's SAFE rewards distributor on Ethereum ("Safenet Aegis Rewards",
-- CumulativeMerkleDrop 0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2, deployed at block 24749707 on
-- 2026-03-27), one row per event, from Dune's decoded tables (safe_ethereum.CumulativeMerkleDrop_evt_*,
-- docs/decoding.md). Definitions: docs/metrics/sentinels.md#safe-subsidies.
--
-- event          one row per
--   claimed      Claimed(address indexed account, uint256 amount): SAFE paid to account
--   root_updated MerkelRootUpdated(bytes32 oldMerkleRoot, bytes32 newMerkleRoot) (the contract's spelling)
-- Amounts are SAFE base units (18 decimals). The distributor pays every SAFE reward type; a claim
-- does not say which part was a Sentinel subsidy.

select event, block_time, block_number, tx_hash, log_index, account, amount, old_root, new_root,
    'https://etherscan.io/tx/0x' || lower(to_hex(tx_hash)) as tx_url
from (
    select 'claimed' as event, evt_block_time as block_time, evt_block_number as block_number, evt_tx_hash as tx_hash,
        evt_index as log_index, account, amount, cast(null as varbinary) as old_root, cast(null as varbinary) as new_root,
        contract_address
    from safe_ethereum.CumulativeMerkleDrop_evt_Claimed
    union all
    select 'root_updated', evt_block_time, evt_block_number, evt_tx_hash, evt_index, null, null, oldMerkleRoot, newMerkleRoot,
        contract_address
    from safe_ethereum.CumulativeMerkleDrop_evt_MerkelRootUpdated
)
where contract_address = 0xe5139fc0fb8eae81e30d8a85c22e88c6757120f2
    and block_number >= 24749707 -- deployed on 2026-03-27
