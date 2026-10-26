-- Safenet production: Sentinel membership terms from the Sentinel Oracle's own events, one row per
-- term. Definitions: docs/metrics/sentinels.md#membership.
--
-- SentinelMap.sol: SentinelScheduled(sentinel, activeAtBlock) starts a term; the Sentinel may
-- commit from active_from_block on (the scheduling block plus the 51840-block governance delay).
-- SentinelRemoved ends it at once. A Sentinel removed before active_from_block never became active.
-- Labels come from safe-fndn/safenet-data and are display names only; membership comes from here.

with

admin as (
    select * from {{query:safenet_events}}
    where event in ('sentinel_scheduled', 'sentinel_removed')
),

scheduled as (
    select
        sentinel,
        block_number as scheduled_block,
        block_time as scheduled_at,
        tx_url as scheduled_tx_url,
        active_at_block as active_from_block,
        lead(block_number) over (partition by sentinel order by block_number, log_index) as next_scheduled_block
    from admin
    where event = 'sentinel_scheduled'
),

-- A term ends at the first removal at or after its scheduling (and before any re-scheduling).
terms as (
    select
        s.sentinel,
        s.scheduled_block,
        s.scheduled_at,
        s.scheduled_tx_url,
        s.active_from_block,
        min(r.block_number) as removed_block,
        min(r.block_time) as removed_at
    from scheduled as s
    left join admin as r
        on r.event = 'sentinel_removed'
        and r.sentinel = s.sentinel
        and r.block_number >= s.scheduled_block
        and (s.next_scheduled_block is null or r.block_number < s.next_scheduled_block)
    group by 1, 2, 3, 4, 5
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
