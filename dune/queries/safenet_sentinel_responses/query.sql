-- Safenet production: one row per (request, Sentinel) where the Sentinel was eligible to respond
-- or committed. The shared model behind the Sentinels section; definitions in
-- docs/metrics/sentinels.md. Amounts are USDC.e base units.
--
-- eligible: the Sentinel was a member during the request's commit window (safenet_sentinel_terms):
--   active_from_block <= commit_deadline, and not removed at or before the proposal block. A
--   Sentinel that committed is always included, so rates cannot exceed 100%.
--
-- response_state (one per row, as of as_of_block, the latest Gnosis block Dune has ingested):
--   secure            valid reveal approving (Revealed.approved = true)
--   insecure          valid reveal denying
--   missing_response  committed, never revealed, and the reveal window has closed or the request has
--                     ended. Commit-only is not a response; the bond is slashed if anyone revealed.
--   reverted_commit   eligible, no successful commit, but a commit call that reverted (late, or
--                     invalid, for example without enough USDC.e for the bond): an attempted but
--                     invalid submission, not a response
--   no_commit         eligible, did not commit or try to, commit window closed: an abstain verdict
--                     or the Sentinel being offline, which leave the same (empty) trace on chain
--   pending_reveal    committed, reveal window still open
--   pending_commit    eligible, not committed, commit window still open
-- window_closed: the response is final (every state except pending_*). Participation rates use
-- window_closed rows only.
--
-- Fees and bonds per row follow SentinelOracleRequests.sol (calcFeeReward, slashAmountFor):
--   fee_reward_accrued  the winner's share floor((fee - DAO share) / winners) on a verdict
--   slash_due           slashAmount for a missing response once either side was revealed, and for a
--                       revealed loser of an arbitrated dispute; else 0. Taken from the bond when the
--                       request is finalized or ruled (finalized), and visible per Sentinel in
--                       Claimed.bondReturn = bond - slash.
--   fee_reward_claimed, bond_returned  from the Sentinel's Claimed event (null until claimed)

with

events as (
    select * from {{query:safenet_events}}
    where request_id is not null
),

request_terms as (
    select request_id, block_number as proposal_block, commit_deadline, reveal_deadline, bond_target
    from events
    where event = 'request'
),

requests as (
    select r.*, t.proposal_block, t.commit_deadline, t.reveal_deadline, t.bond_target
    from {{query:safenet_requests}} as r
    join request_terms as t on t.request_id = r.request_id
),

terms as (
    select * from {{query:safenet_sentinel_terms}}
),

head as (
    select max(as_of_block) as as_of_block, max(as_of_time) as as_of_time from terms
),

commits as (
    select request_id, sentinel, min(block_time) as committed_at, min(block_number) as committed_block,
        min_by(tx_url, block_number) as commit_tx_url, sum(bond_amount) as bond_amount
    from events
    where event = 'committed'
    group by 1, 2
),

reveals as (
    select request_id, sentinel, min(block_time) as revealed_at, min(block_number) as revealed_block,
        min_by(tx_url, block_number) as reveal_tx_url, bool_or(vote_approved) as vote_approved,
        min_by(reason, block_number) as reason
    from events
    where event = 'revealed'
    group by 1, 2
),

claims as (
    select request_id, sentinel, min(block_time) as claimed_at, min_by(tx_url, block_number) as claim_tx_url,
        sum(fee_reward) as fee_reward_claimed,
        sum(bond_amount) as bond_returned
    from events
    where event = 'claimed'
    group by 1, 2
),

failed as (
    select
        f.request_id,
        f.sentinel,
        count_if(f.call_kind = 'commit') as failed_commits,
        count_if(f.call_kind = 'reveal') as failed_reveals,
        -- Timing explains most reverts; anything else is an invalid call (for example a reveal
        -- that does not match its commitment, or a repeated call).
        count_if(f.call_kind = 'commit' and f.block_number > r.commit_deadline) as late_commits,
        count_if(f.call_kind = 'reveal' and f.block_number > r.reveal_deadline) as late_reveals,
        count_if(f.call_kind = 'reveal' and f.block_number <= r.commit_deadline) as early_reveals,
        min(f.block_time) as first_failed_at,
        max_by(f.revert_reason, f.block_number) as revert_reason
    from {{query:safenet_sentinel_failed_calls}} as f
    join request_terms as r on r.request_id = f.request_id
    group by 1, 2
),

