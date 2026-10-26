-- Safenet Staking on Ethereum (0x115E78f160e1E3eF163B05C84562Fa16fA338509, deployed at block
-- 24585750 on 2026-03-04), one row per event, from Dune's decoded tables (safe_ethereum.Staking_evt_*).
-- One contract for Beta and production; era marks the side of the production start (the production
-- Consensus deployment on Gnosis Chain, 2026-10-07 13:51:55 UTC). Definitions and field reference:
-- docs/metrics/staking.md#staking_events. Shared model: read by the staking and validator queries.
--
--   event                  source event (Staking.sol at safe-research/safenet 4ed5101)
--   deposit                StakeIncreased(staker, validator, amount): SAFE in from the staker
--   withdrawal_requested   WithdrawalInitiated(staker, validator, withdrawalId, amount): leaves active
--                          stake at once; claimable after the withdraw delay in force at this event
--   withdrawal_claimed     WithdrawalClaimed(staker, withdrawalId, amount): SAFE out to the staker
--   validator_updated      ValidatorUpdated(validator, isRegistered)
--   delay_changed          WithdrawDelayChanged(oldDelay, newDelay), new_delay in seconds
--   tokens_recovered       TokensRecovered(token, to, amount): excess tokens only, never stake
-- There is no cancellation, restaking, redelegation or slashing in the contract.
-- amount_raw is in SAFE base units (exact); amount is SAFE (double, for display).

with

events as (
    select
        'deposit' as event, evt_block_time as block_time, evt_block_number as block_number,
        evt_tx_hash as tx_hash, evt_index as log_index, staker, validator,
        cast(null as bigint) as withdrawal_id, cast(cast(amount as varchar) as decimal(38, 0)) as amount_raw,
        cast(null as boolean) as is_registered, cast(null as bigint) as new_delay
    from safe_ethereum.Staking_evt_StakeIncreased
    where contract_address = 0x115e78f160e1e3ef163b05c84562fa16fa338509
        and evt_block_number >= 24585750
        and evt_block_date >= date '2026-03-04' -- partition pruning
    union all
    select
        'withdrawal_requested', evt_block_time, evt_block_number, evt_tx_hash, evt_index, staker, validator,
        cast(withdrawalId as bigint), cast(cast(amount as varchar) as decimal(38, 0)), null, null
    from safe_ethereum.Staking_evt_WithdrawalInitiated
    where contract_address = 0x115e78f160e1e3ef163b05c84562fa16fa338509
        and evt_block_number >= 24585750
        and evt_block_date >= date '2026-03-04'
    union all
    select
        'withdrawal_claimed', evt_block_time, evt_block_number, evt_tx_hash, evt_index, staker, null,
        cast(withdrawalId as bigint), cast(cast(amount as varchar) as decimal(38, 0)), null, null
    from safe_ethereum.Staking_evt_WithdrawalClaimed
    where contract_address = 0x115e78f160e1e3ef163b05c84562fa16fa338509
        and evt_block_number >= 24585750
        and evt_block_date >= date '2026-03-04'
    union all
    select
        'validator_updated', evt_block_time, evt_block_number, evt_tx_hash, evt_index, null, validator,
        null, null, isRegistered, null
    from safe_ethereum.Staking_evt_ValidatorUpdated
    where contract_address = 0x115e78f160e1e3ef163b05c84562fa16fa338509
        and evt_block_number >= 24585750
        and evt_block_date >= date '2026-03-04'
    union all
    select
        'delay_changed', evt_block_time, evt_block_number, evt_tx_hash, evt_index, null, null,
        null, null, null, cast(newDelay as bigint)
    from safe_ethereum.Staking_evt_WithdrawDelayChanged
    where contract_address = 0x115e78f160e1e3ef163b05c84562fa16fa338509
        and evt_block_number >= 24585750
        and evt_block_date >= date '2026-03-04'
    union all
    select
        'tokens_recovered', evt_block_time, evt_block_number, evt_tx_hash, evt_index, null, null,
        null, cast(cast(amount as varchar) as decimal(38, 0)), null, null
    from safe_ethereum.Staking_evt_TokensRecovered
    where contract_address = 0x115e78f160e1e3ef163b05c84562fa16fa338509
        and evt_block_number >= 24585750
        and evt_block_date >= date '2026-03-04'
)

select
    event,
    block_time,
    block_number,
    tx_hash,
    log_index,
    staker,
    validator,
    withdrawal_id,
    amount_raw,
    cast(amount_raw as double) / 1e18 as amount,
    is_registered,
    new_delay,
    if(block_time >= timestamp '2026-10-07 13:51:55', 'production', 'beta') as era,
    'https://etherscan.io/tx/0x' || lower(to_hex(tx_hash)) as tx_url
from events
