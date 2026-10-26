-- Safenet production: where the transaction fees went, all time, in USDC.e. Definitions:
-- docs/metrics/network-and-revenue.md#fee-allocation.
--
-- Accrued: what the contract rules assign (SentinelOracleRequests.sol), from the request model.
-- Paid: actual USDC.e transfers out of the Sentinel Oracle (safenet_fee_flows); Sentinels are paid
-- when they claim, refunds and the protocol funds receiver when the request ends.
-- Outstanding = accrued - paid: claimable or held by the oracle, a liability, not revenue.
-- Bonds are the Sentinels' own deposits and are listed separately; they are not revenue. Slashed
-- bonds fund dispute refunds; any rest goes to the protocol funds receiver.
-- Checks at the end must be 0: fees recorded vs fees transferred, unclassified transfers, and the
-- oracle's USDC.e balance vs its outstanding obligations.

with

requests as (
    select * from {{query:safenet_requests}}
),

flows as (
    select * from {{query:safenet_fee_flows}}
),

labels as (
    select address, label from {{query:safenet_participant_labels}} where role = 'sentinel'
),

-- Winning revealers of decided requests and their share: floor((fee - DAO share) / winners).
winning_votes as (
    select
        e.sentinel,
        (r.fee - r.dao_share_amount) / r.winners as reward
    from {{query:safenet_events}} as e
    join requests as r on r.request_id = e.request_id
    where e.event = 'revealed'
        and r.completed
        and e.vote_approved = (r.verdict = 'approved')
),

claims as (
    select to_address as sentinel, sum(amount) as amount
    from flows
    where flow = 'claim_out'
    group by 1
),

claimed_rewards as (
    select sentinel, sum(fee_reward) as fee_reward, sum(bond_amount) as bond_returned
    from {{query:safenet_events}}
    where event = 'claimed'
    group by 1
),

sentinels as (
    select
        w.sentinel,
        sum(w.reward) as accrued
    from winning_votes as w
    group by 1
),

totals as (
    select
        sum(fee) as fees,
        sum(if(sponsor_refund_source = 'fee', sponsor_refund, 0)) as refunds_from_fee,
        sum(if(sponsor_refund_source = 'slashed_bonds', sponsor_refund, 0)) as refunds_from_slashes,
        sum(fee_reward_accrued) as rewards_accrued,
        sum(fee_reward_claimed) as rewards_claimed,
        sum(receiver_amount) as receiver_accrued,
        sum(fee_held) as fee_held,
        sum(bond_locked) as bonds_locked,
        sum(bond_returned) as bonds_returned,
        sum(bond_slashed) as bonds_slashed,
        min(dao_fee_share) as min_dao_fee_share,
        max(dao_fee_share) as max_dao_fee_share
    from requests
),

flow_totals as (
    select
        coalesce(sum(if(flow = 'fee_in', amount)), 0) as fee_in,
        coalesce(sum(if(flow = 'bond_in', amount)), 0) as bond_in,
        coalesce(sum(if(flow = 'refund_out', amount)), 0) as refund_out,
        coalesce(sum(if(flow = 'receiver_out', amount)), 0) as receiver_out,
        coalesce(sum(if(flow = 'claim_out', amount)), 0) as claim_out,
        coalesce(sum(if(flow = 'unclassified', amount)), 0) as unclassified,
        coalesce(sum(if(direction = 'in', amount, -amount)), 0) as balance
    from flows
),

