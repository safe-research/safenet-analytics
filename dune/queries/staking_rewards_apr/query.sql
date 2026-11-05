-- Realized staking APR per completed reward period, Beta (2026-04-07 – 2026-10-06) and Aegis (from
-- 2026-10-13): published staking rewards over the time-weighted stake that earned them, annualized
-- without compounding. Historical, never a projection. Definitions: docs/metrics/staking.md#realized-apr.
-- Beta and Aegis had different reward budgets (Beta 4.5M SAFE over 26 weeks, Aegis 5M over 52), so
-- their rates are not comparable as a trend; every row and series says which programme it is.
--
--   APR = stake rewards / average eligible stake × 365 days / period length × 100
--
--   stake_rewards     SAFE allocated in the period minus Sentinel grants (safenet_reward_breakdown):
--                     every validator's and delegator's staking reward and the commission, KYC-
--                     withheld amounts included. Sentinel grants are not a return on stake.
--   eligible_stake    average stake on validators with at least 75% reward participation, while
--                     registered (staking_period_validators; Beta: validator_beta_participation)
--   pool_apr          stake_rewards / eligible_stake, annualized: the average over eligible stake,
--                     before commission. Rates differ by validator (by_validator).
--   apr_all_stake     stake_rewards / all average stake in the contract, ineligible included
--   delegator_apr     what delegations earned net of commission: delegators' rewards / delegated
--                     eligible stake, from a verified split only (derived from the published
--                     payouts and chain data, safenet_reward_breakdown); null otherwise
-- A period that has ended but is not published shows its stake and no rewards or APR, never 0.

with

v as (
    select * from {{query:staking_period_validators}}
),

b as (
    select * from {{query:safenet_reward_breakdown}}
),

published as (
    select period_start, period_end, merkle_root, stake_rewards_raw, sentinel_raw, payout_raw, kyc_withheld_raw,
        kyc_withheld_stake_raw, payout_addresses, commission_raw, split_source
    from b
    where kind_row = 'period'
),

split as (
    select period_start, period_end, sum(cast(delegator_reward_raw as double)) / 1e18 as delegator_rewards,
        sum(cast(self_reward_raw as double)) / 1e18 as self_rewards
    from b
    where kind_row = 'validator'
    group by 1, 2
),

on_chain as (
    select distinct new_root from {{query:safenet_reward_events}} where event = 'root_updated'
),

stake as (
    select
        period_start,
        period_end,
        max(period_label) as period,
        max(era) as era,
        count_if(eligible is null and avg_stake > 0) as unknown_eligibility,
        sum(avg_stake_all) as total_stake,
        sum(avg_stake) as registered_stake,
        sum(if(eligible, avg_stake, 0)) as eligible_stake,
        sum(if(eligible, avg_delegated_stake, 0)) as eligible_delegated_stake,
        sum(if(eligible, avg_self_stake, 0)) as eligible_self_stake,
        count_if(eligible) as eligible_validators,
        count_if(avg_stake_all > 0) as validators_with_stake,
        array_join(array_agg(if(not eligible and avg_stake_all > 0, validator)), ', ') as ineligible,
        max(settlement_block) as settlement_block,
        date_diff('second', period_start, period_end) as period_seconds
    from v
    group by 1, 2
),

rows_ as (
    select
        s.*,
        p.period_end is not null as is_published,
        cast(p.stake_rewards_raw as double) / 1e18 as stake_rewards,
        cast(p.sentinel_raw as double) / 1e18 as sentinel_grants,
        cast(p.kyc_withheld_stake_raw as double) / 1e18 as kyc_withheld_stake,
        cast(p.commission_raw as double) / 1e18 as commission,
        p.payout_addresses,
        p.split_source,
        '0x' || lower(to_hex(p.merkle_root)) as merkle_root,
        c.new_root is not null as root_on_chain,
        x.delegator_rewards,
        365.0 * 86400 / s.period_seconds as annualization
    from stake as s
    -- rewards attach to the fixed period with the same start and end, never to another period
    left join published as p on p.period_start = s.period_start and p.period_end = s.period_end
    left join split as x on x.period_start = s.period_start and x.period_end = s.period_end
    left join on_chain as c on c.new_root = p.merkle_root
)

select
    period,
    if(era = 'beta', 'Beta', 'Aegis') as programme,
    period_start,
    period_end,
    if(is_published, 'published', 'not yet published') as status,
    root_on_chain,
    stake_rewards,
    sentinel_grants,
    kyc_withheld_stake,
    commission,
    if(not is_published, 'not published', if(split_source is null, 'split not verified',
        'verified: ' || split_source)) as split_status,
    eligible_stake,
    total_stake,
    total_stake - eligible_stake as ineligible_stake,
    eligible_delegated_stake,
    eligible_validators,
    validators_with_stake,
    ineligible as ineligible_validators,
    if(is_published and unknown_eligibility = 0 and eligible_stake > 0, 100 * stake_rewards / eligible_stake * annualization) as pool_apr,
    if(is_published and total_stake > 0, 100 * stake_rewards / total_stake * annualization) as apr_all_stake,
    if(delegator_rewards is not null and eligible_delegated_stake > 0,
        100 * delegator_rewards / eligible_delegated_stake * annualization) as delegator_apr,
    -- the chart's series, one per programme: Beta in greys, Aegis in colour
    if(era <> 'beta' and is_published and unknown_eligibility = 0 and eligible_stake > 0, 100 * stake_rewards / eligible_stake * annualization) as pool_apr_aegis,
    if(era <> 'beta' and delegator_rewards is not null and eligible_delegated_stake > 0, 100 * delegator_rewards / eligible_delegated_stake * annualization) as delegator_apr_aegis,
    if(era <> 'beta' and is_published and total_stake > 0, 100 * stake_rewards / total_stake * annualization) as apr_all_stake_aegis,
    if(era = 'beta' and is_published and unknown_eligibility = 0 and eligible_stake > 0, 100 * stake_rewards / eligible_stake * annualization) as pool_apr_beta,
    if(era = 'beta' and delegator_rewards is not null and eligible_delegated_stake > 0, 100 * delegator_rewards / eligible_delegated_stake * annualization) as delegator_apr_beta,
    if(era = 'beta' and is_published and total_stake > 0, 100 * stake_rewards / total_stake * annualization) as apr_all_stake_beta,
    if(era = 'beta', 'Beta programme (4.5M SAFE over 26 weeks); ', 'Aegis programme (5M SAFE over 52 weeks); ') || 'eligible = participation >= 75%; '
        || 'stake rewards / time-weighted eligible stake × 365 d / ' || cast(period_seconds / 86400 as varchar)
        || ' d; non-compounded; Sentinel grants excluded' as basis,
    payout_addresses,
    settlement_block,
    merkle_root
from rows_
-- Aegis first, then published first, newest first: the headline counter reads the first row, the
-- latest published Aegis period.
order by era = 'beta', is_published desc, period_end desc
