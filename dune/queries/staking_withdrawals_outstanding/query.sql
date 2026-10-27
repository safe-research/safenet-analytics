-- Safenet staking withdrawals not yet claimed, now: one row per withdrawal ID, earliest withdrawal
-- date first. Current state, independent of the history charts. Definitions:
-- docs/metrics/staking.md#outstanding-withdrawals.
--
-- earliest_withdrawal is the contract's claimableAt: request time + the withdraw delay in force at
-- the request. claimable = that time has passed (the staker can claim it; claims go one at a time,
-- earliest first); waiting = not yet. Completed withdrawals are excluded; requests cannot be
-- cancelled. When nothing is outstanding, one row says so.

with

labels as (
    select address, label from {{query:safenet_participant_labels}} where role = 'validator'
),

outstanding as (
    select
        w.*,
        coalesce(l.label, '0x' || lower(to_hex(w.validator))) as validator_name
    from {{query:staking_withdrawals}} as w
    left join labels as l on l.address = w.validator
    where w.status <> 'completed'
),

short as (
    select
        *,
        '0x' || lower(to_hex(staker)) as staker_full,
        '0x' || lower(to_hex(validator)) as validator_full,
        '0x' || lower(to_hex(request_tx)) as request_tx_full
    from outstanding
)

select
    '<a href="https://etherscan.io/address/' || staker_full || '" target="_blank">'
        || substr(staker_full, 1, 6) || '…' || substr(staker_full, 39, 4) || '</a>' as staker,
    '<a href="https://etherscan.io/address/' || validator_full || '" target="_blank">' || validator_name || '</a>' as validator,
    amount,
    requested_at,
    claimable_at as earliest_withdrawal,
    if(status = 'claimable', 'Claimable now', 'Waiting') as status,
    '<a href="' || request_tx_url || '" target="_blank">' || substr(request_tx_full, 1, 10) || '…</a>' as request_tx,
    withdrawal_id,
    staker_full,
    validator_full,
    request_tx_full
from short
union all
select
    'No outstanding withdrawals', null, null, null, null, null, null, null, null, null, null
from (values 1) as t (x)
where not exists (select 1 from outstanding)
order by earliest_withdrawal nulls first, withdrawal_id
