-- Each validator's registered staker: the Ethereum account that puts up the validator's own stake,
-- set by the validator with Consensus.setValidatorStaker on the production Consensus (Gnosis Chain,
-- 0xc855761d…aa96). One row per validator, the latest setting, from Dune's decoded Consensus table
-- (ValidatorStakerSet(address indexed validator, address staker); docs/decoding.md).
-- Self-stake is this staker's stake on its own validator (docs/metrics/staking.md#self-stake); it
-- is never inferred from names. A validator without a row has no registered staker.

select
    validator,
    staker,
    block_time as set_at,
    block_number as set_block,
    tx_hash as set_tx,
    'https://gnosisscan.io/tx/0x' || lower(to_hex(tx_hash)) as set_tx_url
from (
    select
        validator,
        staker,
        evt_block_time as block_time,
        evt_block_number as block_number,
        evt_tx_hash as tx_hash,
        row_number() over (partition by validator order by evt_block_number desc, evt_index desc) as latest
    from safe_gnosis.SafenetAegisConsensus_evt_ValidatorStakerSet
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and evt_block_number >= 48635843
)
where latest = 1
