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
-- window_closed rows only. request_window_closed: the request's own response window has closed
-- (a verdict, a dispute, a timeout, or the reveal deadline passed); coverage uses it.
--
-- Fees and bonds per row follow SentinelOracleRequests.sol (calcFeeReward, slashAmountFor):
--   fee_reward_accrued  the winner's share floor((fee - DAO share) / winners) on a verdict
--   slash_due           slashAmount for a missing response once either side was revealed, and for a
--                       revealed loser of an arbitrated dispute; else 0. Taken from the bond when the
--                       request is finalized or ruled (finalized), and visible per Sentinel in
--                       Claimed.bondReturn = bond - slash.
--   fee_reward_claimed, bond_returned  from the Sentinel's Claimed event (null until claimed)
--
-- Request fields follow the same events and rules as safenet_requests (Network & revenue). Dune
-- inlines every query reference and CTE where it is used, so safenet_events is read exactly once
-- here: one aggregation per request keeps each Sentinel's commit, reveal and claim in arrays
-- ordered by log position, and one row per Sentinel is picked from them.

with

per_request as (
    select
        request_id,
        max(block_number) as max_block,
        max(if(event = 'request', block_number)) as proposal_block,
        max(if(event = 'request', block_time)) as proposed_at,
        max(if(event = 'request', commit_deadline)) as commit_deadline,
        max(if(event = 'request', reveal_deadline)) as reveal_deadline,
        max(if(event = 'request', fee)) as fee,
        max(if(event = 'request', dao_fee_share)) as dao_fee_share,
        max(if(event = 'request', slash_amount)) as slash_amount,
        bool_or(event = 'request' and covered_chain) as covered_chain,
        max(if(event = 'request', safe_chain_id)) as safe_chain_id,
        max(if(event = 'request', safe_tx_hash)) as safe_tx_hash,
        max(if(event = 'request', epoch)) as epoch,
        max(if(event = 'request', safe_tx_url)) as safe_tx_url,
        -- Each request has at most one terminal outcome (checked by the verification scripts).
        max(if(event in ('approved', 'denied', 'no_verdict'), event)) as verdict,
        max(if(event in ('approved', 'denied', 'no_verdict'), source_event)) as outcome_event,
        max(if(event in ('approved', 'denied', 'no_verdict'), block_time)) as outcome_at,
        max(if(event in ('approved', 'denied', 'no_verdict'), tx_url)) as outcome_tx_url,
        coalesce(max(if(event in ('approved', 'denied', 'no_verdict'), slashed)), 0) as dispute_slashed,
        min(if(event = 'dispute', block_time)) as disputed_at,
        max(if(event = 'dispute', tx_url)) as dispute_tx_url,
        count_if(event = 'revealed' and vote_approved) as approve_votes,
        count_if(event = 'revealed' and not vote_approved) as deny_votes,
        array_agg(sentinel order by block_number, log_index) filter (where event = 'committed') as c_sentinel,
        array_agg(block_time order by block_number, log_index) filter (where event = 'committed') as c_time,
        array_agg(tx_url order by block_number, log_index) filter (where event = 'committed') as c_url,
        array_agg(bond_amount order by block_number, log_index) filter (where event = 'committed') as c_bond,
        array_agg(sentinel order by block_number, log_index) filter (where event = 'revealed') as r_sentinel,
        array_agg(block_time order by block_number, log_index) filter (where event = 'revealed') as r_time,
        array_agg(tx_url order by block_number, log_index) filter (where event = 'revealed') as r_url,
        array_agg(vote_approved order by block_number, log_index) filter (where event = 'revealed') as r_approved,
        array_agg(sentinel order by block_number, log_index) filter (where event = 'claimed') as k_sentinel,
        array_agg(block_time order by block_number, log_index) filter (where event = 'claimed') as k_time,
        array_agg(tx_url order by block_number, log_index) filter (where event = 'claimed') as k_url,
        array_agg(bond_amount order by block_number, log_index) filter (where event = 'claimed') as k_bond,
        array_agg(fee_reward order by block_number, log_index) filter (where event = 'claimed') as k_fee
    from {{query:safenet_events}}
    group by 1
),

-- through_block: the highest Gnosis block among all events read (the verification recounts up to
-- exactly this block); the null request_id group holds the events of no request.
bounded as (
    select *, max(max_block) over () as through_block
    from per_request
),

requests as (
    select * from bounded
    where request_id is not null and proposal_block is not null
),

sentinels as (
    select
        sentinel,
        max_by(name, scheduled_block) as name,
        max_by(sentinel_url, scheduled_block) as sentinel_url,
        max_by(term_status, scheduled_block) as current_status,
        array_agg(active_from_block) as term_from,
        array_agg(coalesce(removed_block, 9223372036854775807)) as term_removed,
        max(as_of_block) as as_of_block,
        max(as_of_time) as as_of_time
    from {{query:safenet_sentinel_terms}}
    group by 1
),

failed as (
    select
        request_id,
        sentinel,
        array_agg(block_number) filter (where call_kind = 'commit') as failed_commit_blocks,
        array_agg(block_number) filter (where call_kind = 'reveal') as failed_reveal_blocks,
        max_by(revert_reason, block_number) as revert_reason,
        max(block_time) as last_reverted_at
    from {{query:safenet_sentinel_failed_calls}}
    group by 1, 2
),

