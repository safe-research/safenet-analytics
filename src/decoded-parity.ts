// Parity of Dune's decoded Safenet tables with the raw logs the models decode today
// (docs/decoding.md#replacing-raw-logs-with-decoded-tables). Read-only: `npm run dune --
// decoded-parity` runs one unsaved query per decoded contract and executes no saved query.
//
// For each event it matches decoded rows (evt_tx_hash, evt_index) with raw logs (tx_hash, index) of
// the same contract and topic0, from the contract's deploy block to the latest block at least a
// day old. A decoded table can replace raw logs only if both sides have the same logs and the
// decoded table starts at the first raw log (Dune may backfill decoded tables gradually).
// Whether the decoded columns carry the right values is checked by the preview reconciliations
// of the pull request that switches a model.

import { EVENTS, FROST_COORDINATOR, PRODUCTION, REWARDS_DISTRIBUTOR, VALIDATOR_EVENTS, VALIDATOR_STAKER_SET } from "./safenet.ts";

type Event = { signature: string; topic0: string };
export type DecodedSource = {
  table: string; // <namespace>_<chain>.<Contract>, as `check-decoded` reports
  chain: "gnosis" | "ethereum";
  address: string;
  deployBlock: number;
  deployDate: string; // partition pruning of <chain>.logs
  events: Event[];
};

// Production contracts as decoded on Dune (check-decoded, 2026-10-29). The FROSTCoordinator is
// shared with the Aegis testnet: all its logs are compared, production attribution stays in the models.
export const DECODED_SOURCES: DecodedSource[] = [
  {
    table: "safe_gnosis.SafenetAegisConsensus",
    chain: "gnosis",
    address: PRODUCTION.consensus.address,
    deployBlock: PRODUCTION.consensus.deployBlock,
    deployDate: "2026-10-07",
    events: [EVENTS.TransactionProposed, EVENTS.TransactionAttested, VALIDATOR_EVENTS.EpochStaged, VALIDATOR_EVENTS.EpochRolledOver, VALIDATOR_STAKER_SET],
  },
  {
    table: "safe_gnosis.SafenetAegisSentinelOracle",
    chain: "gnosis",
    address: PRODUCTION.sentinelOracle.address,
    deployBlock: PRODUCTION.sentinelOracle.deployBlock,
    deployDate: "2026-10-07",
    events: [
      EVENTS.NewRequest,
      EVENTS.OracleResult,
      EVENTS.DisputeTriggered,
      EVENTS.DisputeResolved,
      EVENTS.DisputeOutOfScope,
      EVENTS.ArbitrationTimedOut,
      EVENTS.RequestTimedOut,
      EVENTS.Committed,
      EVENTS.Revealed,
      EVENTS.Claimed,
      EVENTS.SentinelScheduled,
      EVENTS.SentinelRemoved,
      EVENTS.FeeScheduled,
      EVENTS.DaoFeeShareScheduled,
      EVENTS.ProtocolFundsReceiverScheduled,
      EVENTS.BondConfigScheduled,
    ],
  },
  {
    table: "safe_gnosis.SafenetAegisFROSTCoordinator",
    chain: "gnosis",
    address: FROST_COORDINATOR.address,
    deployBlock: FROST_COORDINATOR.deployBlock,
    deployDate: "2026-10-06",
    events: [VALIDATOR_EVENTS.KeyGen, VALIDATOR_EVENTS.KeyGenConfirmed, VALIDATOR_EVENTS.Sign, VALIDATOR_EVENTS.SignShared, VALIDATOR_EVENTS.SignCompleted],
  },
  {
    table: "safe_ethereum.CumulativeMerkleDrop",
    chain: "ethereum",
    address: REWARDS_DISTRIBUTOR.address,
    deployBlock: REWARDS_DISTRIBUTOR.deployBlock,
    deployDate: REWARDS_DISTRIBUTOR.deployDate,
    events: [EVENTS.RewardsClaimed, EVENTS.MerkelRootUpdated],
  },
];

export const eventName = (e: Event) => e.signature.slice(0, e.signature.indexOf("("));

