-- Safenet production: reverted Sentinel Oracle commit and reveal calls on Gnosis Chain, one row
-- per reverted call, decoded from gnosis.traces. Temporary decoding like safenet_events
-- (docs/decoding.md); selectors in src/safenet.ts (ORACLE_FUNCTIONS), checked in
-- test/safenet.test.ts. Definitions: docs/metrics/sentinels.md#late-and-invalid-submissions.
--
-- A commit or reveal that is late, early, does not match its commitment, or is repeated reverts
-- (CommitWindowClosed, RevealWindowNotOpen, RevealWindowClosed, InvalidReveal, NotCommitted,
-- AlreadyRevealed, AlreadyCommitted) and leaves no event; the reverted call is the only record.
-- The caller is the trace's "from": Sentinels call the oracle from their own account, directly or
-- through EIP-7702 code on that account. request_id is the first argument of both functions.
--   commit(bytes32 requestId, bytes32 commitHash)                    0xe3ce094d
--   reveal(bytes32 requestId, bool approve, bytes32 salt, string)    0x386a15bc

select
    if(bytearray_substring(input, 1, 4) = 0xe3ce094d, 'commit', 'reveal') as call_kind,
    "from" as sentinel,
    bytearray_substring(input, 5, 32) as request_id,
    block_time,
    block_number,
    tx_hash,
    trace_address,
    error,
    -- Revert reason when the call reverted with Error(string), e.g. "ERC20: transfer amount exceeds
    -- balance" when the Sentinel cannot post its bond; null for custom errors or no data.
    case
        when bytearray_length(output) >= 68 and bytearray_substring(output, 1, 4) = 0x08c379a0
            and bytearray_to_bigint(bytearray_substring(output, 61, 8)) > 0
        then from_utf8(bytearray_substring(output, 69, bytearray_to_bigint(bytearray_substring(output, 61, 8))))
    end as revert_reason,
    tx_success,
    'https://gnosisscan.io/tx/0x' || lower(to_hex(tx_hash)) as tx_url
from gnosis.traces
where "to" = 0x4f61b8832978e83b80d69551aef07557dbe41d03 -- production SentinelOracle
    and bytearray_substring(input, 1, 4) in (0xe3ce094d, 0x386a15bc)
    and not success
    and block_number >= 48635850
    and block_date >= date '2026-10-07' -- partition pruning; the oracle was deployed on 2026-10-07