pairs as (
    select
        r.*,
        s.sentinel,
        s.name,
        s.sentinel_url,
        s.current_status,
        s.as_of_block,
        s.as_of_time,
        contains(zip_with(s.term_from, s.term_removed, (f, x) -> f <= r.commit_deadline and x > r.proposal_block), true) as eligible,
        coalesce(array_position(r.c_sentinel, s.sentinel), 0) as ci,
        coalesce(array_position(r.r_sentinel, s.sentinel), 0) as ri,
        coalesce(array_position(r.k_sentinel, s.sentinel), 0) as ki,
        f.failed_commit_blocks,
        f.failed_reveal_blocks,
        f.revert_reason,
        f.last_reverted_at
    from requests as r
    cross join sentinels as s
    left join failed as f on f.request_id = r.request_id and f.sentinel = s.sentinel
),

joined as (
    select
        request_id,
        sentinel,
        name,
        sentinel_url,
        current_status,
        eligible,
        proposed_at,
        proposal_block,
        commit_deadline,
        reveal_deadline,
        covered_chain,
        safe_chain_id,
        safe_tx_hash,
        epoch,
        safe_tx_url,
        verdict,
        outcome_event,
        outcome_at,
        outcome_tx_url,
        dispute_slashed,
        disputed_at,
        dispute_tx_url,
        disputed_at is not null as disputed,
        verdict in ('approved', 'denied') as completed,
        verdict is not null or disputed_at is not null as finalized,
        fee,
        fee * dao_fee_share / 100000 as dao_share_amount, -- integer division, as in the contract
        slash_amount,
        approve_votes,
        deny_votes,
        approve_votes + deny_votes as request_reveals,
        if(ci > 0, element_at(c_time, ci)) as committed_at,
        if(ci > 0, element_at(c_url, ci)) as commit_tx_url,
        if(ci > 0, element_at(c_bond, ci), 0) as bond_amount,
        if(ri > 0, element_at(r_time, ri)) as revealed_at,
        if(ri > 0, element_at(r_url, ri)) as reveal_tx_url,
        if(ri > 0, element_at(r_approved, ri)) as vote_approved,
        if(ki > 0, element_at(k_time, ki)) as claimed_at,
        if(ki > 0, element_at(k_url, ki)) as claim_tx_url,
        if(ki > 0, element_at(k_fee, ki)) as fee_reward_claimed,
        if(ki > 0, element_at(k_bond, ki)) as bond_returned,
        coalesce(cardinality(failed_commit_blocks), 0) as failed_commits,
        coalesce(cardinality(failed_reveal_blocks), 0) as failed_reveals,
        -- Timing explains some reverts; any other revert is an invalid call (for example a commit
        -- without enough USDC.e for the bond, or a reveal that does not match its commitment).
        coalesce(cardinality(filter(failed_commit_blocks, b -> b > commit_deadline)), 0) as late_commits,
        coalesce(cardinality(filter(failed_reveal_blocks, b -> b > reveal_deadline)), 0) as late_reveals,
        coalesce(cardinality(filter(failed_reveal_blocks, b -> b <= commit_deadline)), 0) as early_reveals,
        revert_reason,
        last_reverted_at,
        as_of_block,
        as_of_time,
        through_block
    from pairs
    where eligible or ci > 0
),

states as (
    select
        *,
        case
            when revealed_at is not null then if(vote_approved, 'secure', 'insecure')
            when committed_at is not null then if(finalized or as_of_block > reveal_deadline, 'missing_response', 'pending_reveal')
            when (finalized or as_of_block > commit_deadline) and failed_commits > 0 then 'reverted_commit'
            when finalized or as_of_block > commit_deadline then 'no_commit'
            else 'pending_commit'
        end as response_state,
        case
            when not completed then 0
            when verdict = 'approved' then approve_votes
            else deny_votes
        end as winners
    from joined
)

select
    *,
    response_state not in ('pending_reveal', 'pending_commit') as window_closed,
    response_state in ('secure', 'insecure') as valid_response,
    finalized or as_of_block > reveal_deadline as request_window_closed,
    -- Time of the Sentinel's last successful onchain action on this request, and its transaction.
    coalesce(claimed_at, revealed_at, committed_at) as last_activity_at,
    coalesce(claim_tx_url, reveal_tx_url, commit_tx_url) as last_activity_tx_url,
    if(completed and revealed_at is not null and vote_approved = (verdict = 'approved') and winners > 0,
        (fee - dao_share_amount) / winners, 0) as fee_reward_accrued,
    -- Slashes are taken when the request is finalized (missing responses) or ruled (dispute losers).
    case
        when committed_at is null or not finalized then 0
        when revealed_at is null then if(request_reveals > 0, slash_amount, 0)
        when outcome_event = 'DisputeResolved' and approve_votes > 0 and deny_votes > 0
            and vote_approved <> (verdict = 'approved') then slash_amount
        else 0
    end as slash_due,
    case
        when committed_at is null or not finalized then cast(null as varchar)
        when revealed_at is null then if(request_reveals > 0, 'missing_response', cast(null as varchar))
        when outcome_event = 'DisputeResolved' and approve_votes > 0 and deny_votes > 0
            and vote_approved <> (verdict = 'approved') then 'dispute_lost'
    end as slash_reason
from states
