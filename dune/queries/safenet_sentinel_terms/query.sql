-- Safenet production: Sentinel membership terms from the Sentinel Oracle's own events, one row per
-- term. Definitions: docs/metrics/sentinels.md#membership-and-eligibility.
--
-- SentinelMap.sol: SentinelScheduled(sentinel, activeAtBlock) starts a term; the Sentinel may
-- commit from active_from_block on (the scheduling block plus the 51840-block governance delay).
-- SentinelRemoved ends it at once; a term ends at the first removal after its scheduling and before
-- the next scheduling of the same Sentinel. A Sentinel removed before active_from_block never
-- became active. Labels come from safe-fndn/safenet-data and are display names only.
--
-- Dune inlines every query reference and CTE where it is used, so safenet_events is read once here
-- (window functions instead of self-joins) to keep the Sentinel queries small enough to run.

with

admin as (
    select
        event,
        sentinel,
        block_number,
        block_time,
        log_index,
        tx_url,
        active_at_block,
        -- The next scheduling of the same Sentinel, and the first removal from this row on.
        min(if(event = 'sentinel_scheduled', block_number)) over (
            partition by sentinel order by block_number, log_index rows between 1 following and unbounded following
        ) as next_scheduled_block,
        min(if(event = 'sentinel_removed', block_number)) over (
            partition by sentinel order by block_number, log_index rows between current row and unbounded following
        ) as next_removed_block,
        min(if(event = 'sentinel_removed', block_time)) over (
            partition by sentinel order by block_number, log_index rows between current row and unbounded following
        ) as next_removed_at
    from {{query:safenet_events}}
    where event in ('sentinel_scheduled', 'sentinel_removed')
),

terms as (
    select
        sentinel,
        block_number as scheduled_block,
        block_time as scheduled_at,
        tx_url as scheduled_tx_url,
        active_at_block as active_from_block,
        if(next_scheduled_block is null or next_removed_block < next_scheduled_block, next_removed_block) as removed_block,
        if(next_scheduled_block is null or next_removed_block < next_scheduled_block, next_removed_at) as removed_at
    from admin
    where event = 'sentinel_scheduled'
),

head as (
    select max(number) as as_of_block, max(time) as as_of_time
    from gnosis.blocks
    where time > now() - interval '2' day
),

labels as (
    select address, label from {{query:safenet_participant_labels}} where role = 'sentinel'
)

select
    t.sentinel,
    coalesce(l.label, '0x' || lower(to_hex(t.sentinel))) as name,
    l.label is not null as labelled,
    'https://gnosisscan.io/address/0x' || lower(to_hex(t.sentinel)) as sentinel_url,
    t.scheduled_block,
    t.scheduled_at,
    t.scheduled_tx_url,
    t.active_from_block,
    t.removed_block,
    t.removed_at,
    t.removed_block is not null and t.removed_block <= t.active_from_block as never_active,
    case
        when t.removed_block is not null then 'removed'
        when h.as_of_block >= t.active_from_block then 'active'
        else 'scheduled'
    end as term_status,
    h.as_of_block,
    h.as_of_time
from terms as t
cross join head as h
left join labels as l on l.address = t.sentinel
