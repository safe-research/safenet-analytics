-- Safes whose current transaction guard is a verified production SafenetGuard, by network, now.
-- A current status count, not a flow. Guard-enabled is not the same as using Safenet checks:
-- Safes can request checks without the guard, and are then not counted here.
-- If no SafenetGuard bound to the production Consensus has been deployed on a network,
-- guard_enabled_safes is null (not available), not 0. First row: all networks (the counter).
-- Definitions: docs/metrics/network-and-revenue.md#guard-enabled-safes.

with

guards as (
    select chain_id, count_if(verified_production) as verified_guards
    from {{query:safenet_guards}}
    group by 1
),

status as (
    select chain_id, count_if(guard_enabled) as enabled
    from {{query:safenet_guard_status}}
    group by 1
),

networks as (
    select * from (values (1, 'Ethereum', 2), (100, 'Gnosis Chain', 3), (42161, 'Arbitrum One', 4)) as t (chain_id, network, sort_order)
),

per_network as (
    select
        n.network,
        n.sort_order,
        coalesce(g.verified_guards, 0) as verified_production_guards,
        if(coalesce(g.verified_guards, 0) > 0, coalesce(s.enabled, 0)) as guard_enabled_safes
    from networks as n
    left join guards as g on g.chain_id = n.chain_id
    left join status as s on s.chain_id = n.chain_id
)

select
    'All Charter networks' as network,
    sum(verified_production_guards) as verified_production_guards,
    -- null only if no network has a verified production guard
    sum(guard_enabled_safes) as guard_enabled_safes,
    if(sum(verified_production_guards) = 0, 'not available: no SafenetGuard bound to the production Consensus found on chain') as note,
    1 as sort_order
from per_network
union all
select
    network,
    verified_production_guards,
    guard_enabled_safes,
    if(verified_production_guards = 0, 'not available: no production SafenetGuard on this network'),
    sort_order
from per_network
order by sort_order
