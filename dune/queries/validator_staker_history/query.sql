-- Each validator's registered staker over time, Beta and Aegis: one row per
-- Consensus.ValidatorStakerSet(validator indexed, staker), with the interval in which it applies.
-- Definitions: docs/metrics/validators.md#validator_staker_history. Shared model, for history only:
-- current self-stake uses staking_validator_stakers (Aegis) as in the Staking section.
--
-- Beta (Consensus 0x2236…cEE9) and Aegis (0xc855…aa96) each kept their own registrations. A
-- Beta setting applies until the Aegis start (2026-10-07 13:51:55 UTC); an Aegis setting
-- from its block on. Each applies until the next setting for the validator in the same era.
-- Between the Aegis start and a validator's first Aegis setting there is no registered
-- staker (self-stake unknown). Aegis settings come from Dune's decoded Consensus table; Beta
-- Consensus is not decoded, so its settings are read from raw logs (docs/decoding.md).

with

sets as (
    select
        'aegis' as era,
        validator,
        staker,
        evt_block_time as valid_from,
        evt_block_number as block_number,
        evt_tx_hash as tx_hash,
        evt_index as log_index
    from safe_gnosis.SafenetAegisConsensus_evt_ValidatorStakerSet
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96 -- Aegis Consensus
        and evt_block_number >= 48635843
    union all
    select
        'beta',
        bytearray_substring(topic1, 13, 20),
        bytearray_substring(data, 13, 20),
        block_time,
        block_number,
        tx_hash,
        "index"
    from gnosis.logs
    where contract_address = 0x223624cbf099e5a8f8cd5af22afa424a1d1acee9 -- Beta Consensus
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
