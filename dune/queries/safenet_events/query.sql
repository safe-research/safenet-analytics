-- Safenet production ("Aegis") events on Gnosis Chain: one row per event, from Dune's decoded
-- Safenet tables (safe_gnosis.SafenetAegisConsensus_evt_*, safe_gnosis.SafenetAegisSentinelOracle_evt_*).
-- Metric queries read it through a managed query reference (src/config.ts). Until 2026-10-29 it
-- decoded raw logs; the decoded tables match them log by log from the deploy blocks
-- (decoded-parity, docs/decoding.md). Contracts and events: src/safenet.ts.
--   Consensus       0xc855761D619f6002923507cE68B84d7689C2aa96 (deployed at block 48635843)
--   SentinelOracle  0x4F61B8832978e83b80D69551AEf07557DBE41d03 (deployed at block 48635850)
--
-- event                one row per
--   request            production proposal: Consensus.TransactionProposed with oracle = production
--                      SentinelOracle, paired with its SentinelOracle.NewRequest (request_id), with
--                      the request's fee and bond terms from NewRequest
--   committed          Sentinel commitment (Committed): bond_amount locked
--   revealed           Sentinel response (Revealed): vote_approved, bond_amount
--   approved, denied   verdict: OracleResult (source_event = 'OracleResult'), or the arbitrator's
--                      ruling after a dispute (source_event = 'DisputeResolved', with slashed)
--   no_verdict         RequestTimedOut, DisputeOutOfScope, ArbitrationTimedOut (source_event)
--   dispute            DisputeTriggered (not an outcome; the request continues to one of the above)
--   claimed            Sentinel claim (Claimed): bond_amount returned, fee_reward paid
--   attestation        Consensus.TransactionAttested with oracle = production SentinelOracle
--   sentinel_scheduled SentinelScheduled (sentinel, active_at_block); not tied to a request
--   sentinel_removed   SentinelRemoved (sentinel); not tied to a request
--   config_scheduled   FeeScheduled, DaoFeeShareScheduled, ProtocolFundsReceiverScheduled,
--                      BondConfigScheduled (source_event, config_change: the decoded values);
--                      not tied to a request
--
-- Amounts are USDC.e base units (6 decimals). covered_chain: the Safe is on a chain the Charter
-- covers (Ethereum, Gnosis Chain, Arbitrum One); other chains are likely test traffic. It is null
-- when an event cannot be matched to a production request: a proposal without an oracle request,
-- an oracle event without a production request, and the sentinel and config events.
-- URL columns: see src/links.ts.

with

-- safeId: chainId in the top 12 bytes, the Safe in the low 20 (SafeId.T is bytes32).
proposals as (
    select
        evt_block_time as block_time,
        evt_block_number as block_number,
        evt_tx_hash as tx_hash,
        evt_index as log_index,
        safeTxHash as safe_tx_hash,
        safeId as safe_id,
        cast(epoch as bigint) as epoch,
        row_number() over (partition by evt_tx_hash order by evt_index) as n
    from safe_gnosis.SafenetAegisConsensus_evt_TransactionProposed
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and oracle = 0x4f61b8832978e83b80d69551aef07557dbe41d03
        and evt_block_number >= 48635843
),

-- NewRequest is emitted in the same transaction as, and after, its TransactionProposed, so the
-- n-th proposal of a transaction pairs with the n-th request of that transaction.
oracle_requests as (
    select
        evt_tx_hash as tx_hash,
        requestId as request_id,
        sponsor,
        cast(fee as bigint) as fee,
        cast(bondTarget as bigint) as bond_target,
        cast(daoFeeShare as bigint) as dao_fee_share, -- of 100000
        cast(slashAmount as bigint) as slash_amount,
        cast(commitDeadline as bigint) as commit_deadline,
        cast(revealDeadline as bigint) as reveal_deadline,
        row_number() over (partition by evt_tx_hash order by evt_index) as n
    from safe_gnosis.SafenetAegisSentinelOracle_evt_NewRequest
    where contract_address = 0x4f61b8832978e83b80d69551aef07557dbe41d03
        and evt_block_number >= 48635850
),

requests as (
    select p.*, r.request_id, r.sponsor, r.fee, r.bond_target, r.dao_fee_share, r.slash_amount, r.commit_deadline, r.reveal_deadline
    from proposals as p
    left join oracle_requests as r
        on r.tx_hash = p.tx_hash
        and r.n = p.n
),

