-- Safenet production: Sentinel bonds per Sentinel, in USDC.e. Current balances first, then all-time
-- bond movements. Definitions: docs/metrics/sentinels.md#bonds.
--
-- There is no bond account in the Sentinel Oracle: each commit transfers the request's bond
-- (800 USDC.e so far) from the Sentinel into the oracle, and the claim after the request is decided
-- returns it, minus any slash (SentinelOracle.sol commit, claim; SentinelOracleRequests.sol
-- slashAmountFor).
--
-- Now:
--   available  USDC.e in the Sentinel's own account on Gnosis Chain, which it can bond next
--              (safenet_sentinel_wallet_transfers; checked against balanceOf by the verification)
--   locked     bonds of unclaimed commitments still held by the oracle: bond minus any slash
--              already taken
-- All time:
--   posted     bonds transferred in with commits;  returned  Claimed.bondReturn
--   slashed    taken at finalize (a committed vote never revealed while another Sentinel revealed)
--              or at the arbitrator's ruling (a revealed loser of a ruled dispute). confirmed: shown
--              per Sentinel by its claim (bond - bondReturn); unclaimed: taken from the bond per the
--              contract rule, not yet claimed. Disputes without a ruling, and timeouts with no
--              reveal at all, slash nobody.
--   slash_rule_mismatches  claims whose bondReturn differs from the contract rule; expected 0

with

responses as (
    select * from {{query:safenet_sentinel_responses}}
    where committed_at is not null
),

terms as (
    select sentinel, max_by(name, scheduled_block) as name, max_by(sentinel_url, scheduled_block) as sentinel_url,
        max_by(term_status, scheduled_block) as status
    from {{query:safenet_sentinel_terms}}
    group by 1
),

wallet as (
    select
        sentinel,
        sum(if(direction = 'in', cast(amount as double), -cast(amount as double))) as balance
    from {{query:safenet_sentinel_wallet_transfers}}
    group by 1
),

bonds as (
    select
        sentinel,
        count(*) as commitments,
        count_if(claimed_at is null) as unclaimed_commitments,
        sum(bond_amount) as posted,
        sum(if(claimed_at is null, bond_amount - slash_due, 0)) as locked,
        coalesce(sum(bond_returned), 0) as returned,
        sum(if(claimed_at is not null, bond_amount - bond_returned, 0)) as slashed_confirmed,
        sum(if(claimed_at is null, slash_due, 0)) as slashed_unclaimed,
        sum(if(slash_reason = 'missing_response', slash_due, 0)) as slashed_missing_response,
        sum(if(slash_reason = 'dispute_lost', slash_due, 0)) as slashed_dispute_lost,
        count_if(claimed_at is not null and bond_amount - bond_returned <> slash_due) as slash_rule_mismatches
    from responses
    group by 1
)

select
    '<a href="' || t.sentinel_url || '" target="_blank">' || t.name || '</a>' as sentinel_link,
    t.name,
    '0x' || lower(to_hex(t.sentinel)) as address,
    case t.status when 'active' then 'Active' when 'scheduled' then 'Scheduled' else 'Removed' end as current_status,
    coalesce(w.balance, 0) / 1e6 as available_usdc,
    coalesce(b.locked, 0) / 1e6 as locked_usdc,
    coalesce(b.unclaimed_commitments, 0) as unclaimed_commitments,
    coalesce(b.commitments, 0) as commitments,
    coalesce(b.posted, 0) / 1e6 as posted_usdc,
    coalesce(b.returned, 0) / 1e6 as returned_usdc,
    coalesce(b.slashed_confirmed, 0) / 1e6 as slashed_confirmed_usdc,
    coalesce(b.slashed_unclaimed, 0) / 1e6 as slashed_unclaimed_usdc,
    coalesce(b.slashed_missing_response, 0) / 1e6 as slashed_missing_response_usdc,
    coalesce(b.slashed_dispute_lost, 0) / 1e6 as slashed_dispute_lost_usdc,
    coalesce(b.slash_rule_mismatches, 0) as slash_rule_mismatches,
    (select max(block_number) from {{query:safenet_events}}) as through_block -- for the verification
from terms as t
left join bonds as b on b.sentinel = t.sentinel
left join wallet as w on w.sentinel = t.sentinel
order by locked_usdc desc, t.name
