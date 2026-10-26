// Verifies the Network & revenue section against Gnosis Chain RPC logs, independently of Dune
// (docs/metrics/network-and-revenue.md#verification).
//
//   - Recounts every request's lifecycle, the time-window summary, the result breakdown, the
//     network breakdown and the fee allocation from logs, using the same rules as the SQL
//     (scripts/lib/recount.ts), and compares them with the latest Dune results. Each Dune result
//     reports the highest block it read (through_block); the recount stops at exactly that block.
//   - Checks the fee accounting against actual USDC.e transfers: every transfer classified, fees
//     recorded = fees received, claims = claim transfers, and the oracle's balance = transfers in
//     minus out = its outstanding obligations.
//   - Lists representative requests of every lifecycle path with explorer links, for a manual
//     comparison with safenet-explorer.eth.limo.
//
//   node scripts/verify-network-revenue.ts [--rpc URL] [--state dune/.preview/<track>.json] [--out FILE]

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { DuneClient } from "../src/dune.ts";
import { loadKnownSafes } from "../src/known-traffic.ts";
import { safeTxUrl, txUrl } from "../src/links.ts";
import { FEE_TOKEN, PRODUCTION } from "../src/safenet.ts";
import { loadState } from "../src/state.ts";
import {
  accounting,
  buildRequests,
  classifyTransfers,
  day,
  fetchSafenetLogs,
  rpcClient,
  status,
  upTo,
  usdc,
  type RequestRecord,
} from "./lib/recount.ts";