-- Events keyed by requestId, one decoded table each.
oracle_decoded as (
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, requestId, contract_address,
        if(approved, 'approved', 'denied') as event, 'OracleResult' as source_event,
        cast(null as varbinary) as sentinel, cast(null as boolean) as vote_approved,
        cast(null as bigint) as bond_amount, cast(null as bigint) as fee_reward, cast(null as bigint) as slashed
    from safe_gnosis.SafenetAegisSentinelOracle_evt_OracleResult
    union all
    -- outcome: SentinelOracleRequest.State, 3 = RESOLVED_APPROVED, 4 = RESOLVED_DENIED
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, requestId, contract_address,
        if(cast(outcome as bigint) = 3, 'approved', 'denied'), 'DisputeResolved',
        null, null, null, null, cast(slashed as bigint)
    from safe_gnosis.SafenetAegisSentinelOracle_evt_DisputeResolved
    union all
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, requestId, contract_address,
        'dispute', 'DisputeTriggered', null, null, null, null, null
    from safe_gnosis.SafenetAegisSentinelOracle_evt_DisputeTriggered
    union all
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, requestId, contract_address,
        'no_verdict', 'RequestTimedOut', null, null, null, null, null
    from safe_gnosis.SafenetAegisSentinelOracle_evt_RequestTimedOut
    union all
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, requestId, contract_address,
        'no_verdict', 'DisputeOutOfScope', null, null, null, null, null
    from safe_gnosis.SafenetAegisSentinelOracle_evt_DisputeOutOfScope
    union all
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, requestId, contract_address,
        'no_verdict', 'ArbitrationTimedOut', null, null, null, null, null
    from safe_gnosis.SafenetAegisSentinelOracle_evt_ArbitrationTimedOut
    union all
    -- Committed: the bond locked
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, requestId, contract_address,
        'committed', 'Committed', sentinel, null, cast(bondAmount as bigint), null, null
    from safe_gnosis.SafenetAegisSentinelOracle_evt_Committed
    union all
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, requestId, contract_address,
        'revealed', 'Revealed', sentinel, approved, cast(bondAmount as bigint), null, null
    from safe_gnosis.SafenetAegisSentinelOracle_evt_Revealed
    union all
    -- Claimed: the bond returned and the fee reward paid
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, requestId, contract_address,
        'claimed', 'Claimed', sentinel, null, cast(bondReturn as bigint), cast(feeReward as bigint), null
    from safe_gnosis.SafenetAegisSentinelOracle_evt_Claimed
),

oracle_events as (
    select
        evt_block_time as block_time,
        evt_block_number as block_number,
        evt_tx_hash as tx_hash,
        evt_index as log_index,
        requestId as request_id,
        event,
        source_event,
        sentinel,
        vote_approved,
        bond_amount,
        fee_reward,
        slashed
    from oracle_decoded
    where contract_address = 0x4f61b8832978e83b80d69551aef07557dbe41d03
        and evt_block_number >= 48635850
),

-- Governance events, not tied to a request. config_change: the scheduled values as decoded.
admin_decoded as (
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, contract_address,
        'sentinel_scheduled' as event, 'SentinelScheduled' as source_event, sentinel,
        cast(activeAtBlock as bigint) as active_at_block, cast(null as varchar) as config_change
    from safe_gnosis.SafenetAegisSentinelOracle_evt_SentinelScheduled
    union all
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, contract_address,
        'sentinel_removed', 'SentinelRemoved', sentinel, null, null
    from safe_gnosis.SafenetAegisSentinelOracle_evt_SentinelRemoved
    union all
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, contract_address,
        'config_scheduled', 'FeeScheduled', null, null,
        'newValue ' || cast(newValue as varchar) || ', activeAtBlock ' || cast(activeAtBlock as varchar)
    from safe_gnosis.SafenetAegisSentinelOracle_evt_FeeScheduled
    union all
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, contract_address,
        'config_scheduled', 'DaoFeeShareScheduled', null, null,
        'newValue ' || cast(newValue as varchar) || ', activeAtBlock ' || cast(activeAtBlock as varchar)
    from safe_gnosis.SafenetAegisSentinelOracle_evt_DaoFeeShareScheduled
    union all
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, contract_address,
        'config_scheduled', 'ProtocolFundsReceiverScheduled', null, null,
        'newValue 0x' || lower(to_hex(newValue)) || ', activeAtBlock ' || cast(activeAtBlock as varchar)
    from safe_gnosis.SafenetAegisSentinelOracle_evt_ProtocolFundsReceiverScheduled
    union all
    select evt_block_time, evt_block_number, evt_tx_hash, evt_index, contract_address,
        'config_scheduled', 'BondConfigScheduled', null, null,
        'newBondMultiplier ' || cast(newBondMultiplier as varchar) || ', newSlashingMultiplier ' || cast(newSlashingMultiplier as varchar)
            || ', activeAtBlock ' || cast(activeAtBlock as varchar)
    from safe_gnosis.SafenetAegisSentinelOracle_evt_BondConfigScheduled
),

