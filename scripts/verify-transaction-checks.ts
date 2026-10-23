// Recomputes the transaction_checks_daily metric from Gnosis Chain RPC logs, independently of Dune,
// checks the lifecycle invariants the SQL relies on, and (with DUNE_API_KEY) compares the result
// with the latest Dune result of the deployed query.
//
//   node scripts/verify-transaction-checks.ts [--rpc URL] [--out verification/transaction_checks_daily.json]

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { DuneClient } from "../src/dune.ts";
import { COVERED_SAFE_CHAINS, EVENTS, ORACLE_STATE, PRODUCTION } from "../src/safenet.ts";
import { loadState } from "../src/state.ts";

const { values: args } = parseArgs({
  options: {
    rpc: { type: "string", default: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com" },
    out: { type: "string", default: "verification/transaction_checks_daily.json" },
  },
});

const ORACLE_TOPIC = `0x${"0".repeat(24)}${PRODUCTION.sentinelOracle.address.slice(2)}`;
const STEP = 200_000;

type Log = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  blockTimestamp?: string;
};

let rpcId = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(args.rpc!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: T; error?: { message: string } };
    if (res.ok && body.result !== undefined) return body.result;
    if (attempt >= 4) throw new Error(`${method} failed: ${res.status} ${body.error?.message ?? ""}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

async function getLogs(address: string, topics: (string | string[] | null)[], from: number, to: number) {
  const logs: Log[] = [];
  for (let start = from; start <= to; start += STEP) {
    const end = Math.min(start + STEP - 1, to);
    logs.push(
      ...(await rpc<Log[]>("eth_getLogs", [
        { address, topics, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` },
      ])),
    );
  }
  return logs;
}

const blockTimes = new Map<number, number>();
async function blockTime(log: Log): Promise<number> {
  const n = Number(log.blockNumber);
  if (log.blockTimestamp) return Number(log.blockTimestamp);
  let t = blockTimes.get(n);
  if (t === undefined) {
    const block = await rpc<{ timestamp: string }>("eth_getBlockByNumber", [log.blockNumber, false]);
    t = Number(block.timestamp);
    blockTimes.set(n, t);
  }
  return t;
}

const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const word = (data: string, i: number) => data.slice(2 + 64 * i, 2 + 64 * (i + 1));
const covered = (safeId: string) => (COVERED_SAFE_CHAINS as readonly number[]).includes(Number(BigInt(safeId) >> 160n));
const order = (a: Log, b: Log) =>
  Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex);

const head = Number(await rpc<{ number: string }>("eth_getBlockByNumber", ["finalized", false]).then((b) => b.number));
const consensus = PRODUCTION.consensus.address;
const oracle = PRODUCTION.sentinelOracle.address;
const outcomeTopics = [
  EVENTS.OracleResult.topic0,
  EVENTS.DisputeResolved.topic0,
  EVENTS.RequestTimedOut.topic0,
  EVENTS.DisputeOutOfScope.topic0,
  EVENTS.ArbitrationTimedOut.topic0,
];

const [proposed, attested, newRequests, outcomes, disputes] = await Promise.all([
  getLogs(consensus, [EVENTS.TransactionProposed.topic0], PRODUCTION.consensus.deployBlock, head),
  getLogs(consensus, [EVENTS.TransactionAttested.topic0], PRODUCTION.consensus.deployBlock, head),
  getLogs(oracle, [EVENTS.NewRequest.topic0], PRODUCTION.sentinelOracle.deployBlock, head),
  getLogs(oracle, [outcomeTopics], PRODUCTION.sentinelOracle.deployBlock, head),
  getLogs(oracle, [EVENTS.DisputeTriggered.topic0], PRODUCTION.sentinelOracle.deployBlock, head),
]);
for (const logs of [proposed, attested, newRequests, outcomes]) logs.sort(order);