eligible as (
    select distinct r.request_id, t.sentinel
    from requests as r
    join terms as t
        on t.active_from_block <= r.commit_deadline
        and (t.removed_block is null or t.removed_block > r.proposal_block)
),

pairs as (
    select request_id, sentinel from eligible
    union
    select request_id, sentinel from commits
),

joined as (
    select
        p.request_id,
        p.sentinel,
        e.sentinel is not null as eligible,
        r.proposed_at,
        r.proposal_block,
        r.commit_deadline,
        r.reveal_deadline,
        r.covered_chain,
        r.traffic_class,
        r.safe_chain_id,
        r.safe_tx_url,
        r.status,
        r.dispute_ruling,
        r.verdict,
        r.outcome_event,
        r.completed,
        r.outcome_at,
        r.fee,
        r.dao_share_amount,
        r.winners,
        r.approve_votes,
        r.deny_votes,
        r.slash_amount,
        r.bond_target,
        c.committed_at,
        c.committed_block,
        c.commit_tx_url,
        coalesce(c.bond_amount, 0) as bond_amount,
        v.revealed_at,
        v.revealed_block,
        v.reveal_tx_url,
        v.vote_approved,
        v.reason,
        cl.claimed_at,
        cl.claim_tx_url,
        cl.fee_reward_claimed,
        cl.bond_returned,
        coalesce(f.failed_commits, 0) as failed_commits,
        coalesce(f.failed_reveals, 0) as failed_reveals,
        coalesce(f.late_commits, 0) as late_commits,
        coalesce(f.late_reveals, 0) as late_reveals,
        coalesce(f.early_reveals, 0) as early_reveals,
        f.revert_reason,
        h.as_of_block,
        h.as_of_time
    from pairs as p
    join requests as r on r.request_id = p.request_id
    cross join head as h
    left join eligible as e on e.request_id = p.request_id and e.sentinel = p.sentinel
    left join commits as c on c.request_id = p.request_id and c.sentinel = p.sentinel
    left join reveals as v on v.request_id = p.request_id and v.sentinel = p.sentinel
    left join claims as cl on cl.request_id = p.request_id and cl.sentinel = p.sentinel
    left join failed as f on f.request_id = p.request_id and f.sentinel = p.sentinel
),

states as (
    select
        *,
        case
            when revealed_at is not null then if(vote_approved, 'secure', 'insecure')
            when committed_at is not null then
                if(verdict is not null or status = 'disputed' or as_of_block > reveal_deadline, 'missing_response', 'pending_reveal')
            when (as_of_block > commit_deadline or verdict is not null or status = 'disputed') and failed_commits > 0 then 'reverted_commit'
            when as_of_block > commit_deadline or verdict is not null or status = 'disputed' then 'no_commit'
            else 'pending_commit'
        end as response_state,
        verdict is not null or status = 'disputed' as finalized
    from joined
)

select
    *,
    response_state not in ('pending_reveal', 'pending_commit') as window_closed,
    response_state in ('secure', 'insecure') as valid_response,
    -- Time of the Sentinel's last successful onchain action on this request.
    coalesce(claimed_at, revealed_at, committed_at) as last_activity_at,
    if(completed and revealed_at is not null and vote_approved = (verdict = 'approved') and winners > 0,
        (fee - dao_share_amount) / winners, 0) as fee_reward_accrued,
    -- Slashes are taken when the request is finalized (missing responses) or ruled (dispute losers).
    case
        when committed_at is null or not finalized then 0
        when revealed_at is null then if(approve_votes + deny_votes > 0, slash_amount, 0)
        when outcome_event = 'DisputeResolved' and approve_votes > 0 and deny_votes > 0
            and vote_approved <> (verdict = 'approved') then slash_amount
        else 0
    end as slash_due,
    case
        when committed_at is null or not finalized then cast(null as varchar)
        when revealed_at is null then if(approve_votes + deny_votes > 0, 'missing_response', cast(null as varchar))
        when outcome_event = 'DisputeResolved' and approve_votes > 0 and deny_votes > 0
            and vote_approved <> (verdict = 'approved') then 'dispute_lost'
    end as slash_reason
from states
