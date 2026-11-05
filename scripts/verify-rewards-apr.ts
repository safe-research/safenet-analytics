// Verifies the realized staking APR (docs/metrics/staking.md#realized-apr) independently of Dune and
// of the reward scripts' own run, then against Dune when DUNE_API_KEY is set.
//
//   1. Published source: the ENS name's current contenthash pins the latest recorded rewards DB; its
//      CAR verifies against the CID; proofs add up to tokenTotal; the distributor's merkleRoot() is
//      its root; every Aegis period root was set on chain; the per-address payouts recomputed from
//      the IPFS DBs equal dune/data/validator-rewards.json exactly; and the programme budget holds:
//      tokenTotal − sentinelTokenTotal − Beta total + unpaid = 5M SAFE × elapsed / 52 weeks.
//   2. Stake: every Staking event replayed from Ethereum logs (scripts/lib/staking.ts), weighted by
//      the exact seconds held (scripts/lib/rewards-apr.ts), with registration and registered-staker
//      intervals. Per verified period: per-validator stake and self-stake = the recorded split's.
//   3. Participation at the settlement block (last Gnosis block at or before the period end + 48),
//      rebuilt from Consensus and FROSTCoordinator logs: a validator is eligible (≥ 75%) exactly where
//      the derived split pays it.
//   4. Rewards: the allocation formula (sqrt-damped weights × participation, src/safenet.ts rewards()
//      of the reward scripts), applied to the replayed stake and participation, gives the per-validator
//      rewards the split derived from the payouts — two independent routes to the same numbers; every address's payout re-derived from them and its replayed stake matches the
//      published payout within rounding (a few base units); eligible stakers are all paid,
//      ineligible-only stakers are not.
//   5. APR from the replay; with DUNE_API_KEY, the latest results of staking_rewards_apr,
//      staking_rewards_apr_by_validator and validator_rewards_periods compared with it.
//   6. Representative cases with explorer links.
//
//   node scripts/verify-rewards-apr.ts [--rpc URL] [--eth-rpc URL] [--gateway URLS] [--state FILE] [--out FILE]

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { DuneClient } from "../src/dune.ts";
import { addressUrl, txUrl } from "../src/links.ts";
import { loadParticipants } from "../src/participants.ts";
import { contenthashHistory, DEFAULT_IPFS_GATEWAYS, fetchRewardsDb, proofTotals } from "../src/rewards-ipfs.ts";
import { EVENTS, PRODUCTION, REWARDS_DISTRIBUTOR, VALIDATOR_STAKER_SET } from "../src/safenet.ts";
import { loadState } from "../src/state.ts";
import { AEGIS_REWARDS_START, loadValidatorRewards, periodEnds, periodPayouts, type ValidatorPeriod } from "../src/validator-rewards.ts";
import { rpcClient, topicAddress } from "./lib/recount.ts";
import { apr, byValidator, completedPeriods, type Period, periodStake, rewardParticipation, type StakerSet } from "./lib/rewards-apr.ts";
import { DEFAULT_ETH_RPC, fetchStakingEvents } from "./lib/staking.ts";
import { build, fetchValidatorLogs } from "./lib/validators.ts";

const { values: args } = parseArgs({
  options: {
    rpc: { type: "string", default: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com" },
    "eth-rpc": { type: "string", default: process.env.ETHEREUM_RPC_URL || DEFAULT_ETH_RPC },
    gateway: { type: "string", default: process.env.IPFS_GATEWAY_URL || DEFAULT_IPFS_GATEWAYS },
    state: { type: "string" },
    out: { type: "string", default: "verification/rewards_apr.local.json" },
  },
});

const gnosis = rpcClient(args.rpc!);
const eth = rpcClient(args["eth-rpc"]!);
const issues: string[] = [];
const checks: { check: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ check: name, ok, ...(detail === undefined ? {} : { detail }) });
  if (!ok) issues.push(name);
};
const mismatches: Record<string, unknown>[] = [];
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
const compare = (where: string, column: string, mine: number | string | boolean | null, dune: unknown) => {
  const ok =
    mine === null
      ? dune === null || dune === undefined
      : typeof mine === "number"
        ? dune !== null && dune !== undefined && near(mine, Number(dune))
        : String(mine) === String(dune);
  if (!ok) mismatches.push({ where, column, rpc: mine, dune });
};
const names = new Map((await loadParticipants()).participants.filter((p) => p.role === "validator").map((p) => [p.address, p.label]));
const nameOf = (a: string) => names.get(a) ?? a;
const safe = (v: bigint) => Number(v) / 1e18;
const iso = (t: number) => new Date(t * 1000).toISOString();
const unix = (s: string) => Date.parse(s) / 1000;

