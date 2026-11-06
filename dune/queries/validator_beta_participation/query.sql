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
-- Read from raw logs in one scan, bounded to the Beta reward months (blocks 45525872 – 48643007,
-- 2026-04-06 – 2026-10-08); see docs/decoding.md. The coordinator emits Aegis's event
-- signatures (VALIDATOR_EVENTS); the Beta TransactionAttested has its own (BETA_TRANSACTION_ATTESTED).

with

logs as (
    select contract_address, topic0, topic1, topic2, data, block_time
    from gnosis.logs
    where contract_address in (
            0xae27021ceb45316f1efe69d8e362ac07ed3bd7e4, -- Beta FROST coordinator
            0x223624cbf099e5a8f8cd5af22afa424a1d1acee9 -- Beta Consensus
        )
        and topic0 in (
            0x25a4d6e8d11a9fdc20ffdd826473485ae4cdd453271726c072a16836c1882e7c, -- SignShared
            0x7f1641fa8e46c311f05dc0cb9f69f0ac0f27dd12388a5587c7983de9e99a028d, -- SignCompleted
            0x72272729e643703db011cc155474c30d652f1a68712d921cc263a881efd7bce6 -- TransactionAttested (Beta)
        )
        and block_number between 45525872 and 48643007
        and block_date between date '2026-04-06' and date '2026-10-08'
),

-- Signature ids of attested transactions (Beta Consensus; data: epoch, signatureId, attestation).
attested as (
    select distinct bytearray_substring(data, 33, 32) as sid
    from logs
    where contract_address = 0x223624cbf099e5a8f8cd5af22afa424a1d1acee9
),

completed as (
    select topic1 as sid, topic2 as selection_root, min(block_time) as completed_at
    from logs
    where contract_address = 0xae27021ceb45316f1efe69d8e362ac07ed3bd7e4 and topic0 = 0x7f1641fa8e46c311f05dc0cb9f69f0ac0f27dd12388a5587c7983de9e99a028d
    group by 1, 2
),

ceremonies as (
    select c.sid, c.selection_root, c.completed_at
    from completed as c
    join attested as a on a.sid = c.sid
),

-- SignShared(sid indexed, selectionRoot indexed, participant, z)
shares as (
    select distinct topic1 as sid, topic2 as selection_root, bytearray_substring(data, 13, 20) as validator
    from logs
    where contract_address = 0xae27021ceb45316f1efe69d8e362ac07ed3bd7e4 and topic0 = 0x25a4d6e8d11a9fdc20ffdd826473485ae4cdd453271726c072a16836c1882e7c
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
