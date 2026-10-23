-- Safenet production: the 25 most recent transaction-check requests with their outcome.
-- Definitions: docs/metrics/transaction-checks.md. Links: src/links.ts (built in safenet_events).
-- Onchain addresses and transactions link to their chain's block explorer; the Safe transaction
-- links to the Safenet explorer. Requests for Safes outside the Charter's chains are included and
-- marked, because this table lists individual requests rather than counting them.

with

events as (
    select * from {{query:safenet_events}}
),

requests as (
    select * from events where event = 'request' and request_id is not null
),

outcomes as (
    select request_id, event as outcome, tx_hash, tx_url
    from events
    where event in ('approved', 'denied', 'no_verdict')
),

disputed as (
    select distinct request_id from events where event = 'dispute'
),

-- An approved, undisputed request is attested under the same safeTxHash and epoch.
attestations as (
    select safe_tx_hash, epoch, min_by(tx_hash, block_number) as tx_hash, min_by(tx_url, block_number) as tx_url
    from events
    where event = 'attestation'
    group by 1, 2
)

select
    r.block_time as proposed_at,
    case r.safe_chain_id
        when 1 then 'Ethereum'
        when 100 then 'Gnosis Chain'
        when 42161 then 'Arbitrum One'
        when 137 then 'Polygon'
        else 'Chain ' || cast(r.safe_chain_id as varchar)
    end || if(r.covered_chain, '', ' (not covered, likely test)') as safe_chain,
    if(r.safe_url is null, '0x' || lower(to_hex(r.safe_address)),
        '<a href="' || r.safe_url || '" target="_blank">0x' || lower(to_hex(r.safe_address)) || '</a>') as safe,
    '<a href="' || r.safe_tx_url || '" target="_blank">0x' || substr(lower(to_hex(r.safe_tx_hash)), 1, 10) || '…</a>' as safe_tx,
    '<a href="' || r.tx_url || '" target="_blank">0x' || substr(lower(to_hex(r.tx_hash)), 1, 10) || '…</a>' as proposal_tx,
    coalesce(o.outcome, 'open') || if(d.request_id is not null, ' (disputed)', '') as outcome,
    if(o.tx_hash is null, '', '<a href="' || o.tx_url || '" target="_blank">0x' || substr(lower(to_hex(o.tx_hash)), 1, 10) || '…</a>') as outcome_tx,
    if(a.tx_hash is null, '', '<a href="' || a.tx_url || '" target="_blank">0x' || substr(lower(to_hex(a.tx_hash)), 1, 10) || '…</a>') as attestation_tx
from requests as r
left join outcomes as o on o.request_id = r.request_id
left join disputed as d on d.request_id = r.request_id
left join attestations as a
    on o.outcome = 'approved'
    and d.request_id is null
    and a.safe_tx_hash = r.safe_tx_hash
    and a.epoch = r.epoch
order by r.block_number desc, r.log_index desc
limit 25