const data = await loadValidatorRewards();
const ethHead = await eth.finalized();
const gnosisHead = await gnosis.finalized();

// ---------------------------------------------------------------------------------------------
// 1. Published source

const ens = await contenthashHistory(eth, { fromBlock: REWARDS_DISTRIBUTOR.deployBlock, toBlock: ethHead });
const proofs = new Map<string, Map<string, { cumulativeAmount: string; kycAmount?: string; sentinelAmount?: string }>>();
for (const h of ens.history) {
  const db = await fetchRewardsDb(h.cid, args.gateway);
  const t = proofTotals(db);
  check(`${h.cid}: ${t.addresses} proofs add up to tokenTotal`, t.cumulative + t.kyc === BigInt(db.index.tokenTotal));
  proofs.set(db.index.merkleRoot.toLowerCase(), db.proofs);
  if (h === ens.history.at(-1)) {
    check("ENS contenthash pins the latest recorded root", db.index.merkleRoot.toLowerCase() === data.roots.at(-1)!.merkle_root, { cid: h.cid, root: db.index.merkleRoot });
  }
}
const onChainRoot = (await eth.call<string>("eth_call", [{ to: REWARDS_DISTRIBUTOR.address, data: "0x2eb4a7ab" }, `0x${ethHead.toString(16)}`])).toLowerCase();
check("distributor merkleRoot() = latest published root", onChainRoot === data.roots.at(-1)!.merkle_root, { block: ethHead, root: onChainRoot });
const rootLogs = await eth.getLogs(REWARDS_DISTRIBUTOR.address, [EVENTS.MerkelRootUpdated.topic0], REWARDS_DISTRIBUTOR.deployBlock, ethHead, 250_000);
const setRoots = new Map(rootLogs.map((l) => [`0x${l.data.slice(66, 130)}`, l]));
const aegis = periodEnds(data.roots).filter((r) => r.rewards_until > AEGIS_REWARDS_START);
for (const r of aegis) check(`${r.rewards_until.slice(0, 10)}: root set on chain`, setRoots.has(r.merkle_root), setRoots.get(r.merkle_root) ? txUrl(1, setRoots.get(r.merkle_root)!.transactionHash) : null);
// Aegis periods (on IPFS); Beta payouts come from the frozen git mirror and are checked by the sync.
const aegisOnly = (u: string) => u > AEGIS_REWARDS_START;
const recomputed = periodPayouts(data.roots, proofs, aegisOnly);
check("Aegis per-address payouts recomputed from IPFS = recorded", JSON.stringify(recomputed) === JSON.stringify((data.payouts ?? []).filter((x) => aegisOnly(x.rewards_until))), { rows: recomputed.length });

const BETA_TOKEN_TOTAL = 4499987774807670271201970n;
const BUDGET = 5_000_000n * 10n ** 18n;
const ends = periodEnds(data.roots);
for (const r of aegis) {
  const elapsed = BigInt(unix(r.rewards_until) - unix(AEGIS_REWARDS_START));
  const lhs = BigInt(r.token_total) - BigInt(r.sentinel_token_total ?? "0") - BETA_TOKEN_TOTAL + BigInt(r.unpaid_amount);
  check(`${r.rewards_until.slice(0, 10)}: tokenTotal − Sentinel − Beta + unpaid = 5M × elapsed / 52 weeks`, lhs === (BUDGET * elapsed) / (52n * 7n * 86400n), { lhs: lhs.toString() });
}

// ---------------------------------------------------------------------------------------------
// 2.–4. Replay per completed period

const events = await fetchStakingEvents(eth, ethHead);
const stakerSets: StakerSet[] = [];
for (const l of await gnosis.getLogs(PRODUCTION.consensus.address, [VALIDATOR_STAKER_SET.topic0], PRODUCTION.consensus.deployBlock, gnosisHead))
  stakerSets.push({ validator: topicAddress(l.topics[1]), staker: `0x${l.data.slice(26, 66)}`.toLowerCase(), time: await gnosis.blockTime(l) });

