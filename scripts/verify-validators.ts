// Verifies the Validators section against Gnosis Chain and Ethereum, independently of Dune
// (docs/metrics/validators.md#validation).
//
//   - Membership: rebuilds epochs, groups and members from logs (scripts/lib/validators.ts) and checks
//     them against contract state at the same block: Consensus.getActiveEpoch, getEpochGroupId for
//     every epoch, FROSTCoordinator.participantKey for every (group, validator) pair (reverts for
//     non-members) and groupSignCount per group.
//   - Participation: recounts recognised signature shares per ceremony and compares every
//     validator-day and the production-wide window with the latest Dune results at their block.
//   - Stake: the Validators stake columns equal the Staking section's results from the same refresh,
//     and the stake-status rows add up to the headline; outstanding withdrawals per validator equal
//     the Staking replay (scripts/lib/staking.ts).
//   - Rewards: published roots (dune/data/validator-rewards.json) against the distributor's
//     on-chain root updates and claims; Dune reward rows against the published amounts.
//   - Lists representative cases (membership change, a missed signature, an epoch-rollover
//     ceremony) with gnosisscan links.
//
//   node scripts/verify-validators.ts [--rpc URL] [--eth-rpc URL] [--state dune/.preview/<track>.json] [--out FILE]

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { DuneClient } from "../src/dune.ts";
import { txUrl } from "../src/links.ts";
import { loadParticipants } from "../src/participants.ts";
import { EVENTS, FROST_COORDINATOR, PRODUCTION, REWARDS_DISTRIBUTOR, VALIDATOR_EVENTS } from "../src/safenet.ts";
import { loadState } from "../src/state.ts";
import { loadValidatorRewards } from "../src/validator-rewards.ts";
import { multicall } from "./lib/multicall.ts";
import { rpcClient } from "./lib/recount.ts";
import { DEFAULT_ETH_RPC, fetchStakingEvents, replay, safe, withdrawalStatus } from "./lib/staking.ts";
import { build, fetchValidatorLogs, participation } from "./lib/validators.ts";

