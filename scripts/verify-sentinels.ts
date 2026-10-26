// Verifies the Sentinels section against chain data, independently of Dune
// (docs/metrics/sentinels.md#verification).
//
//   - Recounts membership, every (request, Sentinel) response state, fee rewards, bonds and slashes
//     from Gnosis Chain RPC logs with the same rules as the SQL (scripts/lib/sentinels.ts), and
//     compares them with the latest Dune results. Each result reports the highest block it read
//     (through_block); the recount stops at exactly that block, and judges open windows at the
//     block Dune judged them (as_of_block of sentinel_overview).
//   - Reconciles the panels with each other over the same population: overview = verdict
//     breakdown = sum of the heatmap days; coverage buckets = valid reveals on decided requests;
//     per-Sentinel fee rewards = the Network & revenue fee allocation.
//   - Checks the contract rules: every claim's bondReturn equals bond minus the slash rule, and
//     every ruled dispute's slashed total equals the slashes of its losers.
//   - Reads balances and the SAFE distributor: each Sentinel's USDC.e balanceOf (available bond
//     token), the distributor's merkleRoot() against the latest published root, and
//     cumulativeClaimed() of every Sentinel.
//   - With --traces, recounts reverted commit and reveal calls with trace_filter (slow).
//   - Lists representative cases with explorer links for a manual check on safenet-explorer.eth.limo.
//
//   node scripts/verify-sentinels.ts [--rpc URL] [--eth-rpc URL] [--state dune/.preview/<track>.json]
//     [--traces] [--out FILE]

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { DuneClient } from "../src/dune.ts";
import { loadKnownSafes } from "../src/known-traffic.ts";
import { safeTxUrl, txUrl } from "../src/links.ts";
import { loadParticipants } from "../src/participants.ts";
import { EVENTS, FEE_TOKEN, ORACLE_FUNCTIONS, PRODUCTION, REWARDS_DISTRIBUTOR, SAFE_TOKEN } from "../src/safenet.ts";
import { loadSentinelRewards } from "../src/sentinel-rewards.ts";
import { loadState } from "../src/state.ts";
import { buildRequests, day, fetchSafenetLogs, rpcClient, status, upTo, usdc } from "./lib/recount.ts";
import { buildResponses, buildTerms, currentStatus, requestWindowClosed, sentinelTotals, type Response } from "./lib/sentinels.ts";