// One unsaved query per contract: per event, raw logs, decoded rows, logs on one side only, and
// the first block on each side, up to the latest block at least a day old.
export function paritySql(s: DecodedSource): string {
  const names = s.events.map((e) => `            when ${e.topic0} then '${eventName(e)}'`).join("\n");
  const decoded = s.events
    .map(
      (e) =>
        `    select '${eventName(e)}' as event, evt_tx_hash as tx_hash, evt_index as log_index, evt_block_number as block_number\n` +
        `    from ${s.table}_evt_${eventName(e)}, params\n` +
        `    where contract_address = ${s.address} and evt_block_number between ${s.deployBlock} and to_block`,
    )
    .join("\n    union all\n");
  return `with

params as (
    select max(number) as to_block from ${s.chain}.blocks
    where time < now() - interval '1' day and time > now() - interval '3' day
),

raw as (
    select
        case topic0
${names}
        end as event,
        tx_hash,
        index as log_index,
        block_number
    from ${s.chain}.logs, params
    where contract_address = ${s.address}
        and topic0 in (${s.events.map((e) => e.topic0).join(", ")})
        and block_date >= date '${s.deployDate}'
        and block_number between ${s.deployBlock} and to_block
),

decoded as (
${decoded}
),

matched as (
    select coalesce(r.event, d.event) as event, r.block_number as raw_block, d.block_number as decoded_block
    from raw as r
    full outer join decoded as d on d.event = r.event and d.tx_hash = r.tx_hash and d.log_index = r.log_index
)

select
    event,
    count(raw_block) as raw_logs,
    count(decoded_block) as decoded_rows,
    count_if(decoded_block is null) as missing_in_decoded,
    count_if(raw_block is null) as only_in_decoded,
    min(raw_block) as first_raw_block,
    min(decoded_block) as first_decoded_block,
    max(p.to_block) as to_block
from matched
cross join params as p
group by 1
order by 1
`;
}

export type ParityRow = {
  event: string;
  raw_logs: number;
  decoded_rows: number;
  missing_in_decoded: number;
  only_in_decoded: number;
  first_raw_block: number | null;
  first_decoded_block: number | null;
  to_block: number;
};

export type Verdict = { source: string; event: string; ok: boolean; reason: string; row?: ParityRow };

// Events without any log on either side have no row in the result: there is nothing to compare,
// and they are reported as such (not as a pass).
export function verdicts(s: DecodedSource, rows: ParityRow[]): Verdict[] {
  return s.events.map((e) => {
    const name = eventName(e);
    const row = rows.find((r) => r.event === name);
    if (!row) return { source: s.table, event: name, ok: true, reason: "no logs on either side yet" };
    const problems = [];
    if (row.missing_in_decoded) problems.push(`${row.missing_in_decoded} raw logs missing in the decoded table`);
    if (row.only_in_decoded) problems.push(`${row.only_in_decoded} decoded rows without a raw log`);
    return { source: s.table, event: name, ok: problems.length === 0, reason: problems.join("; ") || `all ${row.raw_logs} logs match`, row };
  });
}

export function formatVerdicts(all: Verdict[], errors: { source: string; error: string }[]): string {
  const failed = all.filter((v) => !v.ok);
  const lines = [
    errors.length || failed.length
      ? `**Parity does not hold:** ${failed.length} events differ${errors.length ? `, ${errors.length} contracts could not be checked` : ""}.`
      : `**Parity holds** for all ${all.length} events: every raw log is in the decoded table and vice versa, from the deploy block to the latest block at least a day old.`,
    "",
    "| Decoded table | Raw logs | Decoded rows | First raw block | First decoded block | Up to block | Result |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...all.map(
      (v) =>
        `| \`${v.source}_evt_${v.event}\` | ${v.row?.raw_logs ?? 0} | ${v.row?.decoded_rows ?? 0} | ${v.row?.first_raw_block ?? ""} | ${v.row?.first_decoded_block ?? ""} | ${v.row?.to_block ?? ""} | ${v.ok ? "ok" : "**differs**"}: ${v.reason} |`,
    ),
    ...errors.map((e) => `| \`${e.source}\` | | | | | | **error**: ${e.error.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200)} |`),
  ];
  return lines.join("\n");
}
