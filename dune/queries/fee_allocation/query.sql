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
--
-- Query size: Dune inlines every query reference and CTE where it is used, so each model is read
-- exactly once here (docs/decoding.md#the-decoding-query). safenet_requests, safenet_fee_flows
-- and safenet_sentinel_responses are each reduced to one row of totals, and the output rows are
-- expanded from that single row. Per-Sentinel fee rewards come from safenet_sentinel_responses,
-- the per-(request, Sentinel) model of the Sentinels section, with the same rule as before:
-- floor((fee - DAO share) / winners) for each winning revealer of a decided request.

with

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
        max(dao_fee_share) as max_dao_fee_share
    from {{query:safenet_requests}}
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
    from {{query:safenet_fee_flows}}
),

-- Fee rewards per Sentinel (accrued: winning revealers' shares; paid: Claimed.feeReward), and the
-- claims recorded by events for the check against transfers.
per_sentinel as (
    select
        sentinel,
        max(name) as name,
        sum(fee_reward_accrued) as accrued,
        coalesce(sum(fee_reward_claimed), 0) as claimed,
        coalesce(sum(fee_reward_claimed), 0) + coalesce(sum(bond_returned), 0) as claim_events,
        max(through_block) as through_block
    from {{query:safenet_sentinel_responses}}
    group by 1
),

sentinel_totals as (
    select
        array_agg(
            cast(row(
                10, 'Sentinel fee rewards', name,
                '<a href="https://gnosisscan.io/address/0x' || lower(to_hex(sentinel)) || '" target="_blank">0x' || lower(to_hex(sentinel)) || '</a>',
                accrued, claimed, accrued - claimed, 'Label from safenet-data; not a membership statement'
            ) as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar))
        ) filter (where accrued > 0 or claimed > 0) as sentinel_rows,
        coalesce(sum(claim_events), 0) as claim_events,
        max(through_block) as through_block
    from per_sentinel
),

base as (
    select * from totals cross join flow_totals cross join sentinel_totals
)

select
    r.section,
    r.item,
    r.recipient,
    r.accrued / 1e6 as accrued_usdc,
    r.paid / 1e6 as paid_usdc,
    r.outstanding / 1e6 as outstanding_usdc,
    r.note,
    r.sort_order,
    b.through_block -- for the verification
from base as b
cross join unnest(concat(
    array[
        -- Fees
        cast(row(1, 'Fees', 'Gross fees collected', cast(null as varchar), b.fees, b.fee_in, cast(null as bigint),
            'Paid by sponsors with each request; "paid" is the USDC.e received')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar)),
        cast(row(2, 'Fees', 'Refunded to sponsors (no verdict)', 'sponsors', b.refunds_from_fee, cast(null as bigint), cast(null as bigint),
            'Full fee back after a timeout, out-of-scope dispute or arbitration timeout')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar)),
        cast(row(3, 'Fees', 'Sentinel fee rewards', 'Sentinels (below)', b.rewards_accrued, b.rewards_claimed,
            b.rewards_accrued - b.rewards_claimed, 'Shared by the winning revealers; paid when claimed')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar)),
        cast(row(4, 'Fees', 'Protocol funds receiver', '<a href="https://gnosisscan.io/address/0x9d02bed59170cde96782ea9a9b17f9bcf4916127" target="_blank">0x9d02…6127</a>',
            b.receiver_accrued, b.receiver_out, b.receiver_accrued - b.receiver_out,
            'DAO share (' || cast(b.max_dao_fee_share / 1000.0 as varchar) || '%), split remainders and slashes beyond refunds')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar)),
        cast(row(5, 'Fees', 'Held for undecided requests', 'Sentinel Oracle', b.fee_held, cast(null as bigint), b.fee_held,
            'Voting open or dispute awaiting a ruling')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar)),
        -- Dispute refunds come from slashed bonds, not from fees
        cast(row(20, 'Dispute refunds', 'Refunded to sponsors after arbitration', 'sponsors', b.refunds_from_slashes,
            cast(null as bigint), cast(null as bigint), 'Funded by the losing Sentinels'' slashed bonds; the fee still goes to the winners')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar)),
        cast(row(21, 'Dispute refunds', 'All refunds paid', 'sponsors', b.refunds_from_fee + b.refunds_from_slashes, b.refund_out,
            b.refunds_from_fee + b.refunds_from_slashes - b.refund_out, 'Accrued refunds vs USDC.e transfers to sponsors')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar)),
        -- Bonds (not revenue)
        cast(row(30, 'Bonds (not revenue)', 'Deposited by Sentinels', 'Sentinel Oracle', b.bonds_locked, b.bond_in, cast(null as bigint),
            '800 USDC.e per vote; "paid" is the USDC.e received')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar)),
        cast(row(31, 'Bonds (not revenue)', 'Returned to Sentinels', 'Sentinels', b.bonds_returned, b.bonds_returned, cast(null as bigint),
            'With claims')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar)),
        cast(row(32, 'Bonds (not revenue)', 'Slashed', 'sponsors / receiver', b.bonds_slashed, cast(null as bigint), cast(null as bigint),
            'Losing a dispute, or not revealing a committed vote')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar)),
        cast(row(33, 'Bonds (not revenue)', 'Outstanding (unclaimed)', 'Sentinels', b.bonds_locked - b.bonds_returned - b.bonds_slashed,
            cast(null as bigint), b.bonds_locked - b.bonds_returned - b.bonds_slashed, 'Claimable once the request is decided')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar)),
        -- Checks (expected 0)
        cast(row(40, 'Checks (expected 0)', 'Fees recorded minus fees received', cast(null as varchar), b.fees - b.fee_in,
            cast(null as bigint), cast(null as bigint), 'NewRequest.fee vs USDC.e transfers')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar)),
        cast(row(41, 'Checks (expected 0)', 'Claims: events minus transfers', cast(null as varchar), b.claim_events - b.claim_out,
            cast(null as bigint), cast(null as bigint), 'Claimed(bondReturn + feeReward) vs USDC.e transfers to Sentinels')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar)),
        cast(row(42, 'Checks (expected 0)', 'Unclassified oracle transfers', cast(null as varchar), b.unclassified,
            cast(null as bigint), cast(null as bigint), 'USDC.e moved without a matching oracle event in the same transaction')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar)),
        cast(row(43, 'Checks (expected 0)', 'Oracle balance minus obligations', cast(null as varchar),
            b.balance - (b.fee_held + (b.rewards_accrued - b.rewards_claimed) + (b.bonds_locked - b.bonds_returned - b.bonds_slashed)
                + (b.receiver_accrued - b.receiver_out)),
            cast(null as bigint), cast(null as bigint), 'USDC.e held = held fees + unclaimed rewards + unclaimed bonds')
            as row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar))
    ],
    coalesce(b.sentinel_rows, cast(array[] as array(row(sort_order integer, section varchar, item varchar, recipient varchar, accrued bigint, paid bigint, outstanding bigint, note varchar))))
)) as r (sort_order, section, item, recipient, accrued, paid, outstanding, note)
order by r.sort_order, r.accrued desc
