-- Safenet staking rewards by reward period, as published (safe-fndn/safenet-data assets/rewards), Beta
-- and production. Definitions: docs/metrics/validators.md#rewards.
--
-- A period ends at a published rewards_until; its allocation is the change in the cumulative
-- published amounts from the previous period's last root (re-issues of the same period, such as KYC
-- releases, are merged into it). Amounts include KYC-withheld SAFE.
--   validator_stakers   addresses registered as a validator's staker during the period (Beta or
--                       production Consensus): their commission and own-stake reward together
--   delegators          everything else allocated in the period, minus Sentinel grants
--   commission          not in the published files. Shown only from a verified --split of the reward
--                       scripts (none yet); Beta periods: not published
-- Production periods (two weeks from 2026-10-13) that have ended but are not published yet are listed
-- with no amounts, never 0. 2026-10-06 to 2026-10-13 is the gap between Beta and production.

with

r as (
    select * from {{query:safenet_validator_rewards}}
),

periods as (
    select
        rewards_until as period_end,
        max(root_order) as last_root,
        max_by(token_total, root_order) as token_total,
        max_by(sentinel_amount, root_order) as sentinel_total, -- root rows carry sentinelTokenTotal here
        max_by(unpaid_amount, root_order) as unpaid,
        max_by(merkle_root, root_order) as merkle_root,
        count(*) - 1 as reissues
    from r
    where kind_row = 'root'
    group by 1
),

ordered as (
    select
        *,
        coalesce(lag(period_end) over (order by period_end), timestamp '2026-04-07 00:00:00') as period_start,
        lag(last_root) over (order by period_end) as previous_root,
        coalesce(lag(token_total) over (order by period_end), cast(0 as uint256)) as previous_total,
        coalesce(lag(sentinel_total) over (order by period_end), cast(0 as uint256)) as previous_sentinel_total
    from periods
),

-- validator staker addresses and the times they were registered
stakers as (
    select staker, valid_from, valid_to from {{query:validator_staker_history}}
),

staker_amounts as (
    select
        o.period_end,
        sum(cast(coalesce(cur.cumulative_amount, cast(0 as uint256)) + coalesce(cur.kyc_amount, cast(0 as uint256)) as double))
            - sum(cast(coalesce(prev.cumulative_amount, cast(0 as uint256)) + coalesce(prev.kyc_amount, cast(0 as uint256)) as double))
            as validator_stakers_raw
    from ordered as o
    join (
        select distinct o2.period_end, s.staker
        from ordered as o2
        join stakers as s
            on s.valid_from < o2.period_end
            and (s.valid_to is null or s.valid_to > o2.period_start)
    ) as a on a.period_end = o.period_end
    left join r as cur on cur.kind_row = 'entry' and cur.root_order = o.last_root and cur.address = a.staker
    left join r as prev on prev.kind_row = 'entry' and prev.root_order = o.previous_root and prev.address = a.staker
    group by 1
),

on_chain as (
    select distinct new_root from {{query:safenet_reward_events}} where event = 'root_updated'
),

published as (
    select
        o.period_start,
        o.period_end,
        if(o.period_end <= timestamp '2026-10-07 13:51:55', 'beta', 'production') as era,
        'published' as status,
        cast(o.token_total as double) / 1e18 - cast(o.previous_total as double) / 1e18 as total_allocated,
        coalesce(sa.validator_stakers_raw, 0) / 1e18 as validator_stakers,
        (cast(coalesce(o.sentinel_total, cast(0 as uint256)) as double) - cast(o.previous_sentinel_total as double)) / 1e18 as sentinel_grants,
        cast(o.unpaid as double) / 1e18 as unpaid_carried,
        o.reissues,
        c.new_root is not null as root_on_chain,
        o.merkle_root
    from ordered as o
    left join staker_amounts as sa on sa.period_end = o.period_end
    left join on_chain as c on c.new_root = o.merkle_root
),

-- production periods that have ended (two weeks from 2026-10-13) but are not published
expected as (
    select
        date_add('day', -14, e) as period_start,
        e as period_end
    from unnest(sequence(timestamp '2026-10-27 00:00:00', cast(now() as timestamp), interval '14' day)) as t (e)
)

select
    date_format(period_start, '%Y-%m-%d') || ' – ' || date_format(period_end, '%Y-%m-%d')
        || if(era = 'beta', ' (Beta)', ' (production)') as period,
    era,
    status,
    period_start,
    period_end,
    total_allocated,
    validator_stakers as validator_stakers_allocated,
    total_allocated - validator_stakers - sentinel_grants as delegators_allocated,
    sentinel_grants,
    cast(null as double) as commission,
    if(era = 'beta', 'not published', 'split not verified') as commission_status,
    unpaid_carried,
    reissues,
    root_on_chain,
    '0x' || lower(to_hex(merkle_root)) as merkle_root
from published
union all
select
    date_format(e.period_start, '%Y-%m-%d') || ' – ' || date_format(e.period_end, '%Y-%m-%d') || ' (production)',
    'production', 'not yet published', e.period_start, e.period_end,
    null, null, null, null, null, 'not published', null, null, null, null
from expected as e
where not exists (select 1 from periods as p where p.period_end = e.period_end)
order by period_end