const { values: args } = parseArgs({
  options: {
    rpc: { type: "string", default: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com" },
    state: { type: "string" },
    out: { type: "string", default: "verification/network_revenue.local.json" },
  },
});

const rpc = rpcClient(args.rpc!);
const mismatches: Record<string, unknown>[] = [];
const near = (a: number, b: number) => Math.abs(a - b) < 5e-7;
const compare = (where: string, column: string, rpcValue: number, duneValue: unknown) => {
  const d = Number(duneValue ?? 0);
  if (!near(rpcValue, d)) mismatches.push({ where, column, rpc: rpcValue, dune: d });
};
const duneTime = (v: unknown) => Date.parse(String(v).replace(" UTC", "Z").replace(" ", "T")) / 1000;

// ---------------------------------------------------------------------------------------------
// Dune results (optional)

type Result = Awaited<ReturnType<DuneClient["latestResults"]>>;
const dune: Partial<Record<"network_summary" | "network_breakdown" | "results_daily" | "fee_allocation", Result>> = {};
const key = process.env.DUNE_API_KEY;
const state = await loadState(args.state);
if (key) {
  const client = new DuneClient(key);
  for (const q of ["network_summary", "network_breakdown", "results_daily", "fee_allocation"] as const) {
    const id = state.queries[q]?.id;
    if (id) dune[q] = await client.latestResults(id);
  }
}
const boundOf = (r?: Result) => (r?.rows.length ? Math.max(...r.rows.map((x) => Number(x.through_block ?? 0))) : undefined);

// ---------------------------------------------------------------------------------------------
// Chain

const head = await rpc.finalized();
const bounds = Object.values(dune).map(boundOf).filter((b): b is number => !!b);
const to = Math.max(head, ...bounds);
const allLogs = await fetchSafenetLogs(rpc, to);
const operational = new Set((await loadKnownSafes()).filter((s) => s.category === "operational").map((s) => `${s.chain_id}:${s.address}`));

async function recount(block: number) {
  const logs = upTo(allLogs, block);
  const built = await buildRequests(rpc, logs, operational);
  return { logs, ...built, flows: classifyTransfers(logs, built.requests) };
}

// ---------------------------------------------------------------------------------------------
// Fee accounting and balance at the finalized head (independent of Dune)

const atHead = await recount(head);
const issues = [...atHead.issues];
const sum = (rs: RequestRecord[], f: (a: ReturnType<typeof accounting>, r: RequestRecord) => bigint) =>
  rs.reduce((s, r) => s + f(accounting(r), r), 0n);
const flowSum = (flows: typeof atHead.flows, flow: string) => flows.filter((f) => f.flow === flow).reduce((s, f) => s + f.amount, 0n);

function feeTotals(rec: Awaited<ReturnType<typeof recount>>) {
  const rs = rec.requests;
  return {
    fees: sum(rs, (_, r) => r.fee),
    fee_in: flowSum(rec.flows, "fee_in"),
    bond_in: flowSum(rec.flows, "bond_in"),
    claim_out: flowSum(rec.flows, "claim_out"),
    refund_out: flowSum(rec.flows, "refund_out"),
    receiver_out: flowSum(rec.flows, "receiver_out"),
    unclassified: flowSum(rec.flows, "unclassified"),
    refunds_from_fee: sum(rs, (a) => a.refundFromFee),
    refunds_from_slashes: sum(rs, (a) => a.refundFromSlashes),
    rewards_accrued: sum(rs, (a) => a.rewardAccrued),
    rewards_claimed: sum(rs, (a) => a.rewardClaimed),
    receiver: sum(rs, (a) => a.receiver),
    fee_held: sum(rs, (a) => a.feeHeld),
    bonds_locked: sum(rs, (_, r) => r.bondLocked),
    bonds_returned: sum(rs, (a) => a.bondReturned),
    bonds_slashed: sum(rs, (a) => a.bondSlashed),
    balance: rec.flows.reduce((s, f) => s + (f.direction === "in" ? f.amount : -f.amount), 0n),
  };
}

const t = feeTotals(atHead);
const obligations = t.fee_held + (t.rewards_accrued - t.rewards_claimed) + (t.bonds_locked - t.bonds_returned - t.bonds_slashed) + (t.receiver - t.receiver_out);
const balanceOnChain = BigInt(
  await rpc.call<string>("eth_call", [
    { to: FEE_TOKEN.address, data: `0x70a08231${PRODUCTION.sentinelOracle.address.slice(2).padStart(64, "0")}` },
    `0x${head.toString(16)}`,
  ]),
);
const feeChecks = {
  fees_recorded_minus_received: usdc(t.fees - t.fee_in),
  unclassified_transfers: usdc(t.unclassified),
  claims_events_minus_transfers: usdc(
    atHead.requests.reduce((s, r) => s + r.claims.reduce((x, c) => x + c.bondReturn + c.feeReward, 0n), 0n) - t.claim_out,
  ),
  refunds_accrued_minus_paid: usdc(t.refunds_from_fee + t.refunds_from_slashes - t.refund_out),
  receiver_accrued_minus_paid: usdc(t.receiver - t.receiver_out),
  balance_on_chain_minus_transfers: usdc(balanceOnChain - t.balance),
  balance_minus_obligations: usdc(t.balance - obligations),
};
for (const [k, v] of Object.entries(feeChecks)) if (!near(v, 0)) issues.push(`fee check ${k} = ${v}`);

// ---------------------------------------------------------------------------------------------
// Comparison with Dune, each at its own through_block

const statusOf = (r: RequestRecord) => status(r);

async function compareSummary(r: Result) {
  const rec = await recount(boundOf(r)!);
  const computedAt = duneTime(r.rows[0].computed_at);
  const sinceOf: Record<string, number> = {
    "All time": Date.parse("2026-10-07T00:00:00Z") / 1000,
    "Last 30 days": computedAt - 30 * 86400,
    "Last 7 days": computedAt - 7 * 86400,
    "Last 24 hours": computedAt - 86400,
  };
  for (const row of r.rows) {
    const since = sinceOf[String(row.time_window)];
    const rs = rec.requests;
    const cov = rs.filter((x) => x.covered);
    const done = (x: RequestRecord) => statusOf(x).completed && x.outcome!.time >= since;
    const where = `network_summary ${row.time_window}`;
    compare(where, "requests", cov.filter((x) => x.proposedAt >= since).length, row.requests);
    compare(where, "unique_safe_transactions", new Set(cov.filter((x) => x.proposedAt >= since).map((x) => `${x.chainId}:${x.safe}:${x.safeTxHash}`)).size, row.unique_safe_transactions);
    compare(where, "sentinel_responses", cov.flatMap((x) => x.votes).filter((v) => v.approved !== null && v.time! >= since).length, row.sentinel_responses);
    compare(where, "completed_results", cov.filter(done).length, row.completed_results);
    compare(where, "attestations", rec.attestations.filter((a) => [1, 100, 42161].includes(a.chainId) && a.time >= since).length, row.attestations);
    compare(where, "safes_with_requests", new Set(cov.filter((x) => x.proposedAt >= since).map((x) => `${x.chainId}:${x.safe}`)).size, row.safes_with_requests);
    compare(where, "safes_with_completed_checks", new Set(cov.filter(done).map((x) => `${x.chainId}:${x.safe}`)).size, row.safes_with_completed_checks);
    compare(where, "operational_requests", cov.filter((x) => x.operational && x.proposedAt >= since).length, row.operational_requests);
    compare(where, "test_requests", rs.filter((x) => !x.covered && x.proposedAt >= since).length, row.test_requests);
    compare(where, "gross_fees_usdc", usdc(rs.filter((x) => x.proposedAt >= since).reduce((s, x) => s + x.fee, 0n)), row.gross_fees_usdc);
    compare(where, "refunds_usdc", usdc(rs.filter((x) => x.outcome && x.outcome.time >= since).reduce((s, x) => s + accounting(x).sponsorRefund, 0n)), row.refunds_usdc);
  }
}

async function compareBreakdown(r: Result) {
  const rec = await recount(boundOf(r)!);
  const chains = new Set([...rec.requests.map((x) => x.chainId), ...r.rows.map((x) => Number(x.safe_chain_id))]);
  for (const c of chains) {
    const rs = rec.requests.filter((x) => x.chainId === c);
    const row = r.rows.find((x) => Number(x.safe_chain_id) === c) ?? {};
    const where = `network_breakdown chain ${c}`;
    const done = rs.filter((x) => statusOf(x).completed);
    compare(where, "requests", rs.length, row.requests);
    compare(where, "completed_results", done.length, row.completed_results);
    compare(where, "attestations", rec.attestations.filter((a) => a.chainId === c).length, row.attestations);
    compare(where, "safes_with_requests", new Set(rs.map((x) => x.safe)).size, row.safes_with_requests);
    compare(where, "safes_with_completed_checks", new Set(done.map((x) => x.safe)).size, row.safes_with_completed_checks);
    compare(where, "unique_safe_transactions", new Set(rs.map((x) => x.safeTxHash)).size, row.unique_safe_transactions);
  }
}

async function compareResults(r: Result) {
  const rec = await recount(boundOf(r)!);
  for (const row of r.rows) {
    const d = String(row.day).slice(0, 10);
    const rs = rec.requests.filter((x) => x.covered && day(x.proposedAt) === d);
    const count = (s: string) => rs.filter((x) => statusOf(x).status === s).length;
    const where = `results_daily ${d}`;
    compare(where, "secure_unanimous", count("secure_unanimous"), row.secure_unanimous);
    compare(where, "insecure_unanimous", count("insecure_unanimous"), row.insecure_unanimous);
    compare(where, "disputed", count("disputed"), row.disputed);
    compare(where, "timed_out", count("no_verdict"), row.timed_out);
    compare(where, "pending", count("pending"), row.pending);
    compare(where, "disputed_awaiting_ruling", rs.filter((x) => statusOf(x).ruling === "awaiting").length, row.disputed_awaiting_ruling);
  }
}

async function compareAllocation(r: Result) {
  const rec = await recount(boundOf(r)!);
  const x = feeTotals(rec);
  const item = (name: string) => r.rows.find((row) => row.item === name) ?? {};
  const expect: [string, "accrued_usdc" | "paid_usdc" | "outstanding_usdc", bigint][] = [
    ["Gross fees collected", "accrued_usdc", x.fees],
    ["Gross fees collected", "paid_usdc", x.fee_in],
    ["Refunded to sponsors (no verdict)", "accrued_usdc", x.refunds_from_fee],
    ["Sentinel fee rewards", "accrued_usdc", x.rewards_accrued],
    ["Sentinel fee rewards", "paid_usdc", x.rewards_claimed],
    ["Protocol funds receiver", "accrued_usdc", x.receiver],
    ["Protocol funds receiver", "paid_usdc", x.receiver_out],
    ["Held for undecided requests", "accrued_usdc", x.fee_held],
    ["Refunded to sponsors after arbitration", "accrued_usdc", x.refunds_from_slashes],
    ["All refunds paid", "paid_usdc", x.refund_out],
    ["Deposited by Sentinels", "accrued_usdc", x.bonds_locked],
    ["Deposited by Sentinels", "paid_usdc", x.bond_in],
    ["Returned to Sentinels", "accrued_usdc", x.bonds_returned],
    ["Slashed", "accrued_usdc", x.bonds_slashed],
  ];
  for (const [name, col, value] of expect) compare(`fee_allocation ${name}`, col, usdc(value), item(name)[col]);
  for (const row of r.rows.filter((row) => row.section === "Checks (expected 0)")) compare(`fee_allocation ${row.item}`, "accrued_usdc", 0, row.accrued_usdc);
}

const compared: string[] = [];
if (dune.network_summary) await compareSummary(dune.network_summary), compared.push("network_summary");
if (dune.network_breakdown) await compareBreakdown(dune.network_breakdown), compared.push("network_breakdown");
if (dune.results_daily) await compareResults(dune.results_daily), compared.push("results_daily");
if (dune.fee_allocation) await compareAllocation(dune.fee_allocation), compared.push("fee_allocation");

// ---------------------------------------------------------------------------------------------
// Representative requests for a manual check on safenet-explorer.eth.limo

const pick = (label: string, f: (r: RequestRecord) => boolean) => {
  const r = [...atHead.requests].reverse().find(f);
  return r && {
    path: label,
    status: statusOf(r),
    safe: `${r.chainId}:${r.safe}`,
    safe_tx: safeTxUrl(r.chainId, r.safeTxHash),
    proposal_tx: txUrl(100, r.proposalTx),
    outcome_tx: r.outcome ? txUrl(100, r.outcome.tx) : null,
    attestation_tx: r.attestationTx ? txUrl(100, r.attestationTx) : null,
    votes: r.votes.map((v) => `${v.sentinel}: ${v.approved === null ? "not revealed" : v.approved ? "approve" : "deny"}`),
    fee_usdc: usdc(r.fee),
  };
};
const representative = [
  pick("approved and attested", (r) => statusOf(r).status === "secure_unanimous" && !!r.attestationTx),
  pick("approved, not attested", (r) => statusOf(r).status === "secure_unanimous" && !r.attestationTx),
  pick("denied", (r) => statusOf(r).status === "insecure_unanimous"),
  pick("disputed, ruled secure", (r) => statusOf(r).ruling === "secure"),
  pick("disputed, ruled insecure", (r) => statusOf(r).ruling === "insecure"),
  pick("disputed, awaiting ruling", (r) => statusOf(r).ruling === "awaiting"),
  pick("timed out", (r) => statusOf(r).status === "no_verdict"),
  pick("pending", (r) => statusOf(r).status === "pending"),
].filter(Boolean);

// ---------------------------------------------------------------------------------------------

const statuses = Object.groupBy(atHead.requests, (r) => statusOf(r).status);
const report = {
  generated_at: new Date().toISOString(),
  rpc: new URL(args.rpc!).host,
  finalized_block: head,
  requests: atHead.requests.length,
  statuses: Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k, v?.length])),
  fees_usdc: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, usdc(v)])),
  fee_checks: feeChecks,
  issues,
  dune: key ? { compared, bounds: Object.fromEntries(Object.entries(dune).map(([k, r]) => [k, boundOf(r)])), mismatches } : { skipped: "DUNE_API_KEY not set" },
  representative,
};
await mkdir(dirname(args.out!), { recursive: true });
await writeFile(args.out!, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, representative: representative.length }, null, 2));
if (issues.length || mismatches.length) process.exitCode = 1;
