-- Current transaction guard of every Safe that ever set a verified production SafenetGuard, per
-- chain. Safes emit ChangedGuard(address) on setGuard: Safe 1.3.0 logs the guard in data, 1.4.1
-- and later as topic1 (same topic0). The latest event per Safe wins, so removing the guard
-- (address 0) or replacing it with another guard ends Guard-enabled status. Module guards
-- (ChangedModuleGuard) are ignored: SafenetGuard is a transaction guard only.
-- Guard-enabled means the Safe's current guard is a verified production guard
-- (safenet_guards.verified_production). Using Safenet checks without the guard is not counted.

with

guards as (
    select * from {{query:safenet_guards}}
    where verified_production
),

-- Only from the first production guard's deployment; before it no Safe can have set one. The
-- static bound below keeps the scan bounded even without a verified guard.
since as (
    select coalesce(cast(min(deployed_at) as date), date '9999-12-31') as first_day from guards
),

changes as (
    select 1 as chain_id, contract_address as safe, block_number, "index" as log_index, block_time, tx_hash,
        coalesce(bytearray_substring(topic1, 13, 20), bytearray_substring(data, 13, 20)) as guard
    from ethereum.logs, since
    where topic0 = 0x1151116914515bc0891ff9047a6cb32cf902546f83066499bcf8ba33d2353fa2 -- ChangedGuard
        and block_date >= since.first_day
        and block_date >= date '2026-09-01' -- static bound for partition pruning
    union all
    select 100, contract_address, block_number, "index", block_time, tx_hash,
        coalesce(bytearray_substring(topic1, 13, 20), bytearray_substring(data, 13, 20))
    from gnosis.logs, since
    where topic0 = 0x1151116914515bc0891ff9047a6cb32cf902546f83066499bcf8ba33d2353fa2
        and block_date >= since.first_day
        and block_date >= date '2026-09-01' -- static bound for partition pruning
    union all
    select 42161, contract_address, block_number, "index", block_time, tx_hash,
        coalesce(bytearray_substring(topic1, 13, 20), bytearray_substring(data, 13, 20))
    from arbitrum.logs, since
    where topic0 = 0x1151116914515bc0891ff9047a6cb32cf902546f83066499bcf8ba33d2353fa2
        and block_date >= since.first_day
        and block_date >= date '2026-09-01' -- static bound for partition pruning
),

-- Safes that ever set a production guard, and their latest guard change on that chain.
relevant as (
    select distinct c.chain_id, c.safe
    from changes as c
    join guards as g on g.chain_id = c.chain_id and g.guard = c.guard
),

latest as (
    select c.chain_id, c.safe,
        max_by(c.guard, c.block_number * 100000 + c.log_index) as current_guard,
        max(c.block_time) as last_changed_at,
        max_by(c.tx_hash, c.block_number * 100000 + c.log_index) as last_change_tx_hash
    from changes as c
    join relevant as r on r.chain_id = c.chain_id and r.safe = c.safe
    group by 1, 2
)

select
    l.*,
    g.guard is not null as guard_enabled
from latest as l
left join guards as g on g.chain_id = l.chain_id and g.guard = l.current_guard