admin_events as (
    select
        evt_block_time as block_time,
        evt_block_number as block_number,
        evt_tx_hash as tx_hash,
        evt_index as log_index,
        event,
        source_event,
        sentinel,
        active_at_block,
        config_change
    from admin_decoded
    where contract_address = 0x4f61b8832978e83b80d69551aef07557dbe41d03
        and evt_block_number >= 48635850
),

attestations as (
    select
        evt_block_time as block_time,
        evt_block_number as block_number,
        evt_tx_hash as tx_hash,
        evt_index as log_index,
        safeTxHash as safe_tx_hash,
        safeId as safe_id,
        cast(epoch as bigint) as epoch
    from safe_gnosis.SafenetAegisConsensus_evt_TransactionAttested
    where contract_address = 0xc855761d619f6002923507ce68b84d7689c2aa96
        and oracle = 0x4f61b8832978e83b80d69551aef07557dbe41d03
        and evt_block_number >= 48635843
),

events as (
    select
        'request' as event, 'TransactionProposed' as source_event, block_time, block_number, tx_hash, log_index,
        request_id, safe_tx_hash, safe_id, epoch, sponsor,
        request_id is not null as matched,
        cast(null as varbinary) as sentinel, cast(null as boolean) as vote_approved,
        cast(null as bigint) as bond_amount, cast(null as bigint) as fee_reward, cast(null as bigint) as slashed,
        fee, bond_target, dao_fee_share, slash_amount, commit_deadline, reveal_deadline,
        cast(null as bigint) as active_at_block, cast(null as varchar) as config_change
    from requests
    union all
    select
        o.event, o.source_event, o.block_time, o.block_number, o.tx_hash, o.log_index,
        o.request_id, r.safe_tx_hash, r.safe_id, r.epoch, r.sponsor,
        r.request_id is not null as matched,
        o.sentinel, o.vote_approved, o.bond_amount, o.fee_reward, o.slashed,
        cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint),
        cast(null as bigint), cast(null as varchar)
    from oracle_events as o
    left join requests as r on r.request_id = o.request_id
    union all
    select
        'attestation' as event, 'TransactionAttested', block_time, block_number, tx_hash, log_index,
        cast(null as varbinary) as request_id, safe_tx_hash, safe_id, epoch, cast(null as varbinary) as sponsor,
        true as matched,
        cast(null as varbinary), cast(null as boolean), cast(null as bigint), cast(null as bigint), cast(null as bigint),
        cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint),
        cast(null as bigint), cast(null as varchar)
    from attestations
    union all
    select
        event, source_event, block_time, block_number, tx_hash, log_index,
        cast(null as varbinary), cast(null as varbinary), cast(null as varbinary), cast(null as bigint), cast(null as varbinary),
        false as matched,
        sentinel, cast(null as boolean), cast(null as bigint), cast(null as bigint), cast(null as bigint),
        cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint), cast(null as bigint),
        active_at_block, config_change
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
        config_change
    from events
)

select
    *,
    case safe_chain_id when 1 then 'https://etherscan.io' when 100 then 'https://gnosisscan.io' when 137 then 'https://polygonscan.com' when 42161 then 'https://arbiscan.io' end || '/address/0x' || lower(to_hex(safe_address)) as safe_url,
    'https://gnosisscan.io/tx/0x' || lower(to_hex(tx_hash)) as tx_url,
    'https://safenet-explorer.eth.limo/#/safeTx?chainId=' || cast(safe_chain_id as varchar) || '&safeTxHash=0x' || lower(to_hex(safe_tx_hash)) as safe_tx_url
from decoded
