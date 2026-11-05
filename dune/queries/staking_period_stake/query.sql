-- Time-weighted active stake per completed Aegis reward period and (staker, validator), from every
-- Staking contract event (staking_events). Definitions: docs/metrics/staking.md#realized-apr.
--
-- Reward periods: the 13 Beta periods (two weeks each from 2026-04-07 00:00 UTC to 2026-10-06) and
-- the Aegis periods (two weeks from 2026-10-13 00:00 UTC, safenet-staking-scripts); the week between is
-- no period. An Aegis period is listed once it has ended, published or not. Stake follows the Staking rules: deposits add, a
-- withdrawal request removes the amount at its block. The balance of each (staker, validator) is a
-- step function of block time, carried into the period from before its start, and weighted by the
-- exact seconds it was held, not by daily snapshots:
--   stake_seconds_all_raw  balance × seconds within the period (base units × s)
--   stake_seconds_raw      the same, only while the validator was registered in the Staking contract
--                          (ValidatorUpdated): the stake the reward scripts count
--   self_stake_seconds_raw the registered part held by the validator's registered staker at the time
--                          (ValidatorStakerSet, validator_staker_history: Beta Consensus until the
--                          Aegis start, Aegis Consensus after; the intervals do not overlap)
--   avg_*                  stake seconds / period seconds, in SAFE: the average over the period
-- Stake is counted whether or not the validator met the participation threshold; eligibility is
-- applied in staking_period_validators.

with

ev as (
    select event, staker, validator, amount_raw, is_registered, block_number, log_index,
        cast(to_unixtime(block_time) as bigint) as t
    from {{query:staking_events}}
    where event in ('deposit', 'withdrawal_requested', 'validator_updated')
),

-- Period ends every 1209600 s (two weeks): Beta from 1776729600 (2026-04-21) to 1791244800
-- (2026-10-06), Aegis from 1793059200 (2026-10-27 00:00 UTC) up to now.
periods as (
    select
        p_to - 1209600 as p_from,
        p_to,
        from_unixtime(p_to - 1209600) as period_start,
        from_unixtime(p_to) as period_end,
        era
    from (
        select p_to, 'beta' as era from unnest(sequence(cast(1776729600 as bigint), cast(1791244800 as bigint), cast(1209600 as bigint))) as b (p_to)
        union all
        select p_to, 'aegis' from unnest(sequence(cast(1793059200 as bigint), cast(to_unixtime(now()) as bigint), cast(1209600 as bigint))) as a (p_to)
    )
),

-- Balance of each (staker, validator) after each change, held until the pair's next change.
segments as (
    select
        staker,
        validator,
        t as seg_from,
        coalesce(lead(t) over (partition by staker, validator order by block_number, log_index), 9999999999) as seg_to,
        sum(if(event = 'deposit', amount_raw, -amount_raw))
            over (partition by staker, validator order by block_number, log_index rows between unbounded preceding and current row) as balance
    from ev
    where event in ('deposit', 'withdrawal_requested')
),

-- Registration of each validator in the Staking contract, as intervals.
registrations as (
    select validator, t as reg_from,
        coalesce(lead(t) over (partition by validator order by block_number, log_index), 9999999999) as reg_to,
        is_registered
    from ev
    where event = 'validator_updated'
),

-- Aegis registered stakers (Gnosis Chain), as intervals.
stakers as (
    select validator, staker, cast(to_unixtime(valid_from) as bigint) as s_from,
        coalesce(cast(to_unixtime(valid_to) as bigint), 9999999999) as s_to
    from {{query:validator_staker_history}}
),

in_period as (
    select p.period_start, p.period_end, p.era, p.p_from, p.p_to, s.staker, s.validator, s.balance,
        greatest(s.seg_from, p.p_from) as f, least(s.seg_to, p.p_to) as t
    from segments as s
    join periods as p on s.seg_from < p.p_to and s.seg_to > p.p_from
    where s.balance > 0
),

registered as (
    select i.period_start, i.period_end, i.staker, i.validator, i.balance,
        greatest(i.f, r.reg_from) as f, least(i.t, r.reg_to) as t
    from in_period as i
    join registrations as r on r.validator = i.validator and r.is_registered and r.reg_from < i.t and r.reg_to > i.f
),

self_ as (
    select g.period_start, g.period_end, g.staker, g.validator,
        sum(g.balance * (least(g.t, k.s_to) - greatest(g.f, k.s_from))) as self_stake_seconds_raw
    from registered as g
    join stakers as k on k.validator = g.validator and k.staker = g.staker and k.s_from < g.t and k.s_to > g.f
    group by 1, 2, 3, 4
),

all_ as (
    select period_start, period_end, era, p_to - p_from as period_seconds, staker, validator,
        sum(balance * (t - f)) as stake_seconds_all_raw
    from in_period
    group by 1, 2, 3, 4, 5, 6
),

reg as (
    select period_start, period_end, staker, validator, sum(balance * (t - f)) as stake_seconds_raw
    from registered
    group by 1, 2, 3, 4
)

select
    a.period_start,
    a.period_end,
    a.era,
    a.period_seconds,
    a.staker,
    a.validator,
    a.stake_seconds_all_raw,
    coalesce(r.stake_seconds_raw, 0) as stake_seconds_raw,
    coalesce(s.self_stake_seconds_raw, 0) as self_stake_seconds_raw,
    cast(a.stake_seconds_all_raw as double) / a.period_seconds / 1e18 as avg_stake_all,
    cast(coalesce(r.stake_seconds_raw, 0) as double) / a.period_seconds / 1e18 as avg_stake,
    cast(coalesce(s.self_stake_seconds_raw, 0) as double) / a.period_seconds / 1e18 as avg_self_stake
from all_ as a
left join reg as r on r.period_end = a.period_end and r.staker = a.staker and r.validator = a.validator
left join self_ as s on s.period_end = a.period_end and s.staker = a.staker and s.validator = a.validator
