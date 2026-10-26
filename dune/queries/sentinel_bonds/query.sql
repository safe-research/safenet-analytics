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
        max(name) as name,
        max(sentinel_url) as sentinel_url,
        max(current_status) as status,
        count_if(committed_at is not null) as commitments,
        count_if(committed_at is not null and claimed_at is null) as unclaimed_commitments,
        sum(bond_amount) as posted,
        sum(if(committed_at is not null and claimed_at is null, bond_amount - slash_due, 0)) as locked,
        coalesce(sum(bond_returned), 0) as returned,
        sum(if(claimed_at is not null, bond_amount - bond_returned, 0)) as slashed_confirmed,
        sum(if(committed_at is not null and claimed_at is null, slash_due, 0)) as slashed_unclaimed,
        sum(if(slash_reason = 'missing_response', slash_due, 0)) as slashed_missing_response,
        sum(if(slash_reason = 'dispute_lost', slash_due, 0)) as slashed_dispute_lost,
        count_if(claimed_at is not null and bond_amount - bond_returned <> slash_due) as slash_rule_mismatches,
        max(through_block) as through_block
    from {{query:safenet_sentinel_responses}}
    group by 1
)

select
    '<a href="' || b.sentinel_url || '" target="_blank">' || b.name || '</a>' as sentinel_link,
    b.name,
    '0x' || lower(to_hex(b.sentinel)) as address,
    case b.status when 'active' then 'Active' when 'scheduled' then 'Scheduled' else 'Removed' end as current_status,
    coalesce(w.balance, 0) / 1e6 as available_usdc,
    b.locked / 1e6 as locked_usdc,
    b.unclaimed_commitments,
    b.commitments,
    b.posted / 1e6 as posted_usdc,
    b.returned / 1e6 as returned_usdc,
    b.slashed_confirmed / 1e6 as slashed_confirmed_usdc,
    b.slashed_unclaimed / 1e6 as slashed_unclaimed_usdc,
    b.slashed_missing_response / 1e6 as slashed_missing_response_usdc,
    b.slashed_dispute_lost / 1e6 as slashed_dispute_lost_usdc,
    b.slash_rule_mismatches,
    max(b.through_block) over () as through_block -- for the verification
from bonds as b
left join wallet as w on w.sentinel = b.sentinel
order by locked_usdc desc, b.name