const { values: args } = parseArgs({
  options: {
    rpc: { type: "string", default: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com" },
    "eth-rpc": { type: "string", default: process.env.ETHEREUM_RPC_URL || "https://ethereum-rpc.publicnode.com" },
    state: { type: "string" },
    traces: { type: "boolean", default: false },
    out: { type: "string", default: "verification/sentinels.local.json" },
  },
});

const rpc = rpcClient(args.rpc!);
const eth = rpcClient(args["eth-rpc"]!);
const mismatches: Record<string, unknown>[] = [];
const issues: string[] = [];
const near = (a: number, b: number) => Math.abs(a - b) < 5e-7;
const compare = (where: string, column: string, rpcValue: number | null, duneValue: unknown) => {
  const d = duneValue === null || duneValue === undefined ? null : Number(duneValue);
  if (rpcValue === null || d === null ? rpcValue !== d : !near(rpcValue, d)) mismatches.push({ where, column, rpc: rpcValue, dune: d });
};
const addressOf = (row: Record<string, unknown>) => String(row.address ?? "").toLowerCase();
const call = (to: string, data: string, block: number | "latest", client = rpc) =>
  client.call<string>("eth_call", [{ to, data }, typeof block === "number" ? `0x${block.toString(16)}` : block]);
const addressArg = (a: string) => a.slice(2).padStart(64, "0");

// ---------------------------------------------------------------------------------------------
// Dune results (optional)

const QUERIES = [
  "sentinel_overview",
  "sentinel_windows",
  "sentinel_participation_daily",
  "sentinel_verdicts",
  "sentinel_coverage",
  "sentinel_disputes",
  "sentinel_earnings",
  "sentinel_bonds",
  "fee_allocation",
] as const;
type Result = Awaited<ReturnType<DuneClient["latestResults"]>>;
const dune: Partial<Record<(typeof QUERIES)[number], Result>> = {};
const key = process.env.DUNE_API_KEY;
const state = await loadState(args.state);
if (key) {
  const client = new DuneClient(key);
  for (const q of QUERIES) {
    const id = state.queries[q]?.id;
    if (id) dune[q] = await client.latestResults(id);
  }
}
const boundOf = (r?: Result) => (r?.rows.length ? Math.max(...r.rows.map((x) => Number(x.through_block ?? 0))) : undefined);

// ---------------------------------------------------------------------------------------------
// Chain

const head = await rpc.finalized();
const bounds = Object.values(dune).map(boundOf).filter((b): b is number => !!b);
const allLogs = await fetchSafenetLogs(rpc, Math.max(head, ...bounds));
const operational = new Set((await loadKnownSafes()).filter((s) => s.category === "operational").map((s) => `${s.chain_id}:${s.address}`));
const labels = new Map((await loadParticipants()).participants.filter((p) => p.role === "sentinel").map((p) => [p.address, p.label]));
const nameOf = (a: string) => labels.get(a) ?? a;

// Reverted commit and reveal calls (optional; public trace_filter is limited to 100 blocks per call)

type Reverted = { sentinel: string; requestId: string; call: "commit" | "reveal"; block: number; tx: string };
let reverted: Reverted[] | undefined;
if (args.traces) {
  reverted = [];
  const calls = new Map<string, "commit" | "reveal">([
    [ORACLE_FUNCTIONS.commit.selector, "commit"],
    [ORACLE_FUNCTIONS.reveal.selector, "reveal"],
  ]);
  const to = Math.max(head, ...bounds);
  const ranges: [number, number][] = [];
  for (let s = PRODUCTION.sentinelOracle.deployBlock; s <= to; s += 100) ranges.push([s, Math.min(s + 99, to)]);
  let next = 0;
  type Trace = { error?: string; blockNumber: number; transactionHash: string; action: { from: string; input?: string } };
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < ranges.length) {
        const [a, b] = ranges[next++];
        const traces = await rpc.call<Trace[]>("trace_filter", [
          { fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}`, toAddress: [PRODUCTION.sentinelOracle.address] },
        ]);
        for (const t of traces) {
          const call = calls.get((t.action.input ?? "").slice(0, 10));
          if (t.error && call)
            reverted!.push({ sentinel: t.action.from.toLowerCase(), requestId: `0x${t.action.input!.slice(10, 74)}`, call, block: t.blockNumber, tx: t.transactionHash });
        }
      }
    }),
  );
}
const revertedCommitsUpTo = (block: number) =>
  reverted && new Set(reverted.filter((x) => x.call === "commit" && x.block <= block).map((x) => `${x.requestId}:${x.sentinel}`));

async function recount(block: number, asOfBlock = block) {
  const logs = upTo(allLogs, block);
  const { requests, issues } = await buildRequests(rpc, logs, operational);
  const terms = buildTerms(logs.oracleLogs);
  return { requests, terms, issues, responses: buildResponses(requests, terms, asOfBlock, revertedCommitsUpTo(block)), asOfBlock };
}
type Recount = Awaited<ReturnType<typeof recount>>;
const sentinelsOf = (rec: Recount) => [...new Set(rec.terms.map((t) => t.sentinel))].sort();

const atHead = await recount(head);
issues.push(...atHead.issues);

// ---------------------------------------------------------------------------------------------
// Contract-rule checks (independent of Dune)

for (const x of atHead.responses)
  if (x.claimed && x.bond - x.bondReturned !== x.slashDue)
    issues.push(`claim of ${x.sentinel} on ${x.request.requestId}: bondReturn ${x.bondReturned} is not bond ${x.bond} minus slash ${x.slashDue}`);
for (const r of atHead.requests.filter((r) => r.outcome?.event === "DisputeResolved")) {
  const due = atHead.responses.filter((x) => x.request === r && x.slashReason === "dispute_lost").reduce((s, x) => s + x.slashDue, 0n);
  if (due !== r.outcome!.slashed) issues.push(`dispute ${r.requestId}: DisputeResolved.slashed ${r.outcome!.slashed} but losers' slashes ${due}`);
}
for (const x of atHead.responses)
  if (x.committed && !x.eligible) issues.push(`${x.sentinel} committed on ${x.request.requestId} while not a member`);

// ---------------------------------------------------------------------------------------------
// Balances and SAFE rewards at the finalized head / latest Ethereum block

const sentinels = sentinelsOf(atHead);
const balances: Record<string, number> = {};
for (const s of sentinels) balances[s] = usdc(BigInt(await call(FEE_TOKEN.address, `0x70a08231${addressArg(s)}`, head)));

// sentinel_bonds reads Sentinel USDC.e transfers from the oracle's deployment on. That gives the
// balance only if no Sentinel held USDC.e before: check transfers since then against balanceOf.
for (const s of sentinels) {
  const topic = `0x${addressArg(s)}`;
  const [inbound, outbound] = await Promise.all([
    rpc.getLogs(FEE_TOKEN.address, [EVENTS.Transfer.topic0, null, topic], PRODUCTION.sentinelOracle.deployBlock, head),
    rpc.getLogs(FEE_TOKEN.address, [EVENTS.Transfer.topic0, topic], PRODUCTION.sentinelOracle.deployBlock, head),
  ]);
  const net = inbound.reduce((x, l) => x + BigInt(l.data), 0n) - outbound.reduce((x, l) => x + BigInt(l.data), 0n);
  if (!near(usdc(net), balances[s])) issues.push(`${nameOf(s)}: USDC.e transfers since deployment ${usdc(net)} but balanceOf ${balances[s]}`);
}

const published = await loadSentinelRewards();
const latestRoot = published.roots.at(-1)?.merkle_root;
const onchainRoot = (await call(REWARDS_DISTRIBUTOR.address, "0x2eb4a7ab", "latest", eth)).toLowerCase();
if (latestRoot !== onchainRoot) issues.push(`distributor root ${onchainRoot} is not the latest published root ${latestRoot}`);
const safeClaimed: Record<string, number> = {};
for (const s of sentinels)
  safeClaimed[s] = Number(BigInt(await call(REWARDS_DISTRIBUTOR.address, `0xa9919576${addressArg(s)}`, "latest", eth))) / 10 ** SAFE_TOKEN.decimals;
const safePublished: Record<string, number | null> = Object.fromEntries(
  sentinels.map((s) => {
    const e = published.entries.find((x) => x.address === s && x.merkle_root === latestRoot);
    return [s, e ? Number(BigInt(e.cumulative_amount)) / 10 ** SAFE_TOKEN.decimals : null];
  }),
);

// ---------------------------------------------------------------------------------------------
// Comparison with Dune, each result at its own through_block

const asOfOf = (r?: Result) => (r?.rows.length ? Math.max(...r.rows.map((x) => Number(x.as_of_block ?? 0))) : undefined);
const overviewAsOf = asOfOf(dune.sentinel_overview);
const recountFor = async (r: Result) => recount(boundOf(r)!, overviewAsOf ?? boundOf(r)!);

async function compareOverview(r: Result) {
  const rec = await recountFor(r);
  for (const s of sentinelsOf(rec)) {
    const row = r.rows.find((x) => addressOf(x) === s) ?? {};
    const t = sentinelTotals(rec.responses, s);
    const where = `sentinel_overview ${nameOf(s)}`;
    for (const c of ["eligible_requests", "commits", "valid_reveals", "secure", "insecure", "missing_responses", "pending"] as const)
      compare(where, c, t[c], row[c]);
    compareNoCommit(where, t, row.no_commit, row.reverted_commit);
    if (reverted) compare(where, "reverted_calls", reverted.filter((x) => x.sentinel === s && x.block <= boundOf(r)!).length, row.reverted_calls);
    compare(where, "participation_rate", t.participation_rate, row.participation_rate);
    const status = currentStatus(rec.terms, s, rec.asOfBlock);
    const label = { active: "Active", scheduled: "Scheduled (not yet active)", removed: "Removed" }[status!];
    if (row.current_status !== label) mismatches.push({ where, column: "current_status", rpc: label, dune: row.current_status });
  }
  if (r.rows.length !== sentinelsOf(rec).length) mismatches.push({ where: "sentinel_overview", column: "rows", rpc: sentinelsOf(rec).length, dune: r.rows.length });
}

async function compareVerdicts(r: Result) {
  const rec = await recountFor(r);
  for (const s of sentinelsOf(rec)) {
    const row = r.rows.find((x) => addressOf(x) === s);
    const t = sentinelTotals(rec.responses, s);
    const where = `sentinel_verdicts ${nameOf(s)}`;
    if (!row) {
      if (t.secure + t.insecure + t.missing_responses + t.no_commit > 0) mismatches.push({ where, column: "row", rpc: "present", dune: "missing" });
      continue;
    }
    compare(where, "secure_all", t.secure, row.secure_all);
    compare(where, "insecure_all", t.insecure, row.insecure_all);
    compare(where, "missing_all", t.missing_responses, row.missing_all);
    compareNoCommit(where, t, row.no_commit_all, row.reverted_commit_all);
  }
}

async function compareDaily(r: Result) {
  const rec = await recountFor(r);
  for (const row of r.rows) {
    const d = String(row.day).slice(0, 10);
    const s = addressOf(row);
    const xs = rec.responses.filter((x) => x.sentinel === s && x.request.covered && x.eligible && x.windowClosed && day(x.request.proposedAt) === d);
    const where = `sentinel_participation_daily ${d} ${nameOf(s)}`;
    compare(where, "eligible_requests", xs.length, row.eligible_requests);
    compare(where, "valid_reveals", xs.filter((x) => x.valid).length, row.valid_reveals);
  }
}

async function compareWindows(r: Result) {
  const rec = await recountFor(r);
  for (const s of sentinelsOf(rec)) {
    const row = r.rows.find((x) => addressOf(x) === s);
    const t = sentinelTotals(rec.responses, s);
    if (!row) continue;
    compare(`sentinel_windows ${nameOf(s)}`, "eligible_all", t.eligible_requests, row.eligible_all);
    compare(`sentinel_windows ${nameOf(s)}`, "rate_all", t.participation_rate, row.rate_all);
  }
}

async function compareCoverage(r: Result) {
  const rec = await recountFor(r);
  const decided = rec.requests.filter((x) => x.covered && requestWindowClosed(x, rec.asOfBlock));
  const reveals = (x: (typeof decided)[number]) => x.votes.filter((v) => v.approved !== null).length;
  for (const row of r.rows) {
    const b = Number(row.valid_responses);
    compare(`sentinel_coverage ${b}`, "requests_all", decided.filter((x) => reveals(x) === b).length, row.requests_all);
  }
  compare("sentinel_coverage", "pending_requests", rec.requests.filter((x) => x.covered && !requestWindowClosed(x, rec.asOfBlock)).length, r.rows[0]?.pending_requests);
  const max = Math.max(0, ...decided.map(reveals));
  for (let b = 0; b <= max; b++) if (!r.rows.some((row) => Number(row.valid_responses) === b)) mismatches.push({ where: `sentinel_coverage ${b}`, column: "bucket", rpc: "present", dune: "missing" });
}

async function compareDisputes(r: Result) {
  const rec = await recountFor(r);
  const disputed = rec.requests.filter((x) => x.disputed);
  compare("sentinel_disputes", "rows", disputed.length, r.rows.length);
  for (const q of disputed) {
    const row = r.rows.find((x) => String(x.request_id).toLowerCase() === q.requestId);
    const where = `sentinel_disputes ${q.requestId.slice(0, 10)}`;
    if (!row) {
      mismatches.push({ where, column: "row", rpc: "present", dune: "missing" });
      continue;
    }
    const { ruling } = status(q);
    const expected = { secure: "Secure", insecure: "Insecure", none: null, awaiting: null, null: null }[String(ruling) as "secure"];
    if ((row.ruling ?? null) !== expected) mismatches.push({ where, column: "ruling", rpc: expected, dune: row.ruling });
    compare(where, "secure_votes", q.votes.filter((v) => v.approved === true).length, row.secure_votes);
    compare(where, "insecure_votes", q.votes.filter((v) => v.approved === false).length, row.insecure_votes);
    compare(where, "slashed_usdc", usdc(q.outcome?.slashed ?? 0n), row.slashed_usdc);
  }
}

async function compareEarnings(r: Result) {
  const rec = await recountFor(r);
  for (const s of sentinelsOf(rec)) {
    const row = r.rows.find((x) => addressOf(x) === s) ?? {};
    const t = sentinelTotals(rec.responses, s);
    const where = `sentinel_earnings ${nameOf(s)}`;
    compare(where, "fee_accrued_usdc", usdc(t.fee_accrued), row.fee_accrued_usdc);
    compare(where, "fee_claimed_usdc", usdc(t.fee_claimed), row.fee_claimed_usdc);
    compare(where, "fee_outstanding_usdc", usdc(t.fee_accrued - t.fee_claimed), row.fee_outstanding_usdc);
    compare(where, "safe_claimed", safeClaimed[s] ?? 0, row.safe_claimed);
    if (safePublished[s] === null && !String(row.safe_published ?? "").startsWith("No allocation published"))
      mismatches.push({ where, column: "safe_published", rpc: "none published", dune: row.safe_published });
  }
  // The same per-Sentinel fee rewards as the Network & revenue fee allocation.
  const alloc = dune.fee_allocation;
  if (alloc && boundOf(alloc) === boundOf(r))
    for (const row of r.rows) {
      const a = alloc.rows.find((x) => x.section === "Sentinel fee rewards" && String(x.recipient ?? "").toLowerCase().includes(addressOf(row)));
      if (a) {
        compare(`fee_allocation vs sentinel_earnings ${row.name}`, "accrued", Number(a.accrued_usdc), row.fee_accrued_usdc);
        compare(`fee_allocation vs sentinel_earnings ${row.name}`, "paid", Number(a.paid_usdc), row.fee_claimed_usdc);
      }
    }
}

async function compareBonds(r: Result) {
  const rec = await recountFor(r);
  const block = boundOf(r)!;
  for (const s of sentinelsOf(rec)) {
    const row = r.rows.find((x) => addressOf(x) === s) ?? {};
    const t = sentinelTotals(rec.responses, s);
    const where = `sentinel_bonds ${nameOf(s)}`;
    compare(where, "available_usdc", usdc(BigInt(await call(FEE_TOKEN.address, `0x70a08231${addressArg(s)}`, block))), row.available_usdc);
    compare(where, "locked_usdc", usdc(t.locked), row.locked_usdc);
    compare(where, "posted_usdc", usdc(t.posted), row.posted_usdc);
    compare(where, "returned_usdc", usdc(t.returned), row.returned_usdc);
    compare(where, "slashed_confirmed_usdc", usdc(t.slashed_confirmed), row.slashed_confirmed_usdc);
    compare(where, "slashed_unclaimed_usdc", usdc(t.slashed_unclaimed), row.slashed_unclaimed_usdc);
    compare(where, "slash_rule_mismatches", 0, row.slash_rule_mismatches);
  }
}

// Panels against each other, in the same execution population.
function reconcile() {
  const o = dune.sentinel_overview;
  const v = dune.sentinel_verdicts;
  if (o && v && boundOf(o) === boundOf(v))
    for (const row of o.rows) {
      const vr = v.rows.find((x) => addressOf(x) === addressOf(row));
      const total = vr ? ["secure_all", "insecure_all", "missing_all", "reverted_commit_all", "no_commit_all"].reduce((s, c) => s + Number(vr[c] ?? 0), 0) : 0;
      compare(`overview vs verdicts ${row.name}`, "eligible = secure + insecure + missing + reverted + no commit", Number(row.eligible_requests), total);
      compare(`overview vs verdicts ${row.name}`, "valid reveals = secure + insecure", Number(row.valid_reveals), Number(vr?.secure_all ?? 0) + Number(vr?.insecure_all ?? 0));
    }
  const w = dune.sentinel_windows;
  if (o && w && boundOf(o) === boundOf(w))
    for (const row of o.rows) {
      const wr = w.rows.find((x) => addressOf(x) === addressOf(row));
      if (wr) compare(`overview vs windows ${row.name}`, "eligible all time", Number(row.eligible_requests), Number(wr.eligible_all));
    }
}

// Without traces, a reverted commit cannot be told from no commit: compare their sum.
function compareNoCommit(where: string, t: ReturnType<typeof sentinelTotals>, noCommit: unknown, revertedCommit: unknown) {
  if (reverted) {
    compare(where, "no_commit", t.no_commit, noCommit);
    compare(where, "reverted_commit", t.reverted_commit, revertedCommit);
  } else compare(where, "no_commit + reverted_commit", t.no_commit, Number(noCommit ?? 0) + Number(revertedCommit ?? 0));
}

const compared: string[] = [];
const run = async (q: (typeof QUERIES)[number], f: (r: Result) => Promise<void>) => {
  if (dune[q]?.rows.length) await f(dune[q]!), compared.push(q);
};
await run("sentinel_overview", compareOverview);
await run("sentinel_verdicts", compareVerdicts);
await run("sentinel_participation_daily", compareDaily);
await run("sentinel_windows", compareWindows);
await run("sentinel_coverage", compareCoverage);
await run("sentinel_disputes", compareDisputes);
await run("sentinel_earnings", compareEarnings);
await run("sentinel_bonds", compareBonds);
reconcile();

// ---------------------------------------------------------------------------------------------
// Representative cases for a manual check on safenet-explorer.eth.limo

const deadlines = new Map(atHead.requests.map((r) => [r.requestId, r]));
const lateCommit = (x: Reverted) => x.block > (deadlines.get(x.requestId)?.commitDeadline ?? Infinity);

const caseOf = (label: string, f: (x: Response) => boolean) => {
  const x = [...atHead.responses].reverse().find(f);
  return (
    x && {
      case: label,
      sentinel: nameOf(x.sentinel),
      state: x.state,
      request_status: status(x.request),
      safe_tx: safeTxUrl(x.request.chainId, x.request.safeTxHash),
      proposal_tx: txUrl(100, x.request.proposalTx),
      outcome_tx: x.request.outcome ? txUrl(100, x.request.outcome.tx) : null,
      votes: x.request.votes.map((v) => `${nameOf(v.sentinel)}: ${v.approved === null ? "committed, not revealed" : v.approved ? "secure" : "insecure"}${v.reason ? ` (${v.reason})` : ""}`),
    }
  );
};
const firstActive = atHead.terms.map((t) => t.activeFromBlock).sort((a, b) => a - b)[0];
const representative = [
  caseOf("secure vote", (x) => x.state === "secure"),
  caseOf("insecure vote", (x) => x.state === "insecure"),
  caseOf("no commit (abstain or offline)", (x) => x.state === "no_commit"),
  caseOf("commit reverted (late or invalid)", (x) => x.state === "reverted_commit"),
  caseOf("missing response", (x) => x.state === "missing_response"),
  caseOf("pending", (x) => x.state.startsWith("pending")),
  caseOf("disputed, ruled secure", (x) => status(x.request).ruling === "secure"),
  caseOf("disputed, ruled insecure", (x) => status(x.request).ruling === "insecure"),
  caseOf("disputed, out of scope or timed out", (x) => status(x.request).ruling === "none"),
  caseOf("disputed, awaiting ruling", (x) => status(x.request).ruling === "awaiting"),
].filter(Boolean);

// ---------------------------------------------------------------------------------------------

const report = {
  generated_at: new Date().toISOString(),
  rpc: new URL(args.rpc!).host,
  finalized_block: head,
  membership: atHead.terms.map((t) => ({
    sentinel: nameOf(t.sentinel),
    address: t.sentinel,
    scheduled_block: t.scheduledBlock,
    active_from_block: t.activeFromBlock,
    removed_block: t.removedBlock,
    status_now: currentStatus(atHead.terms, t.sentinel, head),
  })),
  first_active_block: firstActive,
  first_request_block: Math.min(...atHead.requests.map((r) => r.proposedBlock)),
  requests: atHead.requests.length,
  open_response_windows: atHead.requests.filter((r) => !requestWindowClosed(r, head)).length,
  sentinels: Object.fromEntries(
    sentinels.map((s) => {
      const t = sentinelTotals(atHead.responses, s);
      return [
        nameOf(s),
        {
          ...t,
          fee_accrued: usdc(t.fee_accrued),
          fee_claimed: usdc(t.fee_claimed),
          posted: usdc(t.posted),
          locked: usdc(t.locked),
          returned: usdc(t.returned),
          slashed_confirmed: usdc(t.slashed_confirmed),
          slashed_unclaimed: usdc(t.slashed_unclaimed),
          available_usdc: balances[s],
          safe_published: safePublished[s],
          safe_claimed: safeClaimed[s],
          reverted_calls: reverted?.filter((x) => x.sentinel === s).length,
          reverted_commits_late: reverted?.filter((x) => x.sentinel === s && x.call === "commit" && lateCommit(x)).length,
        },
      ];
    }),
  ),
  coverage: Object.fromEntries(
    Object.entries(
      Object.groupBy(
        atHead.requests.filter((r) => r.covered && requestWindowClosed(r, head)),
        (r) => String(r.votes.filter((v) => v.approved !== null).length),
      ),
    ).map(([k, v]) => [k, v?.length]),
  ),
  safe_rewards: {
    distributor: REWARDS_DISTRIBUTOR.address,
    onchain_root: onchainRoot,
    latest_published_root: latestRoot,
    published_source: `${published.source}@${published.ref}`,
    sentinel_entries: published.entries.length,
  },
  issues,
  dune: key ? { compared, bounds: Object.fromEntries(Object.entries(dune).map(([k, r]) => [k, boundOf(r)])), as_of_block: overviewAsOf, mismatches } : { skipped: "DUNE_API_KEY not set" },
  representative,
};
await mkdir(dirname(args.out!), { recursive: true });
await writeFile(args.out!, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, representative: representative.length }, null, 2));
if (issues.length || mismatches.length) process.exitCode = 1;
