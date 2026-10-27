// Verifies the Staking section against Ethereum and Gnosis Chain RPC, independently of Dune
// (docs/metrics/staking.md#validation).
//
//   - Replays every Staking contract event from RPC logs with the contract's rules
//     (scripts/lib/staking.ts) and checks the result against the contract's own state, read at the
//     same block: totalStakedAmount, totalPendingWithdrawals, withdrawal count, withdraw delay,
//     every validator's totalValidatorStakes and registration, every (staker, validator) stake,
//     and every outstanding withdrawal with its claimableAt (getPendingWithdrawals). The contract's
//     SAFE balance must equal staked + pending.
//   - Checks each validator's registered staker against Consensus.getValidatorStaker on Gnosis Chain.
//   - Compares the latest Dune results (with DUNE_API_KEY) with the replay truncated at the block the
//     Dune results report (through_block): counters, every day, the all-time flows, the outstanding
//     withdrawals and the stake by validator, whose rows must add up to the headline.
//   - Lists representative transactions with their receipts and Etherscan links.
//
//   node scripts/verify-staking.ts [--eth-rpc URL] [--rpc URL] [--state dune/.preview/<track>.json] [--out FILE]

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { DuneClient } from "../src/dune.ts";
import { addressUrl, txUrl } from "../src/links.ts";
import { PRODUCTION, SAFE_TOKEN, STAKING, VALIDATOR_STAKER_SET } from "../src/safenet.ts";
import { loadState } from "../src/state.ts";
import { rpcClient, topicAddress, word } from "./lib/recount.ts";
import { DEFAULT_ETH_RPC, type StakingEvent, fetchStakingEvents, replay, safe, withdrawalStatus } from "./lib/staking.ts";

const { values: args } = parseArgs({
  options: {
    "eth-rpc": { type: "string", default: process.env.ETHEREUM_RPC_URL || DEFAULT_ETH_RPC },
    rpc: { type: "string", default: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com" },
    state: { type: "string" },
    out: { type: "string", default: "verification/staking.local.json" },
  },
});

const eth = rpcClient(args["eth-rpc"]!);
const gnosis = rpcClient(args.rpc!);
const issues: string[] = [];
const mismatches: Record<string, unknown>[] = [];
// Dune amounts are doubles in SAFE; replay amounts are exact. Relative tolerance for the conversion.
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const compare = (where: string, column: string, replayValue: number | string, duneValue: unknown) => {
  const ok =
    typeof replayValue === "number" ? near(replayValue, Number(duneValue ?? 0)) : String(replayValue) === String(duneValue ?? "");
  if (!ok) mismatches.push({ where, column, replay: replayValue, dune: duneValue });
};
const duneTime = (v: unknown) => Date.parse(String(v).replace(" UTC", "Z").replace(" ", "T")) / 1000;

// ---------------------------------------------------------------------------------------------
// Contract reads

const selector = (signature: string) => bytesToHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 8);
const pad = (address: string) => address.toLowerCase().slice(2).padStart(64, "0");
const hexBlock = (n: number) => `0x${n.toString(16)}`;
const ethCall = (to: string, signature: string, argsHex: string[], block: number) =>
  eth.call<string>("eth_call", [{ to, data: `0x${selector(signature)}${argsHex.join("")}` }, hexBlock(block)]);
const read = async (signature: string, argsHex: string[], block: number) => word(await ethCall(STAKING.address, signature, argsHex, block), 0);