const { values: args } = parseArgs({
  options: {
    rpc: { type: "string", default: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com" },
    "eth-rpc": { type: "string", default: process.env.ETHEREUM_RPC_URL || DEFAULT_ETH_RPC },
    state: { type: "string" },
    out: { type: "string", default: "verification/validators.local.json" },
  },
});

const gnosis = rpcClient(args.rpc!);
const eth = rpcClient(args["eth-rpc"]!);
const issues: string[] = [];
const mismatches: Record<string, unknown>[] = [];
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
const compare = (where: string, column: string, mine: number | string | null, dune: unknown) => {
  const ok =
    mine === null ? dune === null || dune === undefined : typeof mine === "number" ? near(mine, Number(dune ?? 0)) : String(mine) === String(dune ?? "");
  if (!ok) mismatches.push({ where, column, rpc: mine, dune });
};
const names = new Map((await loadParticipants()).participants.filter((p) => p.role === "validator").map((p) => [p.address, p.label]));
const nameOf = (a: string) => names.get(a) ?? a;

// ---------------------------------------------------------------------------------------------
// Dune results (optional)

type Result = Awaited<ReturnType<DuneClient["latestResults"]>>;
const QUERIES = [
  "validator_overview",
  "validator_participation_daily",
  "validator_participation_windows",
  "validator_stake_status",
  "validator_withdrawal_exposure",
  "validator_rewards_periods",
  "validator_rewards_by_staker",
  "staking_by_validator",
  "staking_overview",
] as const;
const dune: Partial<Record<(typeof QUERIES)[number], Result>> = {};
const key = process.env.DUNE_API_KEY;
const state = await loadState(args.state);
if (key) {
  const client = new DuneClient(key);
  for (const q of QUERIES) {
    const id = state.queries[q]?.id;
    if (id) dune[q] = await client.latestResults(id, 2000).catch(() => undefined);
  }
}
const duneBlock = dune.validator_overview?.rows.length ? Number(dune.validator_overview.rows[0].through_block) : undefined;

// ---------------------------------------------------------------------------------------------
// Membership at block B, against contract state

const B = await gnosis.finalized();
const logs = await fetchValidatorLogs(gnosis, Math.max(B, duneBlock ?? 0));
const times = new Map<number, number>();
for (const l of [...logs.consensus, ...logs.coordinator]) if (l.blockTimestamp) times.set(Number(l.blockNumber), Number(l.blockTimestamp));
const atB = build(logs, B);
const active = atB.activeAt(B)!;

const membershipChecks: Record<string, unknown>[] = [];
const [activeRead] = await multicall(gnosis, [{ to: PRODUCTION.consensus.address, signature: "getActiveEpoch()", args: [] }], B);
const chainActive = { epoch: Number(BigInt(`0x${activeRead.words[0]}`)), groupId: `0x${activeRead.words[1]}` };
membershipChecks.push({ check: "active epoch and group", contract: chainActive, rebuilt: { epoch: active.epoch, groupId: active.groupId }, ok: chainActive.epoch === active.epoch && chainActive.groupId === active.groupId });

const groupReads = await multicall(
  gnosis,
  atB.epochs.map((e) => ({ to: PRODUCTION.consensus.address, signature: "getEpochGroupId(uint64)", args: [e.epoch.toString(16)] })),
  B,
);
const groupMismatch = atB.epochs.filter((e, i) => `0x${groupReads[i].words[0]}` !== e.groupId).map((e) => e.epoch);
membershipChecks.push({ check: `getEpochGroupId for ${atB.epochs.length} epochs`, mismatches: groupMismatch, ok: groupMismatch.length === 0 });

const candidates = [...new Set([...names.keys(), ...atB.memberships.map((m) => m.validator)])].sort();
const groupIds = [...new Set(atB.epochs.map((e) => e.groupId))];
const pairs = groupIds.flatMap((g) => candidates.map((v) => ({ g, v })));
const keyReads = await multicall(gnosis, pairs.map(({ g, v }) => ({ to: FROST_COORDINATOR.address, signature: "participantKey(bytes32,address)", args: [g, v] })), B);
const memberMismatch = pairs.filter(({ g, v }, i) => keyReads[i].success !== (atB.members.get(g)?.has(v) ?? false)).map(({ g, v }) => `${g.slice(0, 10)}:${nameOf(v)}`);
membershipChecks.push({ check: `participantKey for ${groupIds.length} groups x ${candidates.length} validators`, mismatches: memberMismatch, ok: memberMismatch.length === 0 });

const countReads = await multicall(gnosis, groupIds.map((g) => ({ to: FROST_COORDINATOR.address, signature: "groupSignCount(bytes32)", args: [g] })), B);
// groupSignCount counts every sign() on the group. Anyone may call it, so ceremonies not initiated by
// production Consensus exist; they are not attestations and are excluded from participation.
const signs = logs.coordinator.filter((l) => l.topics[0] === VALIDATOR_EVENTS.Sign.topic0 && Number(l.blockNumber) <= B);
const countMismatch = groupIds.flatMap((g, i) => {
  const chain = Number(BigInt(`0x${countReads[i].words[0]}`));
  const all = signs.filter((l) => l.topics[2] === g).length;
  return chain === all ? [] : [{ group: g, epoch: atB.epochs.find((e) => e.groupId === g)?.epoch, contract: chain, logs: all }];
});
membershipChecks.push({ check: "groupSignCount = Sign events per group (any initiator)", mismatches: countMismatch, ok: countMismatch.length === 0 });
const excluded = signs
  .filter((l) => atB.members.has(l.topics[2]) && l.topics[1] !== `0x${"0".repeat(24)}${PRODUCTION.consensus.address.slice(2)}`)
  .map((l) => ({ initiator: nameOf(`0x${l.topics[1].slice(26)}`), epoch: atB.epochs.find((e) => e.groupId === l.topics[2])?.epoch, tx: txUrl(100, l.transactionHash) }));
for (const c of membershipChecks) if (!c.ok) issues.push(`membership check failed: ${c.check}`);

// ---------------------------------------------------------------------------------------------
// Participation vs Dune, at Dune's block

const compared: string[] = [];
if (duneBlock) {
  const atDune = build(logs, duneBlock);
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const daily = dune.validator_participation_daily;
  if (daily) {
    const mine = new Map<string, { eligible: number; signed: number }>();
    for (const c of atDune.ceremonies) {
      if (c.completedBlock === null) continue;
      const d = day(times.get(c.completedBlock)!);
      for (const [m, share] of c.shares) {
        const k = `${d}|${m}`;
        const s = mine.get(k) ?? { eligible: 0, signed: 0 };
        s.eligible++;
        if (share) s.signed++;
        mine.set(k, s);
      }
    }
    for (const r of daily.rows) {
      const k = `${String(r.day).slice(0, 10)}|${r.address}`;
      compare(`participation ${k}`, "eligible", mine.get(k)?.eligible ?? 0, r.eligible_ceremonies);
      compare(`participation ${k}`, "signed", mine.get(k)?.signed ?? 0, r.signed);
    }
    compared.push("validator_participation_daily");
  }
  const prod = dune.validator_participation_windows?.rows.filter((r) => String(r.time_window).startsWith("Production"));
  if (prod?.length) {
    const p = participation(atDune, times, Date.parse("2026-10-07T13:51:55Z") / 1000);
    for (const r of prod) {
      const s = p.byValidator.get(String(r.address));
      compare(`window production ${r.validator}`, "eligible", s?.eligible ?? 0, r.eligible);
      compare(`window production ${r.validator}`, "signed", s?.signed ?? 0, r.signed);
      compare(`window production ${r.validator}`, "transactions", p.transactions, r.transactions);
    }
    compared.push("validator_participation_windows (production)");
  }
  const o = dune.validator_overview?.rows;
  if (o) {
    const now = atDune.activeAt(duneBlock)!;
    for (const r of o) {
      const a = String(r.validator_address);
      const member = atDune.members.get(now.groupId)?.has(a) ?? false;
      const duneSays = String(r.attestation_set).startsWith("Member") ? String(r.attestation_set) : "not a member";
      compare(`overview ${r.name}`, "attestation_set", member ? `Member (epoch ${now.epoch})` : "not a member", duneSays);
      const signedEver = atDune.ceremonies.some((c) => c.shares.get(a));
      compare(`overview ${r.name}`, "has a last signature share", signedEver ? "yes" : "no", r.last_signature_share ? "yes" : "no");
    }
    compared.push("validator_overview (membership)");
  }
}

// ---------------------------------------------------------------------------------------------
// Stake: same numbers as the Staking section; stake status adds up; exposure = replay

if (dune.validator_overview && dune.staking_by_validator) {
  const staking = new Map(dune.staking_by_validator.rows.map((r) => [String(r.validator_address), r]));
  for (const r of dune.validator_overview.rows) {
    const s = staking.get(String(r.validator_address));
    compare(`stake ${r.name}`, "total_stake (= Staking section)", Number(s?.total_stake ?? 0), r.total_stake);
    if (s && r.self_stake !== null) compare(`stake ${r.name}`, "self_stake (= Staking section)", Number(s.self_stake_any_status ?? 0), r.self_stake);
  }
  compared.push("validator_overview (stake) vs staking_by_validator");
}
if (dune.validator_stake_status && dune.staking_overview) {
  const total = dune.validator_stake_status.rows.find((r) => Number(r.sort_order) === 9);
  const parts = dune.validator_stake_status.rows.filter((r) => Number(r.sort_order) !== 9).reduce((a, r) => a + Number(r.stake), 0);
  compare("stake status", "rows add up to the total", Number(total?.stake ?? 0), parts);
  compare("stake status", "total = Staking headline", Number(dune.staking_overview.rows[0].active_stake), total?.stake);
  compared.push("validator_stake_status");
}
let stakingBlock: number | undefined;
if (dune.validator_withdrawal_exposure && dune.staking_overview) {
  stakingBlock = Number(dune.staking_overview.rows[0].through_block);
  const now = Date.parse(dune.validator_withdrawal_exposure.execution_ended_at ?? new Date().toISOString()) / 1000;
  const s = replay((await fetchStakingEvents(eth, stakingBlock)).filter((e) => e.block <= stakingBlock!), now);
  const per = new Map<string, { waiting: bigint; claimable: bigint }>();
  for (const w of s.withdrawals.values()) {
    const st = withdrawalStatus(w, now);
    if (st === "completed") continue;
    const x = per.get(w.validator) ?? { waiting: 0n, claimable: 0n };
    x[st] += w.amount;
    per.set(w.validator, x);
  }
  for (const r of dune.validator_withdrawal_exposure.rows) {
    const x = per.get(String(r.validator_address));
    compare(`exposure ${r.validator_label}`, "outstanding", safe((x?.waiting ?? 0n) + (x?.claimable ?? 0n)), r.outstanding);
  }
  compare("exposure", "validators with outstanding withdrawals", per.size, dune.validator_withdrawal_exposure.rows.length);
  compared.push("validator_withdrawal_exposure");
}

// ---------------------------------------------------------------------------------------------
// Rewards: published roots vs the distributor on Ethereum; Dune vs published

const rewards = await loadValidatorRewards();
const rewardChecks: Record<string, unknown>[] = [];
const latestCheck = BigInt(rewards.latest_check.sum_cumulative) + BigInt(rewards.latest_check.sum_kyc) === BigInt(rewards.latest_check.token_total);
rewardChecks.push({ check: `latest root: ${rewards.latest_check.addresses} proofs add up to tokenTotal`, ok: latestCheck });
const totals = rewards.roots.map((r) => BigInt(r.token_total));
rewardChecks.push({ check: "tokenTotal never decreases", ok: totals.every((t, i) => i === 0 || t >= totals[i - 1]) });
const ethHead = Number((await eth.call<{ number: string }>("eth_getBlockByNumber", ["latest", false])).number);
const distributorLogs = await eth.getLogs(REWARDS_DISTRIBUTOR.address, [[EVENTS.MerkelRootUpdated.topic0, EVENTS.RewardsClaimed.topic0]], REWARDS_DISTRIBUTOR.deployBlock, ethHead, 250_000);
const onChainRoots = new Set(distributorLogs.filter((l) => l.topics[0] === EVENTS.MerkelRootUpdated.topic0).map((l) => `0x${l.data.slice(66, 130)}`));
const lastRoots = [...new Map(rewards.roots.map((r) => [r.rewards_until, r])).values()];
const missing = lastRoots.filter((r) => !onChainRoots.has(r.merkle_root)).map((r) => r.rewards_until.slice(0, 10));
rewardChecks.push({ check: `final root of each of ${lastRoots.length} periods set on chain`, missing, ok: missing.length === 0 });
const claimed = new Map<string, bigint>();
for (const l of distributorLogs.filter((x) => x.topics[0] === EVENTS.RewardsClaimed.topic0)) {
  const a = `0x${l.topics[1].slice(26)}`;
  claimed.set(a, (claimed.get(a) ?? 0n) + BigInt(l.data.slice(0, 66)));
}
const latestRoot = rewards.roots.at(-1)!.merkle_root;
for (const e of rewards.entries.filter((x) => x.merkle_root === latestRoot)) {
  const c = claimed.get(e.address) ?? 0n;
  if (c > BigInt(e.cumulative_amount)) issues.push(`${e.address} claimed more than its published cumulative amount`);
}
for (const c of rewardChecks) if (!c.ok) issues.push(`rewards check failed: ${c.check}`);
if (dune.validator_rewards_by_staker) {
  for (const r of dune.validator_rewards_by_staker.rows) {
    const a = String(r.staker_address);
    const e = rewards.entries.find((x) => x.merkle_root === latestRoot && x.address === a);
    compare(`rewards ${a}`, "allocated", e ? safe(BigInt(e.cumulative_amount) + BigInt(e.kyc_amount)) : 0, r.allocated);
    compare(`rewards ${a}`, "claimed", safe(claimed.get(a) ?? 0n), r.claimed);
  }
  compared.push("validator_rewards_by_staker");
}
if (dune.validator_rewards_periods) {
  const published = dune.validator_rewards_periods.rows.filter((r) => r.status === "published");
  compare("rewards periods", "published periods", lastRoots.length, published.length);
  let previous = 0n;
  for (const root of lastRoots) {
    const r = published.find((x) => String(x.period_end).slice(0, 10) === root.rewards_until.slice(0, 10));
    compare(`rewards period ${root.rewards_until.slice(0, 10)}`, "total_allocated", safe(BigInt(root.token_total) - previous), r?.total_allocated);
    previous = BigInt(root.token_total);
  }
  compared.push("validator_rewards_periods");
}

// ---------------------------------------------------------------------------------------------
// Representative cases

const representative: Record<string, unknown>[] = [];
const byEpoch = atB.epochs;
for (const v of candidates) {
  const epochs = byEpoch.filter((e) => atB.members.get(e.groupId)?.has(v));
  if (!epochs.length) continue;
  const lastIdx = byEpoch.indexOf(epochs.at(-1)!);
  if (lastIdx < byEpoch.length - 1)
    representative.push({
      case: "left the attestation set",
      validator: nameOf(v),
      last_member_epoch: byEpoch[lastIdx].epoch,
      first_epoch_without: byEpoch[lastIdx + 1].epoch,
      from_block: byEpoch[lastIdx + 1].activeFrom,
    });
}
const missed = atB.ceremonies.filter((c) => c.completedBlock !== null && [...c.shares.values()].some((s) => s === null));
for (const c of missed.slice(-3))
  representative.push({
    case: "completed ceremony a member did not sign",
    epoch: c.epoch,
    purpose: c.purpose,
    did_not_sign: [...c.shares].filter(([, s]) => !s).map(([m]) => nameOf(m)),
    signed: [...c.shares].filter(([, s]) => s).map(([m]) => nameOf(m)),
    completed: txUrl(100, c.completedTx!),
  });
const rollover = atB.ceremonies.filter((c) => c.purpose === "epoch_rollover" && c.completedTx).at(-1);
if (rollover) representative.push({ case: "epoch rollover ceremony", epoch: rollover.epoch, signed: [...rollover.shares].filter(([, s]) => s).map(([m]) => nameOf(m)), completed: txUrl(100, rollover.completedTx!) });
const unrecognised = atB.ceremonies.filter((c) => c.unrecognised.length);
representative.push({ case: "ceremonies on production groups not initiated by Consensus (excluded)", ceremonies: excluded });
representative.push({ case: "shares under another selection root (ignored)", count: unrecognised.reduce((a, c) => a + c.unrecognised.length, 0) });

// ---------------------------------------------------------------------------------------------

const prodAll = participation(atB, times, Date.parse("2026-10-07T13:51:55Z") / 1000);
const report = {
  generated_at: new Date().toISOString(),
  rpc: new URL(args.rpc!).host,
  block: B,
  active_epoch: active.epoch,
  attestation_set: [...(atB.members.get(active.groupId) ?? [])].map(nameOf),
  epochs: atB.epochs.length,
  ceremonies: { total: atB.ceremonies.length, completed: atB.ceremonies.filter((c) => c.completedBlock !== null).length },
  participation_production: Object.fromEntries([...prodAll.byValidator].map(([v, s]) => [nameOf(v), `${s.signed}/${s.eligible}`])),
  membership_checks: membershipChecks,
  reward_checks: rewardChecks,
  issues,
  dune: key ? { compared, through_block: duneBlock ?? null, staking_block: stakingBlock ?? null, mismatches } : { skipped: "DUNE_API_KEY not set" },
  representative,
};
await mkdir(dirname(args.out!), { recursive: true });
await writeFile(args.out!, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, representative: representative.length }, null, 2));
if (issues.length || mismatches.length) process.exitCode = 1;