// The last Gnosis block at or before t (binary search on block timestamps).
const blockAt = async (t: number) => {
  let lo: number = PRODUCTION.consensus.deployBlock;
  let hi = gnosisHead;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((await gnosis.blockTime({ blockNumber: `0x${mid.toString(16)}` })) <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

const periods = completedPeriods(Date.now() / 1000);
const settlements = new Map<number, number>();
for (const p of periods) {
  const b = (await blockAt(p.to)) + 48;
  if (b <= gnosisHead) settlements.set(p.to, b);
}
const lastSettlement = Math.max(0, ...settlements.values());
const vlogs = lastSettlement ? await fetchValidatorLogs(gnosis, lastSettlement) : null;
const state = vlogs ? build(vlogs, lastSettlement) : null;
const times = new Map<number, number>();
if (state) for (const c of state.ceremonies) if (c.completedBlock !== null) times.set(c.completedBlock, await gnosis.blockTime({ blockNumber: `0x${c.completedBlock.toString(16)}` }));

const isqrt = (n: bigint) => {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
};

type PeriodResult = Record<string, unknown>;
const results: PeriodResult[] = [];
const validatorResults: Record<string, unknown>[] = [];
const representative: Record<string, unknown>[] = [];

for (const p of periods) {
  const until = iso(p.to);
  const L = BigInt(p.to - p.from);
  const pairs = periodStake(events, p, stakerSets);
  const perValidator = byValidator(pairs);
  const settlement = settlements.get(p.to);
  const part = state && settlement ? rewardParticipation(state.ceremonies, times, p, settlement) : null;
  const eligible = (v: string) => !!part && part.transactions > 0 && (part.signed.get(v) ?? 0) / part.transactions >= 0.75;
  const root = ends.find((r) => r.rewards_until === until);
  const payouts = new Map((data.payouts ?? []).filter((x) => x.rewards_until === until).map((x) => [x.address, x]));
  const recorded = (data.validator_periods ?? []).filter((v) => v.rewards_until === until);
  const verified = recorded.length > 0;

  let eligibleSeconds = 0n;
  let eligibleDelegated = 0n;
  let allSeconds = 0n;
  for (const v of perValidator.values()) {
    allSeconds += v.all;
    if (eligible(v.validator)) {
      eligibleSeconds += v.registered;
      eligibleDelegated += v.registered - v.self;
    }
  }
  const stakeRewards = [...payouts.values()].reduce((a, x) => a + BigInt(x.payout) - BigInt(x.sentinel), 0n);

  if (verified) {
    const rec = new Map(recorded.map((v) => [v.validator, v]));
    // 2. Stake = the scripts' (they divide each staker slice by the period; allow one unit per staker).
    for (const v of perValidator.values()) {
      const r = rec.get(v.validator);
      if (!r) {
        if (v.registered > 0n) issues.push(`${until.slice(0, 10)} ${nameOf(v.validator)}: stake but no recorded validator row`);
        continue;
      }
      const dStake = v.registered / L - BigInt(r.avg_stake);
      const dSelf = v.self / L - BigInt(r.avg_self_stake);
      const tol = BigInt(v.stakers + 1);
      check(`${until.slice(0, 10)} ${nameOf(v.validator)}: time-weighted stake and self-stake = recorded split`, (dStake < 0n ? -dStake : dStake) <= tol && (dSelf < 0n ? -dSelf : dSelf) <= tol, {
        stake: safe(v.registered / L),
        self: safe(v.self / L),
        diff_base_units: [dStake.toString(), dSelf.toString()],
      });
      // 3. Participation = the scripts'.
      // 3. Participation rebuilt from signing events: eligible exactly where the derived split pays.
      if (part) check(`${until.slice(0, 10)} ${nameOf(v.validator)}: participation ${part.signed.get(v.validator) ?? 0}/${part.transactions} ${eligible(v.validator) ? "≥" : "<"} 75%, as the derived reward says`, eligible(v.validator) === r.eligible && r.eligible === BigInt(r.reward) > 0n);
    }
    // 4. The formula on the replay gives the recorded per-validator rewards.
    const budget = recorded.reduce((a, v) => a + BigInt(v.reward), 0n) + BigInt(root?.unpaid_amount ?? "0");
    const vs = recorded.map((v) => v.validator);
    const total = (v: string) => (perValidator.get(v)?.registered ?? 0n) / L;
    const T = vs.reduce((a, v) => a + total(v), 0n) / BigInt(vs.length);
    const w = new Map<string, bigint>();
    for (const v of vs) {
      if (!part || !eligible(v)) {
        w.set(v, 0n);
        continue;
      }
      const s = total(v) <= T ? total(v) : isqrt(T * total(v));
      w.set(v, (s * BigInt(part.signed.get(v) ?? 0) * 10n ** 18n) / BigInt(part.transactions));
    }
    const W = [...w.values()].reduce((a, b) => a + b, 0n);
    // The period's budget is recorded with the split (the first period: 5M × 2 weeks / 52 weeks).
    const periodBudget = BigInt(data.split_checks!.find((c) => c.rewards_until === until)!.budget);
    for (const v of recorded) {
      const reward = W > 0n ? (periodBudget * w.get(v.validator)!) / W : 0n;
      const d = reward - BigInt(v.reward);
      // Exact if the replayed averages equal the scripts' to the base unit; otherwise off by a tiny amount.
      check(`${until.slice(0, 10)} ${nameOf(v.validator)}: reward from the formula on the replay = recorded`, (d < 0n ? -d : d) <= 10n ** 6n, { replay: safe(reward), recorded: safe(BigInt(v.reward)), diff_base_units: d.toString() });
    }
    // Integer division at the validator and the staker level: payouts + unpaid = budget exactly, and
    // the validator rewards cover the payouts up to rounding dust.
    const paidOut = [...payouts.values()].reduce((a, x) => a + BigInt(x.payout) - BigInt(x.sentinel), 0n);
    const rewardsTotal = budget - BigInt(root?.unpaid_amount ?? "0");
    check(`${until.slice(0, 10)}: staking payouts + unpaid = budget`, paidOut + BigInt(root?.unpaid_amount ?? "0") === periodBudget, { budget: periodBudget.toString(), unpaid: root?.unpaid_amount });
    check(`${until.slice(0, 10)}: validator rewards cover the payouts up to rounding`, rewardsTotal >= paidOut && rewardsTotal - paidOut < 10n ** 6n, { dust_base_units: (rewardsTotal - paidOut).toString() });
    // Per address: payout re-derived from the recorded rewards and the replayed stake.
    const expected = new Map<string, bigint>();
    const add = (a: string, x: bigint) => expected.set(a, (expected.get(a) ?? 0n) + x);
    for (const pr of pairs.values()) {
      const r = rec.get(pr.validator);
      if (!r || BigInt(r.avg_stake) === 0n) continue;
      const amount = pr.registered / L;
      const self = pr.self / L;
      const R = BigInt(r.reward);
      const T = BigInt(r.avg_stake);
      add(pr.staker, (R * self) / T);
      const dr = (R * (amount - self)) / T;
      const c = r.commission_charged ? (dr * 500n) / 10000n : 0n;
      add(pr.staker, dr - c);
      add(r.beneficiary, c);
    }
    let worst = 0n;
    let worstAddress = "";
    let count = 0;
    const unexplained: string[] = [];
    for (const [a, x] of payouts) {
      const stake = BigInt(x.payout) - BigInt(x.sentinel);
      const e = expected.get(a) ?? 0n;
      const d = stake > e ? stake - e : e - stake;
      if (stake > 0n) count++;
      if (stake > 0n && !expected.has(a)) unexplained.push(a);
      if (d > worst) {
        worst = d;
        worstAddress = a;
      }
    }
    for (const [a, e] of expected) if (e > 2n && !payouts.has(a)) unexplained.push(a);
    check(`${until.slice(0, 10)}: every payout (${count} addresses) re-derived from the replay within rounding`, worst <= 100n && unexplained.length === 0, {
      max_diff_base_units: worst.toString(),
      address: worstAddress,
      unexplained,
    });
    // Eligible stakers are paid, ineligible-only stakers are not.
    const paid = (a: string) => BigInt(payouts.get(a)?.payout ?? "0") - BigInt(payouts.get(a)?.sentinel ?? "0") > 0n;
    const byStaker = new Map<string, { elig: bigint; inelig: bigint }>();
    for (const pr of pairs.values()) {
      const s = byStaker.get(pr.staker) ?? { elig: 0n, inelig: 0n };
      if (eligible(pr.validator)) s.elig += pr.registered;
      else s.inelig += pr.all;
      byStaker.set(pr.staker, s);
    }
    const unpaidEligible = [...byStaker].filter(([a, s]) => s.elig / L > 10n ** 12n && !paid(a)).map(([a]) => a);
    const paidIneligible = [...byStaker].filter(([a, s]) => s.elig === 0n && s.inelig > 0n && paid(a) && !recorded.some((v) => v.beneficiary === a)).map(([a]) => a);
    check(`${until.slice(0, 10)}: every staker with eligible stake is paid (none excluded, e.g. sanctioned)`, unpaidEligible.length === 0, unpaidEligible);
    check(`${until.slice(0, 10)}: stakers only on ineligible validators are not paid`, paidIneligible.length === 0, paidIneligible);

    // Representative cases
    if (!representative.length) {
      const inPeriod = events.filter((e) => e.time >= p.from && e.time < p.to);
      const dep = inPeriod.find((e) => e.event === "deposit" && eligible(e.validator!));
      const req = inPeriod.find((e) => e.event === "withdrawal_requested" && eligible(e.validator!));
      for (const [kind, e] of [["deposit during the period", dep], ["withdrawal request during the period", req]] as const)
        if (e)
          representative.push({
            case: kind,
            staker: addressUrl(1, e.staker!),
            validator: nameOf(e.validator!),
            amount: safe(e.amount),
            tx: txUrl(1, e.tx),
            avg_stake_in_period: safe((pairs.get(`${e.staker}:${e.validator}`)?.registered ?? 0n) / L),
            payout: safe(BigInt(payouts.get(e.staker!)?.payout ?? "0")),
          });
      const inelig = [...pairs.values()].find((x) => !eligible(x.validator) && x.all / L > 10n ** 21n && !paid(x.staker));
      if (inelig)
        representative.push({ case: "staker on an ineligible validator: no reward", staker: addressUrl(1, inelig.staker), validator: nameOf(inelig.validator), avg_stake: safe(inelig.all / L), participation: part ? `${part.signed.get(inelig.validator) ?? 0}/${part.transactions}` : null });
      for (const x of [...payouts.values()].filter((y) => BigInt(y.kyc_change ?? "0") > 0n))
        representative.push({ case: "withheld until KYC (counted as allocated)", address: addressUrl(1, x.address), withheld: safe(BigInt(x.kyc_change!)), sentinel_grant: safe(BigInt(x.sentinel)) });
      for (const v of recorded.filter((r) => BigInt(r.commission) > 0n && !stakerSets.some((s) => s.staker === r.beneficiary)))
        representative.push({ case: "commission paid to a DelegateRegistry beneficiary, not the staker", validator: nameOf(v.validator), beneficiary: addressUrl(1, v.beneficiary), commission: safe(BigInt(v.commission)) });
      const zero = events.find((e) => e.event === "withdrawal_requested" && e.time < p.from && ![...pairs.values()].some((x) => x.staker === e.staker));
      if (zero) representative.push({ case: "withdrew everything before the period: zero stake, no reward", staker: addressUrl(1, zero.staker!), tx: txUrl(1, zero.tx), in_payouts: payouts.has(zero.staker!) });
    }
  }

  const delegatorRewards = recorded.reduce((a, v) => a + BigInt(v.delegator_reward), 0n);
  const row = {
    period: `${until.slice(0, 10)}`,
    status: root ? "published" : "not yet published",
    settlement_block: settlement ?? null,
    stake_rewards: root ? safe(stakeRewards) : null,
    eligible_stake: safe(eligibleSeconds / L),
    total_stake: safe(allSeconds / L),
    pool_apr: root ? apr(stakeRewards, eligibleSeconds) : null,
    apr_all_stake: root ? apr(stakeRewards, allSeconds) : null,
    delegator_apr: verified ? apr(delegatorRewards, eligibleDelegated) : null,
    split: verified ? "verified" : root ? "split not verified" : "not published",
  };
  results.push(row);
  for (const v of perValidator.values()) {
    if (v.all === 0n) continue;
    const r = recorded.find((x) => x.validator === v.validator) as ValidatorPeriod | undefined;
    validatorResults.push({
      period: until.slice(0, 10),
      validator: nameOf(v.validator),
      validator_address: v.validator,
      eligible: eligible(v.validator),
      participation: part ? `${part.signed.get(v.validator) ?? 0}/${part.transactions}` : null,
      avg_stake: safe(v.registered / L),
      avg_self_stake: safe(v.self / L),
      gross_apr: r ? apr(BigInt(r.reward), v.registered) : null,
      delegator_apr: r ? apr(BigInt(r.delegator_reward), v.registered - v.self) : null,
      self_stake_apr: r ? apr(BigInt(r.self_reward), v.self) : null,
      commission: r ? safe(BigInt(r.commission)) : null,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// 5. Dune

const key = process.env.DUNE_API_KEY;
const compared: string[] = [];
if (key) {
  const st = await loadState(args.state);
  const client = new DuneClient(key);
  const get = async (q: string) => (st.queries[q]?.id ? await client.latestResults(st.queries[q].id, 2000).catch(() => undefined) : undefined);
  const day = (v: unknown) => String(v).slice(0, 10);
  const a = await get("staking_rewards_apr");
  if (a) {
    for (const r of results) {
      const d = a.rows.find((x) => day(x.period_end) === r.period);
      if (!d) {
        mismatches.push({ where: `apr ${r.period}`, column: "row", rpc: "present", dune: "missing" });
        continue;
      }
      for (const c of ["stake_rewards", "eligible_stake", "total_stake", "pool_apr", "apr_all_stake", "delegator_apr", "status"] as const)
        compare(`apr ${r.period}`, c, r[c] as number | string | null, d[c]);
    }
    compared.push("staking_rewards_apr");
  }
  const b = await get("staking_rewards_apr_by_validator");
  if (b) {
    for (const r of validatorResults) {
      const d = b.rows.find((x) => day(x.period_end) === r.period && String(x.validator_address) === r.validator_address);
      if (!d) {
        mismatches.push({ where: `by validator ${r.period} ${r.validator}`, column: "row", rpc: "present", dune: "missing" });
        continue;
      }
      for (const c of ["avg_stake", "avg_self_stake", "gross_apr", "delegator_apr", "self_stake_apr", "commission", "eligible"] as const)
        compare(`by validator ${r.period} ${r.validator}`, c, r[c] as number | boolean | null, d[c]);
      compare(`by validator ${r.period} ${r.validator}`, "participation", r.participation as string, `${d.signed}/${d.transactions}`);
    }
    compared.push("staking_rewards_apr_by_validator");
  }
  const c = await get("validator_rewards_periods");
  if (c) {
    for (const check of data.split_checks ?? []) {
      const d = c.rows.find((x) => day(x.period_end) === check.rewards_until.slice(0, 10));
      compare(`reward periods ${check.rewards_until.slice(0, 10)}`, "commission", safe(BigInt(check.commission)), d?.commission);
      if (check.rewards_until > AEGIS_REWARDS_START)
        compare(`reward periods ${check.rewards_until.slice(0, 10)}`, "period_start", day(new Date(Date.parse(check.rewards_until) - 14 * 86400_000).toISOString()), day(d?.period_start));
    }
    compared.push("validator_rewards_periods");
  }
}

const report = {
  generated_at: new Date().toISOString(),
  ethereum_block: ethHead,
  gnosis_block: gnosisHead,
  ens: { name: "rewards.safenet-gov.eth", cid: ens.history.at(-1)?.cid ?? null, history: ens.history.map((h) => ({ cid: h.cid, block: h.block, tx: txUrl(1, h.tx) })) },
  periods: results,
  by_validator: validatorResults,
  checks,
  issues,
  dune: key ? { compared, mismatches } : { skipped: "DUNE_API_KEY not set" },
  representative,
};
await mkdir(dirname(args.out!), { recursive: true });
await writeFile(args.out!, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, by_validator: validatorResults.length, representative: representative.length }, null, 2));
if (issues.length || mismatches.length) process.exitCode = 1;
