-- Per completed Aegis reward period and validator: time-weighted stake (staking_period_stake) and
-- the reward scripts' participation and eligibility. Definitions: docs/metrics/staking.md#realized-apr.
--
--   avg_stake            average stake while registered in the Staking contract (SAFE)
--   avg_stake_all        average stake whether registered or not
--   avg_self_stake       the registered staker's part; avg_delegated_stake = avg_stake - avg_self_stake
--   signed / transactions  reward participation (safenet-staking-scripts src/data/attestations.ts):
--                        recognised signature shares on transaction ceremonies completed in the
--                        period (both ends included) whose TransactionAttested is no later than the
--                        settlement block (the last Gnosis block at or before the period end + 48),
--                        out of all such ceremonies, member or not
--   eligible             signed / transactions >= 0.75 (a validator below gets no reward, and its
--                        share goes to the others)
-- Stakers excluded by the reward scripts (sanctioned) are not removed here: none so far; the
-- verification checks it.

with

stake as (
    select
        period_start, period_end, validator,
        sum(avg_stake) as avg_stake,
        sum(avg_stake_all) as avg_stake_all,
        sum(avg_self_stake) as avg_self_stake,
        count_if(stake_seconds_raw > 0) as stakers
    from {{query:staking_period_stake}}
    group by 1, 2, 3
),

periods as (
    select distinct period_start, period_end from stake
),

-- Settlement: the Gnosis block at or before the period end, plus 48 blocks.
boundary as (
    select p.period_end, max(b.number) as boundary_block
    from periods as p
    join gnosis.blocks as b
        on b.time <= p.period_end and b.time > p.period_end - interval '1' hour
        and b.date between cast(p.period_end as date) - interval '1' day and cast(p.period_end as date)
    group by 1
),

settlement as (
    select x.period_end, b.number as settlement_block, b.time as settlement_time
    from boundary as x
    join gnosis.blocks as b on b.number = x.boundary_block + 48
        and b.date between cast(x.period_end as date) - interval '1' day and cast(x.period_end as date) + interval '1' day
),

ceremonies as (
    select c.validator, c.signed, c.first_row, s.period_end
    from {{query:validator_ceremonies}} as c
    join settlement as s
        on c.completed_at >= date_add('day', -14, s.period_end) and c.completed_at <= s.period_end
        and c.attested_at <= s.settlement_time
    where c.purpose = 'transaction' and c.completed
),

counts as (
    select period_end, count_if(first_row) as transactions from ceremonies group by 1
),

signed as (
    select period_end, validator, count_if(signed) as signed from ceremonies group by 1, 2
),

labels as (
    select address, label from {{query:safenet_participant_labels}} where role = 'validator'
)

select
    s.period_start,
    s.period_end,
    date_format(s.period_start, '%Y-%m-%d') || ' – ' || date_format(s.period_end, '%Y-%m-%d') as period,
    s.validator as validator_address,
    coalesce(l.label, '0x' || lower(to_hex(s.validator))) as validator,
    s.avg_stake,
    s.avg_stake_all,
    s.avg_self_stake,
    s.avg_stake - s.avg_self_stake as avg_delegated_stake,
    s.stakers,
    coalesce(g.signed, 0) as signed,
    c.transactions,
    if(c.transactions > 0, 1.0 * coalesce(g.signed, 0) / c.transactions) as participation,
    coalesce(c.transactions > 0 and 1.0 * coalesce(g.signed, 0) / c.transactions >= 0.75, false) as eligible,
    st.settlement_block,
    st.settlement_time
from stake as s
left join settlement as st on st.period_end = s.period_end
left join counts as c on c.period_end = s.period_end
left join signed as g on g.period_end = s.period_end and g.validator = s.validator
left join labels as l on l.address = s.validator
