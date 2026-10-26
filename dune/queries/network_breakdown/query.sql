-- Safenet production activity by the network of the checked Safe (the chain in the proposal's
-- safeId), all time. The Sentinel Oracle and Consensus run on Gnosis Chain for every network;
-- that is not the network shown here. Networks outside the Charter are listed as test traffic and
-- are not part of the headline totals. Definitions: docs/metrics/network-and-revenue.md.

with

requests as (
    select * from {{query:safenet_requests}}
),

attestations as (
    select safe_chain_id, count(*) as attestations
    from {{query:safenet_events}}
    where event = 'attestation'
    group by 1
),

by_chain as (
    select
        safe_chain_id,
        bool_and(covered_chain) as covered_chain,
        count(*) as requests,
        count_if(completed) as completed_results,
        count(distinct safe_address) as safes_with_requests,
        count(distinct if(completed, safe_address)) as safes_with_completed_checks,
        count(distinct safe_tx_hash) as unique_safe_transactions
    from requests
    group by 1
)

select
    case b.safe_chain_id
        when 1 then 'Ethereum'
        when 100 then 'Gnosis Chain'
        when 42161 then 'Arbitrum One'
        when 137 then 'Polygon'
        else 'Chain ' || cast(b.safe_chain_id as varchar)
    end || if(b.covered_chain, '', ' (outside Charter, test)') as network,
    b.safe_chain_id,
    b.covered_chain,
    b.requests,
    b.completed_results,
    coalesce(a.attestations, 0) as attestations,
    b.safes_with_requests,
    b.safes_with_completed_checks,
    b.unique_safe_transactions,
    (select max(block_number) from {{query:safenet_events}}) as through_block -- for the verification
from by_chain as b
left join attestations as a on a.safe_chain_id = b.safe_chain_id
order by b.covered_chain desc, b.requests desc
