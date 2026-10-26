-- Safenet production Sentinel Oracle fee terms over time, from what each request actually recorded
-- (NewRequest: fee, bondTarget, daoFeeShare, slashAmount) and from governance schedule events
-- (FeeScheduled, DaoFeeShareScheduled, ProtocolFundsReceiverScheduled, BondConfigScheduled), which
-- take effect after a delay. One row per distinct set of terms, then one row per schedule event.
-- docs/metrics/network-and-revenue.md#fee-configuration.

with

events as (
    select * from {{query:safenet_events}}
),

terms as (
    select
        'Terms charged' as kind,
        fee / 1e6 as fee_usdc,
        bond_target / 1e6 as bond_per_vote_usdc,
        dao_fee_share / 1000.0 as dao_fee_share_percent,
        slash_amount / 1e6 as slash_usdc,
        count(*) as requests,
        min(block_time) as first_seen,
        max(block_time) as last_seen,
        cast(null as varchar) as change
    from events
    where event = 'request' and request_id is not null
    group by 1, 2, 3, 4, 5
),

scheduled as (
    select
        'Change scheduled' as kind,
        cast(null as double), cast(null as double), cast(null as double), cast(null as double),
        cast(null as bigint),
        block_time, block_time,
        source_event || ' 0x' || lower(to_hex(config_data))
            || ' (<a href="' || tx_url || '" target="_blank">tx</a>)' as change
    from events
    where event = 'config_scheduled'
)

select * from terms
union all
select * from scheduled
union all
-- Explicit when verified: every schedule event of the oracle was read and there is none.
select 'No change scheduled since deployment', null, null, null, null, null, null, null,
    'Verified: no FeeScheduled, DaoFeeShareScheduled, ProtocolFundsReceiverScheduled or BondConfigScheduled event'
where not exists (select 1 from scheduled)
order by first_seen nulls last
