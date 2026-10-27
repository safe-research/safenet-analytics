-- Safenet staking rewards of validator staker addresses now: allocated (published), withheld until
-- KYC, claimed and claimable. Definitions: docs/metrics/validators.md#rewards.
--
-- One row per address ever registered as a validator's staker (Consensus.ValidatorStakerSet, Beta or
-- production). Its rewards are its commission and the reward on its own stake together, plus any
-- delegations it made to other validators; the published files do not split them. Claims are
-- attributed by address only (distributor Claimed events); delegators' claims are not attributed to
-- validators.
--   allocated   cumulative amount + KYC-withheld under the latest published root
--   claimable   cumulative amount (not withheld) - claimed, if the latest root is set on chain

with

latest as (
    select max(root_order) as root_order from {{query:safenet_validator_rewards}} where kind_row = 'root'
),

amounts as (
    select r.address, r.cumulative_amount, r.kyc_amount, r.merkle_root
    from {{query:safenet_validator_rewards}} as r
    join latest as l on l.root_order = r.root_order
    where r.kind_row = 'entry'
),

stakers as (
    select
        staker,
        array_join(array_agg(distinct coalesce(lb.label, '0x' || lower(to_hex(h.validator)))), ', ') as validators,
        array_join(array_agg(distinct h.era), ', ') as eras
    from {{query:validator_staker_history}} as h
    left join {{query:safenet_participant_labels}} as lb on lb.address = h.validator and lb.role = 'validator'
    group by 1
),

claims as (
    select account, sum(amount) as claimed
    from {{query:safenet_reward_events}}
    where event = 'claimed'
    group by 1
),

roots_on_chain as (
    select distinct new_root from {{query:safenet_reward_events}} where event = 'root_updated'
)

select
    '<a href="https://etherscan.io/address/0x' || lower(to_hex(s.staker)) || '" target="_blank">0x'
        || substr(lower(to_hex(s.staker)), 1, 4) || '…' || substr(lower(to_hex(s.staker)), 37, 4) || '</a>' as staker,
    s.validators,
    s.eras,
    (cast(coalesce(a.cumulative_amount, cast(0 as uint256)) as double) + cast(coalesce(a.kyc_amount, cast(0 as uint256)) as double)) / 1e18 as allocated,
    cast(coalesce(a.kyc_amount, cast(0 as uint256)) as double) / 1e18 as withheld_kyc,
    cast(coalesce(c.claimed, cast(0 as uint256)) as double) / 1e18 as claimed,
    if(o.new_root is null, null,
        (cast(coalesce(a.cumulative_amount, cast(0 as uint256)) as double) - cast(coalesce(c.claimed, cast(0 as uint256)) as double)) / 1e18) as claimable,
    if(a.address is null, 'no published allocation', 'commission + own-stake reward (+ own delegations), not split') as note,
    '0x' || lower(to_hex(s.staker)) as staker_address
from stakers as s
left join amounts as a on a.address = s.staker
left join claims as c on c.account = s.staker
left join roots_on_chain as o on o.new_root = a.merkle_root
order by allocated desc