// Many single-word reads of the Staking contract at block B, batched through Multicall3
// (aggregate3, deployed at the same address on every chain) so that a public RPC sees a handful of
// requests instead of one per staker and validator. Every call must succeed.
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const hexWord = (n: number) => n.toString(16).padStart(64, "0");
async function readMany(calls: { signature: string; args: string[] }[], block: number, chunk = 250): Promise<bigint[]> {
  const out: bigint[] = [];
  for (let i = 0; i < calls.length; i += chunk) {
    const part = calls.slice(i, i + chunk).map((c) => `${selector(c.signature)}${c.args.join("")}`);
    // aggregate3((address target, bool allowFailure, bytes callData)[]): each tuple is dynamic.
    const tuples = part.map((data) => {
      const len = data.length / 2;
      return `${pad(STAKING.address)}${hexWord(0)}${hexWord(0x60)}${hexWord(len)}${data.padEnd(Math.ceil(len / 32) * 64, "0")}`;
    });
    let offset = 32 * tuples.length;
    const heads = tuples.map((t) => {
      const h = hexWord(offset);
      offset += t.length / 2;
      return h;
    });
    const data = `0x${selector("aggregate3((address,bool,bytes)[])")}${hexWord(0x20)}${hexWord(tuples.length)}${heads.join("")}${tuples.join("")}`;
    const result = await eth.call<string>("eth_call", [{ to: MULTICALL3, data }, hexBlock(block)]);
    // Result[] (bool success, bytes returnData): array offset, length, element offsets, elements.
    const n = Number(word(result, 1));
    for (let j = 0; j < n; j++) {
      const at = 2 + Number(word(result, 2 + j)) / 32; // element start, in words
      if (word(result, at) !== 1n) throw new Error(`multicall: ${calls[i + j].signature} failed`);
      out.push(word(result, at + 3)); // success, bytes offset, bytes length, first data word
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Dune results (optional)

type Result = Awaited<ReturnType<DuneClient["latestResults"]>>;
const DUNE_QUERIES = ["staking_overview", "staking_daily", "staking_flow_summary", "staking_withdrawals_outstanding", "staking_by_validator"] as const;
const dune: Partial<Record<(typeof DUNE_QUERIES)[number], Result>> = {};
const key = process.env.DUNE_API_KEY;
const state = await loadState(args.state);
if (key) {
  const client = new DuneClient(key);
  for (const q of DUNE_QUERIES) {
    const id = state.queries[q]?.id;
    if (id) dune[q] = await client.latestResults(id);
  }
}
const boundOf = (r?: Result) => (r?.rows.length ? Math.max(...r.rows.map((x) => Number(x.through_block ?? 0))) : undefined);
// The block every Dune staking result is compared at: the one their execution reported.
const duneBlock = boundOf(dune.staking_overview) ?? boundOf(dune.staking_daily);

// ---------------------------------------------------------------------------------------------
// Chain: replay up to a pinned block B and read the contract at B

const B = Number((await eth.call<{ number: string }>("eth_getBlockByNumber", ["latest", false])).number);
const bTime = await eth.blockTime({ blockNumber: hexBlock(B) });
const to = Math.max(B, duneBlock ?? 0);
const events = await fetchStakingEvents(eth, to);
const upTo = (block: number) => events.filter((e) => e.block <= block);
const atB = replay(upTo(B), bTime);
issues.push(...atB.issues);

const contract = {
  totalStakedAmount: await read("totalStakedAmount()", [], B),
  totalPendingWithdrawals: await read("totalPendingWithdrawals()", [], B),
  withdrawals: (await read("nextWithdrawalId()", [], B)) - 1n,
  withdrawDelay: await read("withdrawDelay()", [], B),
  safeBalance: word(await ethCall(SAFE_TOKEN.address, "balanceOf(address)", [pad(STAKING.address)], B), 0),
};
const replayTotals = {
  totalStakedAmount: atB.totalStaked,
  totalPendingWithdrawals: atB.totalPending,
  withdrawals: BigInt(atB.withdrawals.size),
  withdrawDelay: atB.delay,
  safeBalance: atB.totalStaked + atB.totalPending,
};
const contractChecks: Record<string, unknown>[] = [];
for (const k of Object.keys(contract) as (keyof typeof contract)[])
  contractChecks.push({ check: k, contract: contract[k].toString(), replay: replayTotals[k].toString(), ok: contract[k] === replayTotals[k] });

// Every validator: stake and registration.
const validators = [...new Set([...atB.registered.keys(), ...atB.validatorTotals.keys()])];
const validatorReads = await readMany(
  validators.flatMap((v) => [
    { signature: "totalValidatorStakes(address)", args: [pad(v)] },
    { signature: "isValidator(address)", args: [pad(v)] },
  ]),
  B,
);
for (const [i, v] of validators.entries()) {
  const total = validatorReads[2 * i];
  const reg = validatorReads[2 * i + 1] !== 0n;
  const ok = total === (atB.validatorTotals.get(v) ?? 0n) && reg === (atB.registered.get(v) ?? false);
  contractChecks.push({ check: `validator ${v}`, contract: { stake: total.toString(), registered: reg }, replay: { stake: (atB.validatorTotals.get(v) ?? 0n).toString(), registered: atB.registered.get(v) ?? false }, ok });
}

// Every (staker, validator) pair that ever staked, including those now at zero.
const pairs = [...new Set(upTo(B).filter((e) => e.event === "deposit").map((e) => `${e.staker}:${e.validator}`))];
const active = new Map(atB.positions.map((p) => [`${p.staker}:${p.validator}`, p.amount]));
const stakeValues = await readMany(
  pairs.map((p) => ({ signature: "stakes(address,address)", args: p.split(":").map(pad) })),
  B,
);
const stakeReads = pairs.map((p, i) => ({ p, chain: stakeValues[i] }));
const pairMismatches = stakeReads.filter((r) => r.chain !== (active.get(r.p) ?? 0n));
contractChecks.push({ check: `stakes(staker, validator) for ${pairs.length} pairs`, mismatches: pairMismatches.length, ok: pairMismatches.length === 0 });

// Every staker with outstanding withdrawals: the contract's queue, amount and claimableAt per entry.
const outstandingAtB = [...atB.withdrawals.values()].filter((w) => w.claimedAt === null);
const queueStakers = [...new Set(outstandingAtB.map((w) => w.staker))];
let queueMismatches = 0;
for (const s of queueStakers) {
  const data = await ethCall(STAKING.address, "getPendingWithdrawals(address)", [pad(s)], B);
  const n = Number(word(data, 1));
  const chain = Array.from({ length: n }, (_, i) => `${word(data, 2 + 2 * i)}@${word(data, 3 + 2 * i)}`).sort();
  const mine = outstandingAtB
    .filter((w) => w.staker === s)
    .map((w) => `${w.amount}@${w.claimableAt}`)
    .sort();
  if (JSON.stringify(chain) !== JSON.stringify(mine)) {
    queueMismatches++;
    issues.push(`withdrawal queue of ${s} differs: contract ${chain.join(", ")}; replay ${mine.join(", ")}`);
  }
}
contractChecks.push({
  check: `getPendingWithdrawals for ${queueStakers.length} stakers (${outstandingAtB.length} withdrawals: amount and claimableAt)`,
  mismatches: queueMismatches,
  ok: queueMismatches === 0,
});
for (const c of contractChecks) if (!c.ok) issues.push(`contract check failed: ${c.check}`);

// Registered stakers on the production Consensus (Gnosis Chain) vs getValidatorStaker.
const stakerLogs = await gnosis.getLogs(PRODUCTION.consensus.address, [VALIDATOR_STAKER_SET.topic0], PRODUCTION.consensus.deployBlock, await gnosis.finalized());
const registeredStakers = new Map<string, { staker: string; tx: string }>();
for (const l of stakerLogs) registeredStakers.set(topicAddress(l.topics[1]), { staker: `0x${l.data.slice(26, 66)}`.toLowerCase(), tx: l.transactionHash });
const stakerChecks = [];
for (const v of validators) {
  const data = await gnosis.call<string>("eth_call", [{ to: PRODUCTION.consensus.address, data: `0x${selector("getValidatorStaker(address)")}${pad(v)}` }, "latest"]);
  const chain = `0x${data.slice(26, 66)}`.toLowerCase();
  const fromLogs = registeredStakers.get(v)?.staker ?? `0x${"0".repeat(40)}`;
  stakerChecks.push({ validator: v, staker: chain, ok: chain === fromLogs });
  if (chain !== fromLogs) issues.push(`registered staker of ${v}: Consensus ${chain}, logs ${fromLogs}`);
}
const stakerOf = (v: string) => {
  const s = registeredStakers.get(v)?.staker;
  return s && s !== `0x${"0".repeat(40)}` ? s : null;
};

// ---------------------------------------------------------------------------------------------
// Comparison with Dune at its own through_block

const compared: string[] = [];
if (duneBlock) {
  const duneTimeOf = (r?: Result) => (r?.execution_ended_at ? Date.parse(r.execution_ended_at) / 1000 : bTime);
  const atDune = replay(upTo(duneBlock), duneTimeOf(dune.staking_overview));

  const o = dune.staking_overview?.rows[0];
  if (o) {
    const now = duneTime(o.computed_at);
    const ws = [...atDune.withdrawals.values()];
    const sum = (f: (w: (typeof ws)[number]) => boolean) => safe(ws.filter(f).reduce((a, w) => a + w.amount, 0n));
    compare("staking_overview", "active_stake", safe(atDune.totalStaked), o.active_stake);
    compare("staking_overview", "active_stakers", atDune.stakerTotals.size, o.active_stakers);
    compare("staking_overview", "outstanding_withdrawals", safe(atDune.totalPending), o.outstanding_withdrawals);
    compare("staking_overview", "waiting_withdrawals", sum((w) => withdrawalStatus(w, now) === "waiting"), o.waiting_withdrawals);
    compare("staking_overview", "claimable_withdrawals", sum((w) => withdrawalStatus(w, now) === "claimable"), o.claimable_withdrawals);
    const deregistered = atDune.positions.filter((p) => atDune.registered.get(p.validator) === false).reduce((a, p) => a + p.amount, 0n);
    compare("staking_overview", "deregistered_stake", safe(deregistered), o.deregistered_stake);
    compare("staking_overview", "inconsistent_withdrawals", 0, o.inconsistent_withdrawals);
    compared.push("staking_overview");
  }

  if (dune.staking_daily) {
    const byDay = new Map(dune.staking_daily.rows.map((r) => [String(r.day).slice(0, 10), r]));
    for (const d of atDune.daily) {
      const r = byDay.get(d.day);
      if (!r) {
        mismatches.push({ where: `staking_daily ${d.day}`, column: "row", replay: "present", dune: "missing" });
        continue;
      }
      compare(`staking_daily ${d.day}`, "deposits", safe(d.deposits), r.deposits);
      compare(`staking_daily ${d.day}`, "withdrawals_requested", safe(d.withdrawals_requested), r.withdrawals_requested);
      compare(`staking_daily ${d.day}`, "withdrawals_completed", safe(d.withdrawals_completed), r.withdrawals_completed);
      compare(`staking_daily ${d.day}`, "active_stake", safe(d.active_stake_eod), r.active_stake);
      compare(`staking_daily ${d.day}`, "outstanding_withdrawals", safe(d.outstanding_eod), r.outstanding_withdrawals);
      compare(`staking_daily ${d.day}`, "net_flow", safe(d.net_flow_cumulative), r.net_flow);
      compare(`staking_daily ${d.day}`, "era", d.era, r.era);
    }
    compared.push("staking_daily");
  }

  const all = dune.staking_flow_summary?.rows.find((r) => String(r.period).startsWith("All time"));
  if (all) {
    const sum = (ev: StakingEvent["event"]) => safe(upTo(duneBlock).filter((e) => e.event === ev).reduce((a, e) => a + e.amount, 0n));
    compare("staking_flow_summary all time", "deposits", sum("deposit"), all.deposits);
    compare("staking_flow_summary all time", "withdrawals_requested", sum("withdrawal_requested"), all.withdrawals_requested);
    compare("staking_flow_summary all time", "withdrawals_completed", sum("withdrawal_claimed"), all.withdrawals_completed);
    compare("staking_flow_summary all time", "net_capital_flow", safe(atDune.netFlow), all.net_capital_flow);
    compare("staking_flow_summary all time", "active_stake_change", safe(atDune.totalStaked), all.active_stake_change);
    compared.push("staking_flow_summary (all time)");
  }

  const out = dune.staking_withdrawals_outstanding;
  if (out) {
    const now = duneTimeOf(out);
    const rows = out.rows.filter((r) => r.withdrawal_id !== null);
    const mine = [...atDune.withdrawals.values()].filter((w) => w.claimedAt === null);
    compare("staking_withdrawals_outstanding", "rows", mine.length, rows.length);
    const byId = new Map(rows.map((r) => [Number(r.withdrawal_id), r]));
    for (const w of mine) {
      const r = byId.get(w.id);
      if (!r) {
        mismatches.push({ where: `withdrawal ${w.id}`, column: "row", replay: "outstanding", dune: "missing" });
        continue;
      }
      compare(`withdrawal ${w.id}`, "amount", safe(w.amount), r.amount);
      compare(`withdrawal ${w.id}`, "earliest_withdrawal", w.claimableAt, duneTime(r.earliest_withdrawal));
      compare(`withdrawal ${w.id}`, "staker", w.staker, r.staker_full);
      compare(`withdrawal ${w.id}`, "validator", w.validator, r.validator_full);
      // Status depends on the execution time; skip withdrawals that turned claimable during it.
      if (Math.abs(w.claimableAt - now) > 600)
        compare(`withdrawal ${w.id}`, "status", withdrawalStatus(w, now) === "claimable" ? "Claimable now" : "Waiting", r.status);
    }
    const sorted = rows.map((r) => duneTime(r.earliest_withdrawal));
    if (sorted.some((t, i) => i > 0 && t < sorted[i - 1])) issues.push("outstanding withdrawals are not sorted by earliest withdrawal");
    compared.push("staking_withdrawals_outstanding");
  }

  const bv = dune.staking_by_validator;
  if (bv) {
    let rowsTotal = 0;
    for (const r of bv.rows) {
      const v = String(r.validator_address);
      rowsTotal += Number(r.total_stake);
      compare(`staking_by_validator ${v}`, "total_stake", safe(atDune.validatorTotals.get(v) ?? 0n), r.total_stake);
      compare(`staking_by_validator ${v}`, "staking_status", atDune.registered.get(v) ? "registered" : "deregistered", r.staking_status);
      const s = stakerOf(v);
      const self = s ? safe(atDune.positions.find((p) => p.staker === s && p.validator === v)?.amount ?? 0n) : null;
      if (self === null) compare(`staking_by_validator ${v}`, "self_stake_any_status", "null", r.self_stake_any_status ?? "null");
      else compare(`staking_by_validator ${v}`, "self_stake_any_status", self, r.self_stake_any_status);
    }
    compare("staking_by_validator", "sum of rows vs headline", safe(atDune.totalStaked), rowsTotal);
    compared.push("staking_by_validator");
  }
}

// ---------------------------------------------------------------------------------------------
// Representative transactions, checked against their receipts

async function receipt(e: StakingEvent) {
  const r = await eth.call<{ status: string; logs: { address: string; topics: string[]; data: string; logIndex: string }[] }>("eth_getTransactionReceipt", [e.tx]);
  const log = r.logs.find((l) => Number(l.logIndex) === e.logIndex && l.address.toLowerCase() === STAKING.address);
  const ok = r.status === "0x1" && !!log && (e.event === "validator_updated" || word(log.data, 0) === e.amount);
  if (!ok) issues.push(`receipt of ${e.tx} does not show the ${e.event} event`);
  return { tx: txUrl(1, e.tx), status: r.status === "0x1" ? "success" : "reverted", log_found: !!log, amount_matches: ok };
}
const ws = [...atB.withdrawals.values()];
const last = <T>(xs: T[]) => xs[xs.length - 1];
const eventOf = (tx: string, ev: StakingEvent["event"]) => events.find((e) => e.tx === tx && e.event === ev)!;
const representative: Record<string, unknown>[] = [];
const lastDeposit = last(events.filter((e) => e.event === "deposit" && e.block <= B));
if (lastDeposit)
  representative.push({ case: "latest deposit", staker: addressUrl(1, lastDeposit.staker!), validator: lastDeposit.validator, amount_safe: safe(lastDeposit.amount), ...(await receipt(lastDeposit)) });
for (const status of ["waiting", "claimable", "completed"] as const) {
  const w = last(ws.filter((x) => withdrawalStatus(x, bTime) === status));
  if (!w) {
    representative.push({ case: `${status} withdrawal`, note: "none at this block" });
    continue;
  }
  representative.push({
    case: `${status} withdrawal`,
    withdrawal_id: w.id,
    staker: addressUrl(1, w.staker),
    validator: w.validator,
    amount_safe: safe(w.amount),
    requested_at: new Date(w.requestedAt * 1000).toISOString(),
    earliest_withdrawal: new Date(w.claimableAt * 1000).toISOString(),
    claimed_at: w.claimedAt ? new Date(w.claimedAt * 1000).toISOString() : null,
    request: await receipt(eventOf(w.requestTx, "withdrawal_requested")),
    claim: w.claimTx ? await receipt(eventOf(w.claimTx, "withdrawal_claimed")) : null,
  });
}
const selfStakes = atB.positions.filter((p) => stakerOf(p.validator) === p.staker).sort((a, b) => (a.amount < b.amount ? 1 : -1));
if (selfStakes[0])
  representative.push({
    case: "largest self-stake",
    validator: selfStakes[0].validator,
    staker: addressUrl(1, selfStakes[0].staker),
    amount_safe: safe(selfStakes[0].amount),
    registered_by: txUrl(100, registeredStakers.get(selfStakes[0].validator)!.tx),
    contract_stakes_at_block: safe(await read("stakes(address,address)", [pad(selfStakes[0].staker), pad(selfStakes[0].validator)], B)),
  });
const dereg = atB.positions.filter((p) => atB.registered.get(p.validator) === false);
if (dereg.length)
  representative.push({
    case: "stake on deregistered validators",
    validators: [...new Set(dereg.map((p) => p.validator))],
    positions: dereg.length,
    amount_safe: safe(dereg.reduce((a, p) => a + p.amount, 0n)),
  });

// ---------------------------------------------------------------------------------------------

const report = {
  generated_at: new Date().toISOString(),
  eth_rpc: new URL(args["eth-rpc"]!).host,
  block: B,
  block_time: new Date(bTime * 1000).toISOString(),
  events: Object.fromEntries(Object.entries(Object.groupBy(upTo(B), (e) => e.event)).map(([k, v]) => [k, v?.length])),
  first_event_block: events[0]?.block,
  totals_safe: {
    active_stake: safe(atB.totalStaked),
    outstanding_withdrawals: safe(atB.totalPending),
    waiting: safe(ws.filter((w) => withdrawalStatus(w, bTime) === "waiting").reduce((a, w) => a + w.amount, 0n)),
    claimable: safe(ws.filter((w) => withdrawalStatus(w, bTime) === "claimable").reduce((a, w) => a + w.amount, 0n)),
    net_capital_flow: safe(atB.netFlow),
    stakers: atB.stakerTotals.size,
    validators_with_stake: atB.validatorTotals.size,
  },
  contract_checks: contractChecks,
  registered_stakers: stakerChecks,
  issues,
  dune: key
    ? { compared, through_block: duneBlock ?? null, bounds: Object.fromEntries(Object.entries(dune).map(([k, r]) => [k, boundOf(r) ?? null])), mismatches }
    : { skipped: "DUNE_API_KEY not set" },
  representative,
};
await mkdir(dirname(args.out!), { recursive: true });
await writeFile(args.out!, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, contract_checks: contractChecks.filter((c) => !c.ok), representative: representative.length }, null, 2));
if (issues.length || mismatches.length) process.exitCode = 1;
