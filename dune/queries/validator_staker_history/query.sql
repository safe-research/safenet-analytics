-- Each validator's registered staker over time, Beta and production: one row per
-- Consensus.ValidatorStakerSet(validator indexed, staker), with the interval in which it applies.
-- Definitions: docs/metrics/validators.md#validator_staker_history. Shared model, for history only:
-- current self-stake uses staking_validator_stakers (production) as in the Staking section.
--
-- Beta (Consensus 0x2236…cEE9) and production (0xc855…aa96) each kept their own registrations. A
-- Beta setting applies until the production start (2026-10-07 13:51:55 UTC); a production setting
-- from its block on. Each applies until the next setting for the validator in the same era.
-- Between the production start and a validator's first production setting there is no registered
-- staker (self-stake unknown).

with

sets as (
    select
        if(contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96, 'production', 'beta') as era,
        bytearray_substring(topic1, 13, 20) as validator,
        bytearray_substring(data, 13, 20) as staker,
        block_time as valid_from,
        block_number,
        tx_hash,
        "index" as log_index
    from gnosis.logs
    where contract_address in (
            0x223624cbf099e5a8f8cd5af22afa424a1d1acee9, -- Beta Consensus
            0xc855761d619f6002923507ce68b84d7689c2aa96  -- production Consensus
        )
        and topic0 = 0xf0a005469b11e09422034ffe29da663a2969918f3663a27fae9fd5eed38778bb -- ValidatorStakerSet
        and block_number >= 45210396 -- Beta Consensus deployment
        and block_date >= date '2026-03-18'
)

select
    era,
    validator,
    staker,
    valid_from,
    coalesce(
        lead(valid_from) over (partition by era, validator order by block_number, log_index),
        if(era = 'beta', timestamp '2026-10-07 13:51:55 UTC')
    ) as valid_to, -- exclusive; null = still in force
    block_number,
    tx_hash,
    'https://gnosisscan.io/tx/0x' || lower(to_hex(tx_hash)) as tx_url
from sets
