-- Safenet production ("Aegis") events on Gnosis Chain: one row per event, decoded from raw logs.
-- This is the only query that decodes contract events. Metric queries read it through a managed
-- query reference (src/config.ts). Replacing it with Dune's decoded tables: docs/decoding.md.
-- Contracts, event signatures and topic0 values: src/safenet.ts, checked in test/safenet.test.ts.
--   Consensus       0xc855761D619f6002923507cE68B84d7689C2aa96 (deployed at block 48635843)
--   SentinelOracle  0x4F61B8832978e83b80D69551AEf07557DBE41d03 (deployed at block 48635850)
--
-- event                one row per
--   request            production proposal: Consensus.TransactionProposed with oracle = production
--                      SentinelOracle, paired with its SentinelOracle.NewRequest (request_id), with
--                      the request's fee and bond terms from NewRequest
--   committed          Sentinel commitment (Committed): bond_amount locked
--   revealed           Sentinel response (Revealed): vote_approved, bond_amount, reason
--   approved, denied   verdict: OracleResult (source_event = 'OracleResult'), or the arbitrator's
--                      ruling after a dispute (source_event = 'DisputeResolved', with slashed and
--                      the arbitrator's context in reason)
--   no_verdict         RequestTimedOut, DisputeOutOfScope (context in reason), ArbitrationTimedOut
--                      (source_event)
--   dispute            DisputeTriggered (not an outcome; the request continues to one of the above)
--   claimed            Sentinel claim (Claimed): bond_amount returned, fee_reward paid
--   attestation        Consensus.TransactionAttested with oracle = production SentinelOracle
--   sentinel_scheduled SentinelScheduled (sentinel, active_at_block); not tied to a request
--   sentinel_removed   SentinelRemoved (sentinel); not tied to a request
--   config_scheduled   FeeScheduled, DaoFeeShareScheduled, ProtocolFundsReceiverScheduled,
--                      BondConfigScheduled (source_event, config_data); not tied to a request
--
-- Amounts are USDC.e base units (6 decimals). covered_chain: the Safe is on a chain the Charter
-- covers (Ethereum, Gnosis Chain, Arbitrum One); other chains are likely test traffic. It is null
-- when an event cannot be matched to a production request: a proposal without an oracle request,
-- an oracle event without a production request, and the sentinel and config events.
-- URL columns: see src/links.ts.

with

-- topic1 = safeTxHash, topic2 = safeId (chainId in the top 12 bytes, Safe in the low 20),
-- topic3 = oracle, data word 0 = epoch (uint64).
proposals as (
    select
        block_time,
        block_number,
        tx_hash,
        "index" as log_index,
        topic1 as safe_tx_hash,
        topic2 as safe_id,
        bytearray_to_bigint(bytearray_substring(data, 25, 8)) as epoch,
        row_number() over (partition by tx_hash order by "index") as n
    from gnosis.logs
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and topic0 = 0x47d867ce4d91d0487fa4d2ac80b13e7466ce53dd018a8eef564fc60c92b53d03 -- TransactionProposed
        and topic3 = 0x0000000000000000000000004f61b8832978e83b80d69551aef07557dbe41d03
        and block_number >= 48635843
        and block_date >= date '2026-10-07' -- partition pruning; the contracts were deployed on 2026-10-07
),

-- All SentinelOracle logs read below.
oracle_logs as (
    select block_time, block_number, tx_hash, "index" as log_index, topic0, topic1, topic2, data
    from gnosis.logs
    where contract_address = 0x4f61b8832978e83b80d69551aef07557dbe41d03
        and topic0 in (
            0x8ec61272960f97d43d7f8f85ed630aa512818577f3d1e548e7627b06dbbbda86, -- NewRequest
            0x45acbf2626c7d2bd97eb2142a43d392e8f3364c9e140b3d022446155491819d6, -- Committed
            0xd2cdead965dbd376703d9a79240f31f1228055ab42384b68353332fcd2af939a, -- Revealed
            0x7843c453c4f7442b00e1bf3873e741f18f3447e18a13304c58bef95efd311757, -- OracleResult
            0x7e739d167696b2e67be44f7ceb3afa7ad9e8ad5ee53d016de97ae7ab0b416a70, -- DisputeResolved
            0xf1ca1e9147be737b04a2b018a79405f687a97de8dd8a2559bbe62357343af414, -- RequestTimedOut
            0xe32b95dcf423c9ed3915554e30a0db65ad08358b5e5bdb1138c98dcb745dbe81, -- DisputeOutOfScope
            0x5f19817b3ad988fdb5a7fb3f657a755e58a107bf47431574b7c516a6dc1551e6, -- ArbitrationTimedOut
            0x86e8b85731e4787f033d85108356db1e068dea243be32d422e6dc5681ff49cc1, -- DisputeTriggered
            0x006f1d9d8ec7f5d7941e2363561ba0f1da911361b351d007f9b448d557e39e86, -- Claimed
            0xce737c23e8e6ca890064e37caf80069010b1f755c3fae1708dd03974cc20967d, -- SentinelScheduled
            0x8e7ac62951d0ff2590efb434e0adfbb6b9c0f784993a523c48b42751bab6c5e8, -- SentinelRemoved
            0xdef70574d1d359737ee26a27f066606f6d82fa51e3698f243d987958ec6fdc1c, -- FeeScheduled
            0xb6b8950d378d599036f40812984d24677cfeb9805467d2997651e3fdab8b9b77, -- DaoFeeShareScheduled
            0xd1eff884ebee7603c09e5563e22dfbb73c07549053cfe8ef14c1c95fc18ab70b, -- ProtocolFundsReceiverScheduled
            0xc7a39a5cff0bd7a6c707ae62778c7253bd05c8e0bcfdf9d4b0d74044ecba46a1  -- BondConfigScheduled
        )
        and block_number >= 48635850
        and block_date >= date '2026-10-07'
),

-- NewRequest: topic1 = requestId (the EIP-712 proposal message), topic2 = sponsor, data words:
-- fee, bondTarget, daoFeeShare (of 100000), slashAmount, commitDeadline, revealDeadline.
-- Emitted in the same transaction as, and after, its TransactionProposed, so the n-th proposal
-- of a transaction pairs with the n-th request of that transaction.
oracle_requests as (
    select
        tx_hash,
        topic1 as request_id,
        bytearray_substring(topic2, 13, 20) as sponsor,
        bytearray_to_bigint(bytearray_substring(data, 25, 8)) as fee,
        bytearray_to_bigint(bytearray_substring(data, 57, 8)) as bond_target,
        bytearray_to_bigint(bytearray_substring(data, 89, 8)) as dao_fee_share,
        bytearray_to_bigint(bytearray_substring(data, 121, 8)) as slash_amount,
        bytearray_to_bigint(bytearray_substring(data, 153, 8)) as commit_deadline,
        bytearray_to_bigint(bytearray_substring(data, 185, 8)) as reveal_deadline,
        row_number() over (partition by tx_hash order by log_index) as n
    from oracle_logs
    where topic0 = 0x8ec61272960f97d43d7f8f85ed630aa512818577f3d1e548e7627b06dbbbda86 -- NewRequest
),

requests as (
    select p.*, r.request_id, r.sponsor, r.fee, r.bond_target, r.dao_fee_share, r.slash_amount, r.commit_deadline, r.reveal_deadline
    from proposals as p
    left join oracle_requests as r
        on r.tx_hash = p.tx_hash
        and r.n = p.n
),

-- Events keyed by requestId (topic1). Committed, Revealed and Claimed: topic2 = sentinel.
oracle_events as (
    select
        block_time,
        block_number,
        tx_hash,
        log_index,
        topic1 as request_id,
        case topic0
            when 0x7843c453c4f7442b00e1bf3873e741f18f3447e18a13304c58bef95efd311757 -- OracleResult(bytes result, bool approved)
                then if(bytearray_substring(data, 64, 1) = 0x01, 'approved', 'denied')
            when 0x7e739d167696b2e67be44f7ceb3afa7ad9e8ad5ee53d016de97ae7ab0b416a70 -- DisputeResolved(uint8 outcome, uint128 slashed, string): 3 approved, 4 denied
                then if(bytearray_substring(data, 32, 1) = 0x03, 'approved', 'denied')
            when 0x86e8b85731e4787f033d85108356db1e068dea243be32d422e6dc5681ff49cc1 then 'dispute'
            when 0x45acbf2626c7d2bd97eb2142a43d392e8f3364c9e140b3d022446155491819d6 then 'committed'
            when 0xd2cdead965dbd376703d9a79240f31f1228055ab42384b68353332fcd2af939a then 'revealed'
            when 0x006f1d9d8ec7f5d7941e2363561ba0f1da911361b351d007f9b448d557e39e86 then 'claimed'
            else 'no_verdict' -- RequestTimedOut, DisputeOutOfScope, ArbitrationTimedOut
        end as event,
        case topic0
            when 0x7843c453c4f7442b00e1bf3873e741f18f3447e18a13304c58bef95efd311757 then 'OracleResult'
            when 0x7e739d167696b2e67be44f7ceb3afa7ad9e8ad5ee53d016de97ae7ab0b416a70 then 'DisputeResolved'
            when 0xf1ca1e9147be737b04a2b018a79405f687a97de8dd8a2559bbe62357343af414 then 'RequestTimedOut'
            when 0xe32b95dcf423c9ed3915554e30a0db65ad08358b5e5bdb1138c98dcb745dbe81 then 'DisputeOutOfScope'
            when 0x5f19817b3ad988fdb5a7fb3f657a755e58a107bf47431574b7c516a6dc1551e6 then 'ArbitrationTimedOut'
            when 0x86e8b85731e4787f033d85108356db1e068dea243be32d422e6dc5681ff49cc1 then 'DisputeTriggered'
            when 0x45acbf2626c7d2bd97eb2142a43d392e8f3364c9e140b3d022446155491819d6 then 'Committed'
            when 0xd2cdead965dbd376703d9a79240f31f1228055ab42384b68353332fcd2af939a then 'Revealed'
            when 0x006f1d9d8ec7f5d7941e2363561ba0f1da911361b351d007f9b448d557e39e86 then 'Claimed'
        end as source_event,
        if(topic0 in (
            0x45acbf2626c7d2bd97eb2142a43d392e8f3364c9e140b3d022446155491819d6,
            0xd2cdead965dbd376703d9a79240f31f1228055ab42384b68353332fcd2af939a,
            0x006f1d9d8ec7f5d7941e2363561ba0f1da911361b351d007f9b448d557e39e86
        ), bytearray_substring(topic2, 13, 20)) as sentinel,
        -- Revealed(bool approved, uint96 bondAmount, string reason): word 0 = approved
        if(topic0 = 0xd2cdead965dbd376703d9a79240f31f1228055ab42384b68353332fcd2af939a,
            bytearray_substring(data, 32, 1) = 0x01) as vote_approved,
        case topic0
            when 0x45acbf2626c7d2bd97eb2142a43d392e8f3364c9e140b3d022446155491819d6 -- Committed(uint96 bondAmount): locked
                then bytearray_to_bigint(bytearray_substring(data, 25, 8))
            when 0xd2cdead965dbd376703d9a79240f31f1228055ab42384b68353332fcd2af939a -- Revealed: word 1 = bondAmount
                then bytearray_to_bigint(bytearray_substring(data, 57, 8))
            when 0x006f1d9d8ec7f5d7941e2363561ba0f1da911361b351d007f9b448d557e39e86 -- Claimed(uint96 bondReturn, uint96 feeReward): returned
                then bytearray_to_bigint(bytearray_substring(data, 25, 8))
        end as bond_amount,
        if(topic0 = 0x006f1d9d8ec7f5d7941e2363561ba0f1da911361b351d007f9b448d557e39e86,
            bytearray_to_bigint(bytearray_substring(data, 57, 8))) as fee_reward,
        if(topic0 = 0x7e739d167696b2e67be44f7ceb3afa7ad9e8ad5ee53d016de97ae7ab0b416a70,
            bytearray_to_bigint(bytearray_substring(data, 57, 8))) as slashed,
        -- Recorded text, an ABI string (offset word, then length word and bytes): Revealed.reason
        -- (empty for approvals, Charter rule IDs for denials; offset in word 2), and the
        -- arbitrator's context of DisputeResolved (word 2) and DisputeOutOfScope (word 0).
        if(bytearray_to_bigint(bytearray_substring(data, string_at + 25, 8)) > 0,
            from_utf8(bytearray_substring(data, string_at + 33, bytearray_to_bigint(bytearray_substring(data, string_at + 25, 8))))) as reason
    from (
        select
            *,
            case topic0
                when 0xd2cdead965dbd376703d9a79240f31f1228055ab42384b68353332fcd2af939a -- Revealed
                    then bytearray_to_bigint(bytearray_substring(data, 89, 8))
                when 0x7e739d167696b2e67be44f7ceb3afa7ad9e8ad5ee53d016de97ae7ab0b416a70 -- DisputeResolved
                    then bytearray_to_bigint(bytearray_substring(data, 89, 8))
                when 0xe32b95dcf423c9ed3915554e30a0db65ad08358b5e5bdb1138c98dcb745dbe81 -- DisputeOutOfScope
                    then bytearray_to_bigint(bytearray_substring(data, 25, 8))
            end as string_at
        from oracle_logs
    )
    where topic0 not in (
        0x8ec61272960f97d43d7f8f85ed630aa512818577f3d1e548e7627b06dbbbda86, -- NewRequest (see requests)
        0xce737c23e8e6ca890064e37caf80069010b1f755c3fae1708dd03974cc20967d, -- SentinelScheduled
        0x8e7ac62951d0ff2590efb434e0adfbb6b9c0f784993a523c48b42751bab6c5e8, -- SentinelRemoved
        0xdef70574d1d359737ee26a27f066606f6d82fa51e3698f243d987958ec6fdc1c, -- FeeScheduled
        0xb6b8950d378d599036f40812984d24677cfeb9805467d2997651e3fdab8b9b77, -- DaoFeeShareScheduled
        0xd1eff884ebee7603c09e5563e22dfbb73c07549053cfe8ef14c1c95fc18ab70b, -- ProtocolFundsReceiverScheduled
        0xc7a39a5cff0bd7a6c707ae62778c7253bd05c8e0bcfdf9d4b0d74044ecba46a1  -- BondConfigScheduled
    )
),

-- Governance events, not tied to a request. SentinelScheduled(address indexed sentinel,
-- uint256 activeAtBlock); SentinelRemoved(address indexed sentinel); *Scheduled: raw data kept.
admin_events as (
    select
        block_time,
        block_number,
        tx_hash,
        log_index,
        case topic0
            when 0xce737c23e8e6ca890064e37caf80069010b1f755c3fae1708dd03974cc20967d then 'sentinel_scheduled'
            when 0x8e7ac62951d0ff2590efb434e0adfbb6b9c0f784993a523c48b42751bab6c5e8 then 'sentinel_removed'
            else 'config_scheduled'
        end as event,
        case topic0
            when 0xce737c23e8e6ca890064e37caf80069010b1f755c3fae1708dd03974cc20967d then 'SentinelScheduled'
            when 0x8e7ac62951d0ff2590efb434e0adfbb6b9c0f784993a523c48b42751bab6c5e8 then 'SentinelRemoved'
            when 0xdef70574d1d359737ee26a27f066606f6d82fa51e3698f243d987958ec6fdc1c then 'FeeScheduled'
            when 0xb6b8950d378d599036f40812984d24677cfeb9805467d2997651e3fdab8b9b77 then 'DaoFeeShareScheduled'
            when 0xd1eff884ebee7603c09e5563e22dfbb73c07549053cfe8ef14c1c95fc18ab70b then 'ProtocolFundsReceiverScheduled'
            when 0xc7a39a5cff0bd7a6c707ae62778c7253bd05c8e0bcfdf9d4b0d74044ecba46a1 then 'BondConfigScheduled'
        end as source_event,
        if(topic0 in (
            0xce737c23e8e6ca890064e37caf80069010b1f755c3fae1708dd03974cc20967d,
            0x8e7ac62951d0ff2590efb434e0adfbb6b9c0f784993a523c48b42751bab6c5e8
        ), bytearray_substring(topic1, 13, 20)) as sentinel,
        if(topic0 = 0xce737c23e8e6ca890064e37caf80069010b1f755c3fae1708dd03974cc20967d,
            bytearray_to_bigint(bytearray_substring(data, 25, 8))) as active_at_block,
        if(topic0 not in (
            0xce737c23e8e6ca890064e37caf80069010b1f755c3fae1708dd03974cc20967d,
            0x8e7ac62951d0ff2590efb434e0adfbb6b9c0f784993a523c48b42751bab6c5e8
        ), coalesce(topic1, from_hex('')) || data) as config_data
    from oracle_logs
    where topic0 in (
        0xce737c23e8e6ca890064e37caf80069010b1f755c3fae1708dd03974cc20967d,
        0x8e7ac62951d0ff2590efb434e0adfbb6b9c0f784993a523c48b42751bab6c5e8,
        0xdef70574d1d359737ee26a27f066606f6d82fa51e3698f243d987958ec6fdc1c,
        0xb6b8950d378d599036f40812984d24677cfeb9805467d2997651e3fdab8b9b77,
        0xd1eff884ebee7603c09e5563e22dfbb73c07549053cfe8ef14c1c95fc18ab70b,
        0xc7a39a5cff0bd7a6c707ae62778c7253bd05c8e0bcfdf9d4b0d74044ecba46a1
    )
),

-- TransactionAttested: topic1 = safeTxHash, topic2 = safeId, topic3 = oracle, data word 0 = epoch.
attestations as (
    select
        block_time,
        block_number,
        tx_hash,
        "index" as log_index,
        topic1 as safe_tx_hash,
        topic2 as safe_id,
        bytearray_to_bigint(bytearray_substring(data, 25, 8)) as epoch
    from gnosis.logs
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and topic0 = 0x1980afd018b6bb99a313d3b7a88274259621396f9b8acaa712ef114872977357 -- TransactionAttested
        and topic3 = 0x0000000000000000000000004f61b8832978e83b80d69551aef07557dbe41d03
        and block_number >= 48635843
        and block_date >= date '2026-10-07'
),

events as (
    select
        'request' as event, 'TransactionProposed' as source_event, block_time, block_number, tx_hash, log_index,
        request_id, safe_tx_hash, safe_id, epoch, sponsor,
        request_id is not null as matched,
        cast(null as varbinary) as sentinel, cast(null as boolean) as vote_approved,
        cast(null as bigint) as bond_amount, cast(null as bigint) as fee_reward, cast(null as bigint) as slashed,
        fee, bond_target, dao_fee_share, slash_amount, commit_deadline, reveal_deadline,
        cast(null as bigint) as active_at_block, cast(null as varbinary) as config_data, cast(null as varchar) as reason
    from requests
    union all
    select
        o.event, o.source_event, o.block_time, o.block_number, o.tx_hash, o.log_index,
        o.request_id, r.safe_tx_hash, r.safe_id, r.epoch, r.sponsor,
        r.request_id is not null as matched,
        o.sentinel, o.vote_approved, o.bond_amount, o.fee_reward, o.slashed,
        cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint),
        cast(null as bigint), cast(null as varbinary), o.reason
    from oracle_events as o
    left join requests as r on r.request_id = o.request_id
    union all
    select
        'attestation' as event, 'TransactionAttested', block_time, block_number, tx_hash, log_index,
        cast(null as varbinary) as request_id, safe_tx_hash, safe_id, epoch, cast(null as varbinary) as sponsor,
        true as matched,
        cast(null as varbinary), cast(null as boolean), cast(null as bigint), cast(null as bigint), cast(null as bigint),
        cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint),
        cast(null as bigint), cast(null as varbinary), cast(null as varchar)
    from attestations
    union all
    select
        event, source_event, block_time, block_number, tx_hash, log_index,
        cast(null as varbinary), cast(null as varbinary), cast(null as varbinary), cast(null as bigint), cast(null as varbinary),
        false as matched,
        sentinel, cast(null as boolean), cast(null as bigint), cast(null as bigint), cast(null as bigint),
        cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint),
        active_at_block, config_data, cast(null as varchar)
    from admin_events
),

