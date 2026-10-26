-- SafenetGuard deployments on the Charter's chains, and whether each is bound to the production
-- Consensus. No production guard address is documented, so guards are discovered on chain:
-- every SafenetGuard emits EpochInitialized(uint64,(uint256,uint256)) in its constructor.
--
-- A guard is verified_production only if its creation trace shows it was built for the production
-- Consensus. Its constructor takes (consensusChainId, consensusAddress, initialEpoch, groupKey.x,
-- groupKey.y, allowTxDelay, allowTxWindow), seven ABI words at the end of the init code, and its
-- runtime code embeds the Consensus EIP-712 domain separator as an immutable:
--   0x0a60fd26a8c4c3ecdbc033b1ebaf0af39dacc9965079bd37b21f4af2251fb097
--   = keccak256(abi.encode(EIP712Domain typehash, 100, 0xc855761D619f6002923507cE68B84d7689C2aa96)),
-- equal to Consensus.domainSeparator(). Guards for the testnet or other deployments are listed
-- with verified_production = false and are never counted.

with

inits as (
    select 1 as chain_id, contract_address as guard, block_time, block_date, block_number, tx_hash
    from ethereum.logs
    where topic0 = 0x07350219757b951e219da92d6cfcfbe2db9d097ed40b7aafb4ba3ca85d27143b -- EpochInitialized
        and block_date >= date '2026-09-01' -- before the production Consensus (2026-10-07)
    union all
    select 100, contract_address, block_time, block_date, block_number, tx_hash
    from gnosis.logs
    where topic0 = 0x07350219757b951e219da92d6cfcfbe2db9d097ed40b7aafb4ba3ca85d27143b
        and block_date >= date '2026-09-01'
    union all
    select 42161, contract_address, block_time, block_date, block_number, tx_hash
    from arbitrum.logs
    where topic0 = 0x07350219757b951e219da92d6cfcfbe2db9d097ed40b7aafb4ba3ca85d27143b
        and block_date >= date '2026-09-01'
),

-- The creation trace in the same transaction (CREATE2 through a factory is a create trace too).
creations as (
    select 1 as chain_id, t.address, t.input, t.output
    from ethereum.traces as t
    join inits as i on i.chain_id = 1 and t.block_date = i.block_date and t.tx_hash = i.tx_hash and t.address = i.guard
    where t.type = 'create' and t.success and t.block_date >= date '2026-09-01'
    union all
    select 100, t.address, t.input, t.output
    from gnosis.traces as t
    join inits as i on i.chain_id = 100 and t.block_date = i.block_date and t.tx_hash = i.tx_hash and t.address = i.guard
    where t.type = 'create' and t.success and t.block_date >= date '2026-09-01'
    union all
    select 42161, t.address, t.input, t.output
    from arbitrum.traces as t
    join inits as i on i.chain_id = 42161 and t.block_date = i.block_date and t.tx_hash = i.tx_hash and t.address = i.guard
    where t.type = 'create' and t.success and t.block_date >= date '2026-09-01'
),

decoded as (
    select
        i.chain_id,
        i.guard,
        i.block_time as deployed_at,
        i.block_number as deploy_block,
        i.tx_hash as deploy_tx_hash,
        -- word 1 (chain id) and word 2 (address) of the seven constructor words
        bytearray_to_bigint(bytearray_substring(c.input, bytearray_length(c.input) - 224 + 25, 8)) as consensus_chain_id,
        bytearray_substring(c.input, bytearray_length(c.input) - 224 + 45, 20) as consensus_address,
        bytearray_position(c.output, 0x0a60fd26a8c4c3ecdbc033b1ebaf0af39dacc9965079bd37b21f4af2251fb097) > 0 as embeds_production_domain,
        c.address is not null as has_creation_trace
    from inits as i
    left join creations as c on c.chain_id = i.chain_id and c.address = i.guard
)

select
    *,
    coalesce(
        (consensus_chain_id = 100 and consensus_address = 0xc855761d619f6002923507ce68b84d7689c2aa96)
        or embeds_production_domain,
        false) as verified_production,
    case chain_id when 1 then 'https://etherscan.io' when 100 then 'https://gnosisscan.io' when 42161 then 'https://arbiscan.io' end
        || '/address/0x' || lower(to_hex(guard)) as guard_url
from decoded