const issues: string[] = [];
const prodProposed = proposed.filter((l) => l.topics[3] === ORACLE_TOPIC);
const prodAttested = attested.filter((l) => l.topics[3] === ORACLE_TOPIC);

// Pair proposals and oracle requests within each transaction, in log order.
type Request = { requestId: string; safeTxHash: string; epoch: bigint; covered: boolean; time: number };
const requestsByTx = new Map<string, Log[]>();
for (const l of newRequests) requestsByTx.set(l.transactionHash, [...(requestsByTx.get(l.transactionHash) ?? []), l]);
const proposalsByTx = new Map<string, Log[]>();
for (const l of prodProposed) proposalsByTx.set(l.transactionHash, [...(proposalsByTx.get(l.transactionHash) ?? []), l]);

const rows = new Map<string, Record<string, number>>();
const bump = (d: string, col: string) => {
  const row = rows.get(d) ?? {};
  row[col] = (row[col] ?? 0) + 1;
  rows.set(d, row);
};
const requests = new Map<string, Request>();
for (const [tx, ps] of proposalsByTx) {
  const rs = requestsByTx.get(tx) ?? [];
  if (rs.length !== ps.length) issues.push(`tx ${tx}: ${ps.length} proposals but ${rs.length} oracle requests`);
  for (const [i, p] of ps.entries()) {
    const r = rs[i];
    if (!r) {
      bump(day(await blockTime(p)), "unmatched_events");
      continue;
    }
    if (requests.has(r.topics[1])) issues.push(`request ${r.topics[1]}: requested more than once`);
    if (Number(r.logIndex) < Number(p.logIndex)) issues.push(`tx ${tx}: oracle request precedes its proposal`);
    requests.set(r.topics[1], {
      requestId: r.topics[1],
      safeTxHash: p.topics[1],
      epoch: BigInt(`0x${word(p.data, 0)}`),
      covered: covered(p.topics[2]),
      time: await blockTime(p),
    });
  }
}
for (const tx of requestsByTx.keys())
  if (!proposalsByTx.has(tx)) issues.push(`tx ${tx}: oracle request without production proposal`);

type Outcome = "approved" | "denied" | "no_verdict";
const outcomeOf = new Map<string, Outcome>();

for (const r of requests.values()) bump(day(r.time), r.covered ? "requests" : "uncovered_chain_requests");
for (const l of outcomes) {
  const id = l.topics[1];
  const t0 = l.topics[0];
  const outcome: Outcome =
    t0 === EVENTS.OracleResult.topic0
      ? BigInt(`0x${word(l.data, 1)}`) === 1n
        ? "approved"
        : "denied"
      : t0 === EVENTS.DisputeResolved.topic0
        ? Number(BigInt(`0x${word(l.data, 0)}`)) === ORACLE_STATE.RESOLVED_APPROVED
          ? "approved"
          : "denied"
        : "no_verdict";
  if (outcomeOf.has(id)) issues.push(`request ${id}: more than one terminal outcome`);
  outcomeOf.set(id, outcome);
  const req = requests.get(id);
  const d = day(await blockTime(l));
  if (!req) {
    issues.push(`request ${id}: outcome without production request`);
    bump(d, "unmatched_events");
    continue;
  }
  if (outcome === "no_verdict") {
    if (req.covered) bump(d, "closed_without_verdict");
  } else {
    bump(d, req.covered ? "completed_checks" : "uncovered_chain_completed_checks");
    if (req.covered) bump(d, outcome === "approved" ? "checks_approved" : "checks_denied");
  }
}

// An attestation should follow an approved check of a proposal with the same safeTxHash and epoch.
const approvedKeys = new Set(
  [...requests.values()].filter((r) => outcomeOf.get(r.requestId) === "approved").map((r) => `${r.safeTxHash}:${r.epoch}`),
);
let attestedWithoutApproval = 0;
for (const l of prodAttested) {
  bump(day(await blockTime(l)), covered(l.topics[2]) ? "attestations" : "uncovered_chain_attestations");
  if (!approvedKeys.has(`${l.topics[1]}:${BigInt(`0x${word(l.data, 0)}`)}`)) attestedWithoutApproval++;
}
if (attestedWithoutApproval) issues.push(`${attestedWithoutApproval} attestations without an approved check`);

