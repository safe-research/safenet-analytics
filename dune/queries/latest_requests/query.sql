-- Safenet production: the 25 most recent transaction-check requests with their current status.
-- Definitions: docs/metrics/network-and-revenue.md. Links: src/links.ts (built in safenet_events).
-- Onchain addresses and transactions link to their chain's block explorer; the Safe transaction
-- links to the Safenet explorer. Requests for Safes outside the Charter's chains are included and
-- marked, because this table lists individual requests rather than counting them.

with

requests as (
    select * from {{query:safenet_requests}}
),

link as (
    select
        *,
        -- '<a href="url" target="_blank">text</a>', or the text alone without a url
        '0x' || lower(to_hex(safe_address)) as safe_text
    from requests
)

select
    proposed_at,
    case safe_chain_id
        when 1 then 'Ethereum'
        when 100 then 'Gnosis Chain'
        when 42161 then 'Arbitrum One'
        when 137 then 'Polygon'
        else 'Chain ' || cast(safe_chain_id as varchar)
    end || if(covered_chain, '', ' (not covered, likely test)')
        || if(traffic_class = 'operational', ' (Safenet operational)', '') as safe_chain,
    if(safe_url is null, safe_text, '<a href="' || safe_url || '" target="_blank">' || safe_text || '</a>') as safe,
    '<a href="' || safe_tx_url || '" target="_blank">0x' || substr(lower(to_hex(safe_tx_hash)), 1, 10) || '…</a>' as safe_tx,
    '<a href="' || proposal_tx_url || '" target="_blank">0x' || substr(lower(to_hex(proposal_tx_hash)), 1, 10) || '…</a>' as proposal_tx,
    case status
        when 'secure_unanimous' then 'Secure (unanimous)'
        when 'insecure_unanimous' then 'Insecure (unanimous)'
        when 'disputed' then 'Disputed: ' || case dispute_ruling
            when 'secure' then 'ruled secure'
            when 'insecure' then 'ruled insecure'
            when 'none' then 'no ruling (final)'
            else 'awaiting ruling'
        end
        when 'no_verdict' then 'Timed out, no verdict (final)'
        else 'Pending (not yet decided)'
    end || ' · ' || cast(reveals as varchar) || '/' || cast(commits as varchar) || ' votes revealed' as outcome,
    if(outcome_tx_hash is null, '', '<a href="' || outcome_tx_url || '" target="_blank">0x' || substr(lower(to_hex(outcome_tx_hash)), 1, 10) || '…</a>') as outcome_tx,
    if(attestation_tx_hash is null, '', '<a href="' || attestation_tx_url || '" target="_blank">0x' || substr(lower(to_hex(attestation_tx_hash)), 1, 10) || '…</a>') as attestation_tx,
    fee / 1e6 as fee_usdc
from link
order by block_number desc, log_index desc
limit 25
