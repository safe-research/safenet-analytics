-- Safenet production: Sentinel earnings per Sentinel, all time, with transaction-fee rewards (USDC.e)
-- and SAFE subsidies in separate columns, never added together. Bonds are not earnings and are in
-- sentinel_bonds. Definitions: docs/metrics/sentinels.md#earnings.
--
-- Fee rewards (USDC.e), per SentinelOracleRequests.sol:
--   accrued      the Sentinel's share of decided requests it won: floor((fee - DAO share) / winners)
--   claimed      Claimed.feeReward (paid with the claim)
--   outstanding  accrued - claimed: claimable from the Sentinel Oracle
--   accrued_30d  accrued on requests decided in the last 30 days
-- Every request counts, test traffic too, as in the Network & revenue fee allocation, which these
-- per-Sentinel figures equal.
--
-- SAFE subsidies are published by the Safe Foundation as Merkle roots of the rewards distributor on
-- Ethereum (safenet_sentinel_rewards, from safe-fndn/safenet-data; claims in safenet_reward_events):
--   published  the cumulative SAFE published for the address under the latest published root. The
--              files publish one amount per address for every reward type; for a Sentinel that also
--              stakes, the Sentinel part cannot be separated.
--   claimed    SAFE claimed by the address from the distributor (Claimed events)
--   claimable  published - claimed, when the latest published root is the distributor's current root
-- Without a published entry the subsidy columns say so instead of showing 0.

with

responses as (
    select * from {{query:safenet_sentinel_responses}}
),

terms as (
    select sentinel, max_by(name, scheduled_block) as name, max_by(sentinel_url, scheduled_block) as sentinel_url
    from {{query:safenet_sentinel_terms}}
    group by 1
),

fees as (
    select
        sentinel,
        sum(fee_reward_accrued) as accrued,
        coalesce(sum(fee_reward_claimed), 0) as claimed,
        sum(if(outcome_at >= now() - interval '30' day, fee_reward_accrued, 0)) as accrued_30d,
        count_if(fee_reward_accrued > 0) as rewarded_requests
    from responses
    group by 1
),

published as (
    select * from {{query:safenet_sentinel_rewards}}
),

latest_root as (
    select max_by(merkle_root, root_order) as merkle_root, max_by(rewards_until, root_order) as rewards_until
    from published
    where kind = 'root'
),

onchain_root as (
    select max_by(new_root, block_number) as merkle_root
    from {{query:safenet_reward_events}}
    where event = 'root_updated'
),

safe_published as (
    select p.address, p.cumulative_amount
    from published as p
    join latest_root as l on l.merkle_root = p.merkle_root
    where p.kind = 'entry'
),

safe_claimed as (
    select account, sum(amount) as amount
    from {{query:safenet_reward_events}}
    where event = 'claimed'
    group by 1
)

select
    '<a href="' || t.sentinel_url || '" target="_blank">' || t.name || '</a>' as sentinel_link,
    t.name,
    '0x' || lower(to_hex(t.sentinel)) as address,
    coalesce(f.accrued, 0) / 1e6 as fee_accrued_usdc,
    coalesce(f.claimed, 0) / 1e6 as fee_claimed_usdc,
    (coalesce(f.accrued, 0) - coalesce(f.claimed, 0)) / 1e6 as fee_outstanding_usdc,
    coalesce(f.accrued_30d, 0) / 1e6 as fee_accrued_30d_usdc,
    coalesce(f.rewarded_requests, 0) as rewarded_requests,
    case
        when sp.address is null then 'No allocation published (latest root: rewards until ' || format_datetime(l.rewards_until, 'yyyy-MM-dd') || ')'
        else format('%,.2f', cast(sp.cumulative_amount as double) / 1e18) || ' SAFE (all reward types)'
    end as safe_published,
    coalesce(cast(sc.amount as double), 0) / 1e18 as safe_claimed,
    case
        when sp.address is null then 'n/a'
        when o.merkle_root is null or l.merkle_root <> o.merkle_root then 'not available: published root is not the distributor''s current root'
        else format('%,.2f', (cast(sp.cumulative_amount as double) - coalesce(cast(sc.amount as double), 0)) / 1e18) || ' SAFE'
    end as safe_claimable,
    coalesce(l.merkle_root = o.merkle_root, false) as published_root_is_current,
    (select max(block_number) from {{query:safenet_events}}) as through_block -- for the verification
from terms as t
left join fees as f on f.sentinel = t.sentinel
left join safe_published as sp on sp.address = t.sentinel
left join safe_claimed as sc on sc.account = t.sentinel
cross join latest_root as l
cross join onchain_root as o
order by fee_accrued_usdc desc, t.name
