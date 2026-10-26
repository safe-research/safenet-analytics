-- Each validator's registered staker: the Ethereum account that puts up the validator's own stake,
-- set by the validator with Consensus.setValidatorStaker on the production Consensus (Gnosis Chain,
-- 0xc855761d…aa96). One row per validator, the latest setting. Decoded from raw logs:
--   ValidatorStakerSet(address indexed validator, address staker), topic0 in src/safenet.ts.
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
        bytearray_substring(topic1, 13, 20) as validator,
        bytearray_substring(data, 13, 20) as staker,
        block_time,
        block_number,
        tx_hash,
        row_number() over (partition by topic1 order by block_number desc, "index" desc) as latest
    from gnosis.logs
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and topic0 = 0xf0a005469b11e09422034ffe29da663a2969918f3663a27fae9fd5eed38778bb -- ValidatorStakerSet
        and block_number >= 48635843
        and block_date >= date '2026-10-07' -- partition pruning; Consensus deployed on 2026-10-07
)
where latest = 1
