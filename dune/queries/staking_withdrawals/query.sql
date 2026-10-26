-- Safenet staking withdrawals, one row per withdrawal ID (WithdrawalInitiated), with its claim.
-- Definitions: docs/metrics/staking.md#staking_withdrawals. Shared model.
--
-- The contract (Staking.sol) fixes claimable_at when the withdrawal is requested: request time plus
-- the withdraw delay in force at that moment. Later delay changes do not move it. A staker claims
-- one withdrawal per call, the head of their queue (earliest claimable_at); requests cannot be
-- cancelled or restaked. Status, evaluated when the query runs:
--   waiting     requested, claimable_at in the future
--   claimable   claimable_at reached, not claimed yet
--   completed   claimed (WithdrawalClaimed for the same staker and withdrawal ID)
-- Outstanding = waiting + claimable; it equals the contract's totalPendingWithdrawals.

with

events as (
    select
        event, block_time, block_number, log_index, tx_hash, tx_url, staker, validator, withdrawal_id,
        amount_raw, era,
        -- withdraw delay in force at this event (seconds)
        last_value(new_delay) ignore nulls over (
            order by block_number, log_index rows between unbounded preceding and current row
        ) as delay
    from {{query:staking_events}}
    where event in ('withdrawal_requested', 'withdrawal_claimed', 'delay_changed')
),

withdrawals as (
    select
        withdrawal_id,
        staker,
        max(if(event = 'withdrawal_requested', validator)) as validator,
        max(if(event = 'withdrawal_requested', amount_raw)) as amount_raw,
        max(if(event = 'withdrawal_claimed', amount_raw)) as claimed_amount_raw,
        max(if(event = 'withdrawal_requested', block_time)) as requested_at,
        max(if(event = 'withdrawal_requested', block_number)) as requested_block,
        max(if(event = 'withdrawal_requested', tx_hash)) as request_tx,
        max(if(event = 'withdrawal_requested', tx_url)) as request_tx_url,
        max(if(event = 'withdrawal_requested', era)) as era,
        max(if(event = 'withdrawal_requested', delay)) as delay_seconds,
        max(if(event = 'withdrawal_claimed', block_time)) as claimed_at,
        max(if(event = 'withdrawal_claimed', block_number)) as claimed_block,
        max(if(event = 'withdrawal_claimed', tx_hash)) as claim_tx,
        max(if(event = 'withdrawal_claimed', tx_url)) as claim_tx_url
    from events
    where event <> 'delay_changed'
    group by 1, 2
)

select
    withdrawal_id,
    staker,
    validator,
    amount_raw,
    cast(amount_raw as double) / 1e18 as amount,
    requested_at,
    requested_block,
    request_tx,
    request_tx_url,
    era,
    delay_seconds,
    date_add('second', delay_seconds, requested_at) as claimable_at,
    claimed_at,
    claimed_block,
    claim_tx,
    claim_tx_url,
    case
        when claimed_at is not null then 'completed'
        when date_add('second', delay_seconds, requested_at) <= now() then 'claimable'
        else 'waiting'
    end as status,
    -- data checks, expected true: every claim has its request, with the same amount, not early
    requested_at is not null
        and (claimed_at is null or (claimed_amount_raw = amount_raw
            and claimed_at >= date_add('second', delay_seconds, requested_at))) as consistent
from withdrawals