rows_ as (
    -- Fees
    select 1 as sort_order, 'Fees' as section, 'Gross fees collected' as item, cast(null as varchar) as recipient,
        t.fees as accrued, f.fee_in as paid, cast(null as bigint) as outstanding,
        'Paid by sponsors with each request; "paid" is the USDC.e received' as note
    from totals as t, flow_totals as f
    union all
    select 2, 'Fees', 'Refunded to sponsors (no verdict)', 'sponsors', t.refunds_from_fee,
        cast(null as bigint), cast(null as bigint), 'Full fee back after a timeout, out-of-scope dispute or arbitration timeout'
    from totals as t
    union all
    select 3, 'Fees', 'Sentinel fee rewards', 'Sentinels (below)', t.rewards_accrued, t.rewards_claimed,
        t.rewards_accrued - t.rewards_claimed, 'Shared by the winning revealers; paid when claimed'
    from totals as t
    union all
    select 4, 'Fees', 'Protocol funds receiver', '<a href="https://gnosisscan.io/address/0x9d02bed59170cde96782ea9a9b17f9bcf4916127" target="_blank">0x9d02…6127</a>',
        t.receiver_accrued, f.receiver_out, t.receiver_accrued - f.receiver_out,
        'DAO share (' || cast(t.max_dao_fee_share / 1000.0 as varchar) || '%), split remainders and slashes beyond refunds'
    from totals as t, flow_totals as f
    union all
    select 5, 'Fees', 'Held for undecided requests', 'Sentinel Oracle', t.fee_held, cast(null as bigint), t.fee_held,
        'Voting open or dispute awaiting a ruling'
    from totals as t
    union all
    -- Per Sentinel
    select 10, 'Sentinel fee rewards',
        coalesce(l.label, '0x' || lower(to_hex(s.sentinel))),
        '<a href="https://gnosisscan.io/address/0x' || lower(to_hex(s.sentinel)) || '" target="_blank">0x' || lower(to_hex(s.sentinel)) || '</a>',
        s.accrued, coalesce(c.fee_reward, 0), s.accrued - coalesce(c.fee_reward, 0), 'Label from safenet-data; not a membership statement'
    from sentinels as s
    left join claimed_rewards as c on c.sentinel = s.sentinel
    left join labels as l on l.address = s.sentinel
    union all
    -- Dispute refunds come from slashed bonds, not from fees
    select 20, 'Dispute refunds', 'Refunded to sponsors after arbitration', 'sponsors', t.refunds_from_slashes,
        cast(null as bigint), cast(null as bigint), 'Funded by the losing Sentinels'' slashed bonds; the fee still goes to the winners'
    from totals as t
    union all
    select 21, 'Dispute refunds', 'All refunds paid', 'sponsors', t.refunds_from_fee + t.refunds_from_slashes, f.refund_out,
        t.refunds_from_fee + t.refunds_from_slashes - f.refund_out, 'Accrued refunds vs USDC.e transfers to sponsors'
    from totals as t, flow_totals as f
    union all
    -- Bonds (not revenue)
    select 30, 'Bonds (not revenue)', 'Deposited by Sentinels', 'Sentinel Oracle', t.bonds_locked, f.bond_in, cast(null as bigint),
        '800 USDC.e per vote; "paid" is the USDC.e received'
    from totals as t, flow_totals as f
    union all
    select 31, 'Bonds (not revenue)', 'Returned to Sentinels', 'Sentinels', t.bonds_returned, t.bonds_returned, cast(null as bigint),
        'With claims'
    from totals as t
    union all
    select 32, 'Bonds (not revenue)', 'Slashed', 'sponsors / receiver', t.bonds_slashed, cast(null as bigint), cast(null as bigint),
        'Losing a dispute, or not revealing a committed vote'
    from totals as t
    union all
    select 33, 'Bonds (not revenue)', 'Outstanding (unclaimed)', 'Sentinels', t.bonds_locked - t.bonds_returned - t.bonds_slashed,
        cast(null as bigint), t.bonds_locked - t.bonds_returned - t.bonds_slashed, 'Claimable once the request is decided'
    from totals as t
    union all
    -- Checks (expected 0)
    select 40, 'Checks (expected 0)', 'Fees recorded minus fees received', null, t.fees - f.fee_in, null, null, 'NewRequest.fee vs USDC.e transfers'
    from totals as t, flow_totals as f
    union all
    select 41, 'Checks (expected 0)', 'Claims: events minus transfers', null,
        (select coalesce(sum(fee_reward + bond_amount), 0) from {{query:safenet_events}} where event = 'claimed') - f.claim_out, null, null,
        'Claimed(bondReturn + feeReward) vs USDC.e transfers to Sentinels'
    from flow_totals as f
    union all
    select 42, 'Checks (expected 0)', 'Unclassified oracle transfers', null, f.unclassified, null, null,
        'USDC.e moved without a matching oracle event in the same transaction'
    from flow_totals as f
    union all
    select 43, 'Checks (expected 0)', 'Oracle balance minus obligations', null,
        f.balance - (t.fee_held + (t.rewards_accrued - t.rewards_claimed) + (t.bonds_locked - t.bonds_returned - t.bonds_slashed)
            + (t.receiver_accrued - f.receiver_out)),
        null, null, 'USDC.e held = held fees + unclaimed rewards + unclaimed bonds'
    from totals as t, flow_totals as f
)

select
    section,
    item,
    recipient,
    accrued / 1e6 as accrued_usdc,
    paid / 1e6 as paid_usdc,
    outstanding / 1e6 as outstanding_usdc,
    note,
    sort_order,
    (select max(block_number) from {{query:safenet_events}}) as through_block -- for the verification
from rows_
order by sort_order, accrued desc
