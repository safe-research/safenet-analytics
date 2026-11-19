-- Safenet Aegis: realized Sentinel APR per completed reward period and Sentinel. Fee rewards net of
-- slashes (USDC.e), and the published SAFE Sentinel grant valued in USD, over the USDC.e capital the
-- Sentinel kept bonded, annualized without compounding. Historical, never a projection. Gross: before
-- the Sentinel's operating costs (staff, servers), so a return on bonded capital, not profit.
-- Definitions: docs/metrics/sentinels.md#realized-apr.
--
--   APR = return / time-weighted capital × 365 days / period length × 100
--
-- Periods: the fixed two-week Aegis reward periods [period_start, period_end) from 2026-10-13 00:00 UTC,
-- as in staking_period_stake. A period is listed once the latest decoded Safenet event is past its
-- end: the 'meta' row of safenet_sentinel_wallet_transfers, which that model always returns (whatever
-- the transfers or responses) with the block its transfers are capped at and its time. Every input has
-- reached that block, so a period whose data is still arriving is never shown as completed.
-- Return, in the period:
--   net_fees_usdc   fee rewards accrued on requests decided in the period (outcome_at), minus the
--                   slashes taken from the Sentinel's bonds in the period: a missing response at
--                   finalize (the freeze, disputed_at, or the outcome), a lost dispute at the ruling
--   safe_grant      the Sentinel grant published for the period: the change of the address's
--                   sentinelAmount (KYC-withheld included) from the previous period's last root to the
--                   period's last root. Staking rewards of the same address are not in it. Null while
--                   the period is not published.
--   safe_grant_usd  safe_grant × the SAFE/USD price of the period's last day (prices.day, Ethereum)
-- Capital, averaged over the period by the exact seconds it was held (USDC.e taken as 1 USD):
--   capital_locked_usdc  bonds the oracle holds for the Sentinel: each commit's bond from the commit
--                        to the claim, less its slash from the time the slash was taken
--   capital_wallet_usdc  USDC.e in the Sentinel's own account on Gnosis Chain, which it bonds next
--                        (safenet_sentinel_wallet_transfers, from the oracle's deployment)
--   capital_total_usdc   locked + wallet
-- Six rates: fee, SAFE and total return, each over locked and over total capital. Null without
-- capital, and the SAFE and total rates are null while the grant or the price is missing, never 0.
-- Rows: a Sentinel in a period where it held capital, earned or was slashed, or received a grant (a
-- grant without capital has a row with null rates).
--
-- Size: Dune inlines every query reference and CTE where it is used, so safenet_sentinel_responses
-- (and the wallet transfers) are read exactly once: each response becomes its dated changes (unnest),
-- one window turns them into balances, and one join with the periods aggregates everything.
-- The cutoff's 'meta' row spans all time, so it reaches every period whatever the activity, and
-- grant-only and wallet-only rows keep it even without any response.

with

-- Every dated change per Sentinel, in base units. locked: + bond at the commit, - slash when taken
-- (a missing response at finalize: the freeze or the outcome; a lost dispute at the ruling),
-- - (bond - slash) at the claim. fee: accrued when the request is decided. slash: as taken.
-- wallet: USDC.e in (+) and out (-) of the Sentinel's own account.
changes as (
    select r.sentinel, cast(null as bigint) as through_block, cast(null as bigint) as through_t, e.kind,
        cast(to_unixtime(e.at) as bigint) as t, e.amount
    from {{query:safenet_sentinel_responses}} as r
    cross join unnest(
        array['locked', 'locked', 'locked', 'fee', 'slash'],
        array[
            r.committed_at,
            if(r.slash_reason = 'dispute_lost', r.outcome_at, coalesce(r.disputed_at, r.outcome_at)),
            r.claimed_at,
            r.outcome_at,
            if(r.slash_reason = 'dispute_lost', r.outcome_at, coalesce(r.disputed_at, r.outcome_at))
        ],
        array[
            cast(r.bond_amount as double),
            -cast(r.slash_due as double),
            -cast(r.bond_amount - r.slash_due as double),
            cast(r.fee_reward_accrued as double),
            cast(r.slash_due as double)
        ]
    ) as e (kind, at, amount)
    where r.committed_at is not null and e.at is not null and e.amount <> 0
    union all
    -- wallet rows, and the one meta row with the cutoff block and time
    select sentinel,
        if(direction = 'meta', block_number),
        if(direction = 'meta', cast(to_unixtime(block_time) as bigint)),
        if(direction = 'meta', 'meta', 'wallet'),
        cast(to_unixtime(block_time) as bigint),
        case direction when 'in' then cast(amount as double) when 'out' then -cast(amount as double) else 0e0 end
    from {{query:safenet_sentinel_wallet_transfers}}
),

-- Capital: the balance after each change, held until the next change of the same kind (or for ever).
-- Fee and slash rows keep their own amount and an instant [t, t]; meta rows span all time.
segments as (
    select
        kind,
        sentinel,
        through_block,
        through_t,
        if(kind = 'meta', 0, t) as seg_from,
        case
            when kind in ('locked', 'wallet') then coalesce(lead(t) over (partition by kind, sentinel order by t, amount desc), cast(9223372036 as bigint))
            when kind = 'meta' then cast(9223372036 as bigint) -- overlaps every period
            else t
        end as seg_to,
        if(kind in ('locked', 'wallet'),
            sum(amount) over (partition by kind, sentinel order by t, amount desc rows unbounded preceding), amount) as value
    from changes
),

periods as (
    select
        p_to - 1209600 as p_from,
        p_to,
        from_unixtime(p_to - 1209600) as period_start,
        from_unixtime(p_to) as period_end
    from unnest(sequence(cast(1793059200 as bigint), cast(to_unixtime(now()) as bigint), cast(1209600 as bigint))) as a (p_to)
),

per_period as (
    select
        p.period_start,
        p.period_end,
        s.sentinel,
        max(s.through_block) as through_block, -- from the meta row only
        max(s.through_t) as through_t,
        sum(if(s.kind = 'fee', s.value, 0)) as fees,
        sum(if(s.kind = 'slash', s.value, 0)) as slashed,
        sum(if(s.kind = 'locked', s.value * (least(s.seg_to, p.p_to) - greatest(s.seg_from, p.p_from)), 0)) / 1209600 as locked_avg,
        sum(if(s.kind = 'wallet', s.value * (least(s.seg_to, p.p_to) - greatest(s.seg_from, p.p_from)), 0)) / 1209600 as wallet_avg
    from segments as s
    join periods as p
        on if(s.kind in ('locked', 'wallet', 'meta'), s.seg_from < p.p_to and s.seg_to > p.p_from, s.seg_from >= p.p_from and s.seg_from < p.p_to)
    group by 1, 2, 3
),

-- Published grants: the last root of each period, and the change of each address's sentinelAmount
-- from the last root before the period. A static query of published values.
published as (
    select * from {{query:safenet_sentinel_rewards}}
),

period_roots as (
    select
        p.period_start,
        max_by(r.merkle_root, r.root_order) filter (where r.rewards_until = p.period_end) as root,
        max_by(r.merkle_root, r.root_order) filter (where r.rewards_until < p.period_end) as prev_root
    from periods as p
    cross join (select * from published where kind = 'root') as r
    group by 1
),

-- Published grant per (period, address): the change of sentinelAmount from the last root before the
-- period to the period's last root. Only periods whose last root is published.
grants as (
    select
        pr.period_start,
        e.address as sentinel,
        sum(if(e.merkle_root = pr.root, 1, -1) * cast(e.sentinel_amount as double)) as grant_raw
    from period_roots as pr
    join published as e
        on e.kind = 'entry' and e.sentinel_amount is not null and e.merkle_root in (pr.root, pr.prev_root)
    where pr.root is not null
    group by 1, 2
),

safe_price as (
    select p.period_start, max(d.price) as price
    from periods as p
    join prices.day as d
        on d.blockchain = 'ethereum'
        and d.contract_address = 0x5afe3855358e112b5647b952709e6165e1c1eeee -- SAFE
        and d."timestamp" = p.period_end - interval '1' day
    group by 1
),

-- Every (period, Sentinel) with chain activity, plus every grant recipient of the period.
joined as (
    select
        p.period_start,
        p.period_end,
        coalesce(pp.sentinel, g.sentinel) as sentinel,
        coalesce(l.label, '0x' || lower(to_hex(coalesce(pp.sentinel, g.sentinel)))) as name,
        'https://gnosisscan.io/address/0x' || lower(to_hex(coalesce(pp.sentinel, g.sentinel))) as sentinel_url,
        max(pp.through_block) over () as through_block,
        p.p_to,
        max(pp.through_t) over () as through_t,
        coalesce(pp.fees, 0) / 1e6 as fees_usdc,
        coalesce(pp.slashed, 0) / 1e6 as slashed_usdc,
        (coalesce(pp.fees, 0) - coalesce(pp.slashed, 0)) / 1e6 as net_fees_usdc,
        coalesce(pp.locked_avg, 0) / 1e6 as capital_locked_usdc,
        coalesce(pp.wallet_avg, 0) / 1e6 as capital_wallet_usdc,
        (coalesce(pp.locked_avg, 0) + coalesce(pp.wallet_avg, 0)) / 1e6 as capital_total_usdc,
        pr.root is not null as is_published,
        if(pr.root is not null, coalesce(g.grant_raw, 0) / 1e18) as safe_grant,
        sp.price as safe_price_usd
    from per_period as pp
    full outer join grants as g on g.period_start = pp.period_start and g.sentinel = pp.sentinel
    join periods as p on p.period_start = coalesce(pp.period_start, g.period_start)
    left join period_roots as pr on pr.period_start = p.period_start
    left join safe_price as sp on sp.period_start = p.period_start
    left join {{query:safenet_participant_labels}} as l on l.role = 'sentinel' and l.address = coalesce(pp.sentinel, g.sentinel)
),

rates as (
    select
        *,
        safe_grant * safe_price_usd as safe_grant_usd,
        -- × 365 days / 14-day period, in percent
        if(capital_locked_usdc > 0, net_fees_usdc / capital_locked_usdc * 365 / 14 * 100) as fee_apr_locked,
        if(capital_locked_usdc > 0, safe_grant * safe_price_usd / capital_locked_usdc * 365 / 14 * 100) as safe_apr_locked,
        if(capital_locked_usdc > 0, (net_fees_usdc + safe_grant * safe_price_usd) / capital_locked_usdc * 365 / 14 * 100) as total_apr_locked,
        if(capital_total_usdc > 0, net_fees_usdc / capital_total_usdc * 365 / 14 * 100) as fee_apr_total,
        if(capital_total_usdc > 0, safe_grant * safe_price_usd / capital_total_usdc * 365 / 14 * 100) as safe_apr_total,
        if(capital_total_usdc > 0, (net_fees_usdc + safe_grant * safe_price_usd) / capital_total_usdc * 365 / 14 * 100) as total_apr_total
    from joined
    where p_to <= through_t -- completed by every input, not by the clock
        and (capital_total_usdc > 0 or net_fees_usdc <> 0 or coalesce(safe_grant, 0) > 0)
)

select
    format_datetime(period_start, 'yyyy-MM-dd') || ' – ' || format_datetime(period_end - interval '1' day, 'yyyy-MM-dd') as period,
    '<a href="' || sentinel_url || '" target="_blank">' || name || '</a>' as sentinel_link,
    name as sentinel,
    '0x' || lower(to_hex(sentinel)) as address,
    total_apr_total,
    total_apr_locked,
    fee_apr_total,
    fee_apr_locked,
    safe_apr_total,
    safe_apr_locked,
    fees_usdc,
    slashed_usdc,
    net_fees_usdc,
    safe_grant,
    safe_price_usd,
    safe_grant_usd,
    capital_locked_usdc,
    capital_wallet_usdc,
    capital_total_usdc,
    case
        when not is_published then 'SAFE grant not published yet'
        when safe_price_usd is null then 'no SAFE price for the period end'
        when safe_grant > 0 then 'published (withheld until KYC counts as granted)'
        else 'published: no grant'
    end as grant_status,
    'gross, before operating costs; 14 d period; non-compounded; fees net of slashes; SAFE at the price of ' || format_datetime(period_end - interval '1' day, 'yyyy-MM-dd') as basis,
    period_start,
    period_end,
    through_block, -- for the verification
    through_t
from rates
order by period_start desc, total_apr_total desc nulls last, name
