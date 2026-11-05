-- Realized staking APR per completed Aegis reward period and validator. Historical, never a
-- projection. Definitions: docs/metrics/staking.md#realized-apr.
--
-- Stake, participation and eligibility come from chain data (staking_period_validators). Rewards per
-- validator are not in the published files: they come from a verified split only
-- (safenet_reward_breakdown, recorded where safenet-staking-scripts at a pinned commit reproduces the
-- published payouts of every address exactly). Without one, rewards and APR stay blank.
--
--   gross_apr       validator reward (own stake + delegations, before commission) / average stake
--   delegator_apr   delegators' rewards net of commission / average delegated stake: what a
--                   delegation to this validator earned
--   self_stake_apr  the registered staker's own-stake reward / average self-stake (no commission)
--   commission      5% of delegators' rewards if the validator's average self-stake was >= 3.5M SAFE,
--                   paid to its beneficiary (its staker, or a DelegateRegistry delegate); not a
--                   return on stake, so not in any APR
-- An ineligible validator (below 75% participation) earned nothing: 0%, shown only once the period
-- is published.

with

v as (
    select * from {{query:staking_period_validators}}
),

b as (
    select * from {{query:safenet_reward_breakdown}}
),

split as (
    select * from b where kind_row = 'validator'
),

published as (
    select period_end from b where kind_row = 'period'
),

rows_ as (
    select
        v.*,
        p.period_end is not null as is_published,
        x.validator is not null as verified,
        cast(x.reward_raw as double) / 1e18 as reward,
        cast(x.self_reward_raw as double) / 1e18 as self_reward,
        cast(x.delegator_reward_raw as double) / 1e18 as delegator_reward,
        cast(x.commission_raw as double) / 1e18 as commission,
        x.commission_charged,
        x.beneficiary,
        x.scripts_commit,
        365.0 * 86400 / date_diff('second', v.period_start, v.period_end) as annualization
    from v
    left join published as p on p.period_end = v.period_end
    left join split as x on x.period_end = v.period_end and x.validator = v.validator_address
    where v.avg_stake_all > 0
)

select
    period,
    period_start,
    period_end,
    validator,
    case
        when not is_published then 'not yet published'
        when not verified then 'split not verified'
        when eligible then 'eligible'
        else 'ineligible (participation < 75%)'
    end as status,
    eligible,
    participation,
    signed,
    transactions,
    avg_stake,
    avg_self_stake,
    avg_delegated_stake,
    avg_stake_all - avg_stake as avg_stake_while_deregistered,
    stakers,
    reward,
    self_reward,
    delegator_reward,
    commission,
    commission_charged,
    if(verified and avg_stake > 0, 100 * reward / avg_stake * annualization) as gross_apr,
    if(verified and avg_delegated_stake > 0, 100 * delegator_reward / avg_delegated_stake * annualization) as delegator_apr,
    if(verified and avg_self_stake > 0, 100 * self_reward / avg_self_stake * annualization) as self_stake_apr,
    if(beneficiary is null or beneficiary = 0x0000000000000000000000000000000000000000, null,
        '<a href="https://etherscan.io/address/0x' || lower(to_hex(beneficiary)) || '" target="_blank">0x'
        || substr(lower(to_hex(beneficiary)), 1, 4) || '…' || substr(lower(to_hex(beneficiary)), 37, 4) || '</a>') as commission_beneficiary,
    if(verified, 'safenet-staking-scripts ' || substr(scripts_commit, 1, 7)) as source,
    '0x' || lower(to_hex(validator_address)) as validator_address
from rows_
order by period_end desc, avg_stake desc
