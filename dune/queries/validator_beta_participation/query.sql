-- Beta reward participation per Beta reward period and validator, as the Beta reward scripts counted
-- it (safe-fndn/safenet-staking-scripts before Aegis, e.g. c04d176 src/data/attestations.ts):
-- recognised signature shares on transaction ceremonies completed in the period (both ends included),
-- out of all such ceremonies, member or not. Definitions: docs/metrics/staking.md#realized-apr.
--
-- A transaction ceremony is a FROST signing ceremony of the Beta coordinator (0xae27…d7e4, named by
-- Beta Consensus getCoordinator()) whose signature id appears in a Beta Consensus (0x2236…cEE9)
-- TransactionAttested. A share counts only under the selection root of the ceremony's
-- SignCompleted. Beta had no settlement block (introduced for Aegis).
--
-- Read from Dune's decoded Beta tables (safe_gnosis.SafenetBetaConsensus_evt_*,
-- safe_gnosis.SafenetBetaFROSTCoordinator_evt_*), restricted to the two contract addresses and bounded
-- to the Beta reward months (blocks 45525872 – 48643007, 2026-04-06 – 2026-10-08). decoded-parity
-- compares them with the raw logs (docs/decoding.md#switches).

with

-- Signature ids of attested transactions (Beta Consensus).
attested as (
    select distinct signatureId as sid
    from safe_gnosis.SafenetBetaConsensus_evt_TransactionAttested
    where contract_address = 0x223624cbf099e5a8f8cd5af22afa424a1d1acee9 -- Beta Consensus
        and evt_block_number between 45525872 and 48643007
        and evt_block_date between date '2026-04-06' and date '2026-10-08'
),

completed as (
    select sid, selectionRoot as selection_root, min(evt_block_time) as completed_at
    from safe_gnosis.SafenetBetaFROSTCoordinator_evt_SignCompleted
    where contract_address = 0xae27021ceb45316f1efe69d8e362ac07ed3bd7e4 -- Beta FROST coordinator
        and evt_block_number between 45525872 and 48643007
        and evt_block_date between date '2026-04-06' and date '2026-10-08'
    group by 1, 2
),

ceremonies as (
    select c.sid, c.selection_root, c.completed_at
    from completed as c
    join attested as a on a.sid = c.sid
),

shares as (
    select distinct sid, selectionRoot as selection_root, participant as validator
    from safe_gnosis.SafenetBetaFROSTCoordinator_evt_SignShared
    where contract_address = 0xae27021ceb45316f1efe69d8e362ac07ed3bd7e4 -- Beta FROST coordinator
        and evt_block_number between 45525872 and 48643007
        and evt_block_date between date '2026-04-06' and date '2026-10-08'
),

periods as (
    select from_unixtime(p_to - 1209600) as period_start, from_unixtime(p_to) as period_end
    from unnest(sequence(cast(1776729600 as bigint), cast(1791244800 as bigint), cast(1209600 as bigint))) as t (p_to)
),

in_period as (
    select p.period_start, p.period_end, c.sid, c.selection_root
    from ceremonies as c
    join periods as p on c.completed_at >= p.period_start and c.completed_at <= p.period_end
),

counts as (
    select period_start, period_end, count(*) as transactions from in_period group by 1, 2
),

signed as (
    select i.period_start, i.period_end, s.validator, count(*) as signed
    from in_period as i
    join shares as s on s.sid = i.sid and s.selection_root = i.selection_root
    group by 1, 2, 3
)

select
    c.period_start,
    c.period_end,
    g.validator,
    g.signed,
    c.transactions,
    1.0 * g.signed / c.transactions as participation
from counts as c
join signed as g on g.period_start = c.period_start and g.period_end = c.period_end