const COLUMNS = [
  "requests",
  "completed_checks",
  "checks_approved",
  "checks_denied",
  "closed_without_verdict",
  "attestations",
  "uncovered_chain_requests",
  "uncovered_chain_completed_checks",
  "uncovered_chain_attestations",
  "unmatched_events",
] as const;
const table = [...rows.keys()].sort().map((d) => ({
  day: d,
  ...Object.fromEntries(COLUMNS.map((c) => [c, rows.get(d)?.[c] ?? 0])),
})) as ({ day: string } & Record<(typeof COLUMNS)[number], number>)[];

const totals = Object.fromEntries(COLUMNS.map((c) => [c, table.reduce((s, r) => s + r[c], 0)]));
const pending = [...requests.values()].filter((r) => !outcomeOf.has(r.requestId)).length;
const summary = {
  generated_at: new Date().toISOString(),
  rpc: new URL(args.rpc!).host,
  to_block: head,
  to_block_time: new Date((await rpc<{ timestamp: string }>("eth_getBlockByNumber", [`0x${head.toString(16)}`, false]).then((b) => Number(b.timestamp))) * 1000).toISOString(),
  source_events: {
    TransactionProposed_all_oracles: proposed.length,
    TransactionProposed_production_oracle: prodProposed.length,
    NewRequest: newRequests.length,
    terminal_outcomes: outcomes.length,
    DisputeTriggered: disputes.length,
    TransactionAttested_all_oracles: attested.length,
    TransactionAttested_production_oracle: prodAttested.length,
    requests_without_outcome_yet: pending,
  },
  totals,
  issues,
};

// The Dune comparison only covers complete UTC days before the RPC snapshot.
const comparison: { compared_days: number; mismatches: unknown[] } | { skipped: string } = await (async () => {
  const key = process.env.DUNE_API_KEY;
  const id = (await loadState()).queries.transaction_checks_daily?.id;
  if (!key) return { skipped: "DUNE_API_KEY not set" };
  if (!id) return { skipped: "query not deployed yet (no id in dune/state.json)" };
  const result = await new DuneClient(key).latestResults(id);
  const lastFullDay = day(Date.parse(summary.to_block_time) / 1000 - 86400);
  const dune = new Map(result.rows.map((r) => [String(r.day).slice(0, 10), r]));
  const mismatches = [];
  let compared = 0;
  for (const d of new Set([...dune.keys(), ...table.map((r) => r.day)])) {
    // Skip days that were not complete when Dune ran the query.
    if (d > lastFullDay || d >= String(result.execution_ended_at ?? "").slice(0, 10)) continue;
    compared++;
    const ours = table.find((r) => r.day === d);
    const theirs = dune.get(d);
    for (const c of COLUMNS) {
      const a = ours?.[c] ?? 0;
      const b = Number(theirs?.[c] ?? 0);
      if (a !== b) mismatches.push({ day: d, column: c, rpc: a, dune: b });
    }
  }
  return { compared_days: compared, dune_query_id: id, dune_execution_ended_at: result.execution_ended_at, mismatches };
})();

await mkdir(dirname(args.out!), { recursive: true });
await writeFile(args.out!, `${JSON.stringify({ ...summary, dune_comparison: comparison, daily: table }, null, 2)}\n`);

console.table(table);
console.log(JSON.stringify({ ...summary, dune_comparison: comparison }, null, 2));
const failed = issues.length > 0 || ("mismatches" in comparison && comparison.mismatches.length > 0);
if (failed) process.exitCode = 1;
