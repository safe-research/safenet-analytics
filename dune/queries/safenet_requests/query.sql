-- Safenet production: one row per transaction-check request, with its current lifecycle status,
-- Sentinel votes, attestation and fee accounting. The shared model behind the Network & revenue
-- section; definitions in docs/metrics/network-and-revenue.md. Amounts are USDC.e base units.
--
-- status (one value per request, as of the latest event read):
--   secure_unanimous    OracleResult approved: every revealed Sentinel vote approved
--   insecure_unanimous  OracleResult denied: every revealed Sentinel vote denied
--   disputed            revealed votes disagreed (DisputeTriggered); stays disputed after the
--                       arbitrator's ruling, which is in dispute_ruling
--   no_verdict          terminal without a verdict: no Sentinel revealed (RequestTimedOut)
--   pending             voting still open, or not yet finalized
-- dispute_ruling: secure / insecure (DisputeResolved), none (DisputeOutOfScope,
-- ArbitrationTimedOut), awaiting (no ruling yet); null when not disputed.
-- completed: the request has a verdict (OracleResult, or DisputeResolved). Timeouts, missing
-- responses and pending requests are never completed and never secure.

with

events as (
    select * from {{query:safenet_events}}
    where request_id is not null or event = 'attestation'
),

requests as (
    select * from events where event = 'request' and request_id is not null
),

votes as (
    select
        request_id,
        count_if(event = 'committed') as commits,
        count_if(event = 'revealed') as reveals,
        count_if(event = 'revealed' and vote_approved) as approve_votes,
        count_if(event = 'revealed' and not vote_approved) as deny_votes,
        coalesce(sum(if(event = 'committed', bond_amount)), 0) as bond_locked,
        coalesce(sum(if(event = 'claimed', bond_amount)), 0) as bond_returned,
        coalesce(sum(if(event = 'claimed', fee_reward)), 0) as fee_reward_claimed,
        count_if(event = 'claimed') as claims
    from events
    where event in ('committed', 'revealed', 'claimed')
    group by 1
),

-- Each request has at most one terminal outcome (checked by scripts/verify-network-revenue.ts).
outcomes as (
    select request_id, event as verdict, source_event, block_time, tx_hash, tx_url, slashed
    from events
    where event in ('approved', 'denied', 'no_verdict')
),

disputes as (
    select request_id, min(block_time) as disputed_at
    from events
    where event = 'dispute'
    group by 1
),

attestations as (
    select safe_tx_hash, epoch, min(block_time) as attested_at,
        min_by(tx_hash, block_number) as attestation_tx_hash, min_by(tx_url, block_number) as attestation_tx_url
    from events
    where event = 'attestation'
    group by 1, 2
),

known as (
    select * from {{query:safenet_known_traffic}}
),

classified as (
    select
        r.request_id,
        r.safe_chain_id,
        r.safe_address,
        r.safe_tx_hash,
        r.epoch,
        r.sponsor,
        r.block_time as proposed_at,
        r.block_number,
        r.log_index,
        r.tx_hash as proposal_tx_hash,
        r.covered_chain,
        r.safe_url,
        r.safe_tx_url,
        r.tx_url as proposal_tx_url,
        r.fee,
        r.dao_fee_share,
        r.slash_amount,
        case
            when not r.covered_chain then 'test_uncovered_chain'
            when k.category = 'test' then 'test_known_safe'
            when k.category = 'operational' then 'operational'
            else 'charter'
        end as traffic_class,
        k.label as known_safe_label,
        coalesce(v.commits, 0) as commits,
        coalesce(v.reveals, 0) as reveals,
        coalesce(v.approve_votes, 0) as approve_votes,
        coalesce(v.deny_votes, 0) as deny_votes,
        coalesce(v.bond_locked, 0) as bond_locked,
        coalesce(v.bond_returned, 0) as bond_returned,
        coalesce(v.fee_reward_claimed, 0) as fee_reward_claimed,
        coalesce(v.claims, 0) as claims,
        d.disputed_at,
        o.verdict,
        o.source_event as outcome_event,
        o.block_time as outcome_at,
        o.tx_hash as outcome_tx_hash,
        o.tx_url as outcome_tx_url,
        coalesce(o.slashed, 0) as dispute_slashed,
        case
            when d.request_id is not null then 'disputed'
            when o.verdict = 'approved' then 'secure_unanimous'
            when o.verdict = 'denied' then 'insecure_unanimous'
            when o.verdict = 'no_verdict' then 'no_verdict'
            else 'pending'
        end as status,
        case
            when d.request_id is null then null
            when o.verdict = 'approved' then 'secure'
            when o.verdict = 'denied' then 'insecure'
            when o.verdict = 'no_verdict' then 'none'
            else 'awaiting'
        end as dispute_ruling,
        o.verdict in ('approved', 'denied') as completed,
        if(o.verdict in ('approved', 'denied'), o.block_time) as completed_at,
        a.attested_at,
        a.attestation_tx_hash,
        a.attestation_tx_url
    from requests as r
    left join votes as v on v.request_id = r.request_id
    left join outcomes as o on o.request_id = r.request_id
    left join disputes as d on d.request_id = r.request_id
    left join known as k on k.safe_chain_id = r.safe_chain_id and k.safe_address = r.safe_address
    -- Only undisputed approvals are attested (docs/transaction-lifecycle.md).
    left join attestations as a
        on o.verdict = 'approved' and d.request_id is null
        and a.safe_tx_hash = r.safe_tx_hash and a.epoch = r.epoch
),

-- Fee accounting per request (SentinelOracleRequests.sol). On a verdict, the revealers on the
-- winning side share fee - dao_cut, where dao_cut = the DAO share plus the remainder of the split;
-- dao_cut goes to the protocol funds receiver. Without a verdict the full fee is refunded to the
-- sponsor. After an arbitrated dispute the sponsor is refunded from the losers' slashed bonds and
-- the winners still share the fee. A Sentinel that committed but did not reveal is slashed once
-- any vote was revealed.
accounting as (
    select
        *,
        case
            when not completed then 0
            when verdict = 'approved' then approve_votes
            else deny_votes
        end as winners,
        fee * dao_fee_share / 100000 as dao_share_amount, -- integer division, as in the contract
        if(reveals > 0, (commits - reveals) * slash_amount, 0) as non_revealer_slashed
    from classified
)

select
    *,
    if(winners > 0, (fee - dao_share_amount) / winners * winners, 0) as fee_reward_accrued,
    if(winners > 0, dao_share_amount + (fee - dao_share_amount) % winners, 0) as dao_cut,
    case
        when status = 'no_verdict' or (status = 'disputed' and dispute_ruling = 'none') then fee
        when outcome_event = 'DisputeResolved' then fee
        else 0
    end as sponsor_refund,
    case
        when status = 'no_verdict' or (status = 'disputed' and dispute_ruling = 'none') then 'fee'
        when outcome_event = 'DisputeResolved' then 'slashed_bonds'
    end as sponsor_refund_source,
    -- Paid to the protocol funds receiver: dao_cut, non-revealer slashes, and what remains of an
    -- arbitrated dispute's slashes after the sponsor refund.
    if(winners > 0, dao_share_amount + (fee - dao_share_amount) % winners, 0)
        + non_revealer_slashed
        + if(outcome_event = 'DisputeResolved', dispute_slashed - fee, 0) as receiver_amount,
    non_revealer_slashed + dispute_slashed as bond_slashed,
    if(verdict is null, fee, 0) as fee_held
from accounting