decoded as (
    select
        event,
        source_event,
        block_time,
        block_number,
        tx_hash,
        log_index,
        request_id,
        safe_tx_hash,
        bytearray_to_bigint(bytearray_substring(safe_id, 5, 8)) as safe_chain_id,
        bytearray_substring(safe_id, 13, 20) as safe_address,
        epoch,
        sponsor,
        if(matched, bytearray_substring(safe_id, 1, 12) in (
            0x000000000000000000000001, -- Ethereum
            0x000000000000000000000064, -- Gnosis Chain
            0x00000000000000000000a4b1  -- Arbitrum One
        )) as covered_chain,
        sentinel,
        vote_approved,
        bond_amount,
        fee_reward,
        slashed,
        fee,
        bond_target,
        dao_fee_share,
        slash_amount,
        commit_deadline,
        reveal_deadline,
        active_at_block,
        config_data,
        reason
    from events
)

select
    *,
    case safe_chain_id when 1 then 'https://etherscan.io' when 100 then 'https://gnosisscan.io' when 137 then 'https://polygonscan.com' when 42161 then 'https://arbiscan.io' end || '/address/0x' || lower(to_hex(safe_address)) as safe_url,
    'https://gnosisscan.io/tx/0x' || lower(to_hex(tx_hash)) as tx_url,
    'https://safenet-explorer.eth.limo/#/safeTx?chainId=' || cast(safe_chain_id as varchar) || '&safeTxHash=0x' || lower(to_hex(safe_tx_hash)) as safe_tx_url
from decoded
