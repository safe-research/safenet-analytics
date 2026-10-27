-- Safenet validators now: one row per validator ever in the production attestation set or in the
-- Staking contract. Current snapshot, separate from the history panels. Definitions:
-- docs/metrics/validators.md#overview.
--
--   attestation_set        member of the active epoch's FROST group (validator_membership), or the
--                          epoch it was last a member of; independent of staking registration
--   staking_registration   Staking contract registration (staking_validators, as in the Staking section)
--   self / delegated stake staking_validators (registered staker on production Consensus)
--   share_of_contract_stake      total_stake / all active stake in the Staking contract
--   share_of_live_set_stake      total_stake / stake on validators both registered and in the
--                                current attestation set; null for validators outside it
--   observed_participation_30d   recognised signature shares / completed production ceremonies of
--                                its groups, last 30 days; null without eligible ceremonies
--   reward_participation_period  the reward scripts' rate for the current two-week period so far:
--                                recognised shares on attested transactions / all attested
--                                transactions completed in the period (not settled, not a payout)
--   last_signature_share   time of the last recognised signature share (not staking activity)

with

stake as (
    select * from {{query:staking_validators}}
),

membership as (
    select
        validator,
        max(epoch) as last_member_epoch,
        bool_or(epoch_status = 'active') as member_now,
        max_by(epoch, active_from_block) filter (where epoch_status = 'active') as active_epoch,
        max(as_of_block) as as_of_block,
        max(as_of_time) as as_of_time
    from {{query:validator_membership}}
    where epoch_status <> 'staged'
    group by 1
),

ceremonies as (
    select * from {{query:validator_ceremonies}} where completed
),

-- Current reward period: two-week periods from 2026-10-13 (safenet-staking-scripts).
period as (
    select date_add('day', 14 * floor(date_diff('day', timestamp '2026-10-13 00:00:00 UTC', now()) / 14),
        timestamp '2026-10-13 00:00:00 UTC') as period_start
),

participation as (
    select
        c.validator,
        count_if(c.completed_at >= now() - interval '30' day) as eligible_30d,
        count_if(c.completed_at >= now() - interval '30' day and c.signed) as signed_30d,
        count_if(c.purpose = 'transaction' and c.signed and c.completed_at >= p.period_start) as signed_period,
        count_if(c.purpose = 'transaction' and c.first_row and c.completed_at >= p.period_start) as first_rows_period,
        max(c.signed_at) as last_signature_share,
        max_by(c.share_tx_url, c.signed_at) as last_share_tx_url
    from ceremonies as c
    cross join period as p
    group by 1
),

labels as (
    select address, label from {{query:safenet_participant_labels}} where role = 'validator'
),

rows_ as (
    select
        coalesce(s.validator, m.validator) as validator,
        coalesce(l.label, '0x' || lower(to_hex(coalesce(s.validator, m.validator)))) as name,
        case
            when m.member_now then 'Member (epoch ' || cast(m.active_epoch as varchar) || ')'
            when m.validator is not null then 'Not a member (last in epoch ' || cast(m.last_member_epoch as varchar) || ')'
            else 'Never a member'
        end as attestation_set,
        coalesce(m.member_now, false) as member_now,
        coalesce(s.staking_status, 'never registered') as staking_registration,
        s.staker,
        s.self_stake,
        s.delegated_stake,
        coalesce(s.total_stake, 0) as total_stake,
        p.eligible_30d,
        p.signed_30d,
        p.signed_period,
        sum(coalesce(p.first_rows_period, 0)) over () as transactions_period,
        p.last_signature_share,
        p.last_share_tx_url,
        max(m.as_of_time) over () as as_of_time,
        max(m.as_of_block) over () as through_block
    from stake as s
    full outer join membership as m on m.validator = s.validator
    left join participation as p on p.validator = coalesce(s.validator, m.validator)
    left join labels as l on l.address = coalesce(s.validator, m.validator)
),

totals as (
    select
        *,
        sum(total_stake) over () as contract_stake,
        sum(if(member_now and staking_registration = 'registered', total_stake, 0)) over () as live_set_stake
    from rows_
)

select
    '<a href="https://gnosisscan.io/address/0x' || lower(to_hex(r.validator)) || '" target="_blank">' || r.name || '</a>' as validator,
    r.name,
    r.attestation_set,
    r.staking_registration,
    if(r.staker is null, 'none registered',
        '<a href="https://etherscan.io/address/0x' || lower(to_hex(r.staker)) || '" target="_blank">0x'
            || substr(lower(to_hex(r.staker)), 1, 4) || '…' || substr(lower(to_hex(r.staker)), 37, 4) || '</a>') as registered_staker,
    r.self_stake,
    r.delegated_stake,
    r.total_stake,
    r.total_stake / nullif(r.contract_stake, 0) as share_of_contract_stake,
    if(r.member_now and r.staking_registration = 'registered', r.total_stake / nullif(r.live_set_stake, 0)) as share_of_live_set_stake,
    if(coalesce(r.eligible_30d, 0) = 0, null, 1.0 * r.signed_30d / r.eligible_30d) as observed_participation_30d,
    if(coalesce(r.eligible_30d, 0) = 0, 'n/a (no eligible ceremonies)',
        cast(r.signed_30d as varchar) || ' / ' || cast(r.eligible_30d as varchar)) as observed_signed_30d,
    if(r.transactions_period = 0, null, 1.0 * coalesce(r.signed_period, 0) / r.transactions_period) as reward_participation_period,
    r.last_signature_share,
    if(r.last_share_tx_url is null, 'none',
        '<a href="' || r.last_share_tx_url || '" target="_blank">signature share ↗</a>') as last_signature_share_tx,
    '0x' || lower(to_hex(r.validator)) as validator_address,
    r.contract_stake,
    r.live_set_stake,
    r.as_of_time, -- Gnosis Chain data as of
    r.through_block, -- for the verification (Gnosis block)
    now() as computed_at
from totals as r
-- addresses that were never registered, never a member and hold no stake (e.g. a deregistration of an
-- address that was never registered) are not validators
where r.staking_registration <> 'never registered' or r.attestation_set <> 'Never a member' or r.total_stake > 0
order by r.member_now desc, r.total_stake desc, r.name
