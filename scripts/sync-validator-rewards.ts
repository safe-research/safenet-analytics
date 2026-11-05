// Fetches the published SAFE staking rewards (src/validator-rewards.ts):
//
//   - Beta: every published version of assets/rewards/latest.json in safe-fndn/safenet-data since
//     the launch reset, up to BETA_REWARDS_REF (the mirror is frozen), with the proof file of each
//     validator staker under each root.
//   - Aegis: every contenthash the ENS name rewards.safenet-gov.eth has pinned on Ethereum
//     (ContenthashChanged on its resolver), each rewards DB fetched from IPFS as one CAR and verified
//     against its CID (src/rewards-ipfs.ts). A root already known from git is not recorded twice.
//
// Checks the latest root against the sum of all its proof files, computes the per-address payouts of
// every Aegis period, derives the commission split of every period that has none yet (or whose
// recorded split no longer reproduces its payouts) from the payouts and chain data
// (scripts/lib/derive-split.ts), and writes dune/data/validator-rewards.json and the generated queries.
//
// Validator stakers are every staker in a ValidatorStakerSet on Beta or production Consensus (Gnosis
// Chain RPC, GNOSIS_RPC_URL or --rpc), plus the commission beneficiaries they named in the
// DelegateRegistry (Ethereum RPC, ETHEREUM_RPC_URL or --eth-rpc).
//
// Incremental: what is already recorded is reused. Only rewards DBs whose CID is not recorded yet are
// downloaded, with the previous period's DB each new period is compared with; a day without a new
// ENS contenthash downloads nothing. A new validator staker or beneficiary, a new --ref or --full
// reads everything again.
//
//   node scripts/sync-validator-rewards.ts [--ref <commit>] [--rpc URL] [--eth-rpc URL] [--gateway URL] [--rederive] [--full]

import { parseArgs } from "node:util";
import { contenthashHistory, DEFAULT_IPFS_GATEWAYS, fetchRewardsDb, proofTotals, REWARDS_ENS_NAME, type RewardsProof } from "../src/rewards-ipfs.ts";
import { BETA_CONSENSUS, DELEGATE_REGISTRY, PRODUCTION, REWARDS_DISTRIBUTOR, VALIDATOR_STAKER_SET } from "../src/safenet.ts";
import {
  AEGIS_REWARDS_START,
  BETA_MIN_PAYOUT,
  BETA_PERIOD_REWARDS,
  BETA_REWARDS_REF,
  BETA_REWARDS_START,
  loadValidatorRewards,
  PERIOD_SECONDS,
  periodBudget,
  periodEnds,
  periodPayouts,
  proofPath,
  REWARDS_INDEX,
  REWARDS_SOURCE,
  type ValidatorRewardData,
  type ValidatorRewardEntry,
  type ValidatorRewardRoot,
  writeValidatorRewards,
} from "../src/validator-rewards.ts";
import { rpcClient, topicAddress } from "./lib/recount.ts";
import { deriveSplit } from "./lib/derive-split.ts";
import { periodStake, type StakerSet } from "./lib/rewards-apr.ts";
import { DEFAULT_ETH_RPC, fetchStakingEvents } from "./lib/staking.ts";

const { values } = parseArgs({
  options: {
    ref: { type: "string", default: BETA_REWARDS_REF },
    rpc: { type: "string", default: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com" },
    "eth-rpc": { type: "string", default: process.env.ETHEREUM_RPC_URL || DEFAULT_ETH_RPC },
    gateway: { type: "string", default: process.env.IPFS_GATEWAY_URL || DEFAULT_IPFS_GATEWAYS },
    rederive: { type: "boolean", default: false }, // derive every Aegis period's split again
    full: { type: "boolean", default: false }, // read every source again instead of only what is new
  },
});

async function get(url: string, { allow404 = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
    if (allow404 && res.status === 404) return undefined;
    if (res.ok) return res.json();
    if (attempt >= 4) throw new Error(`${url}: ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}
const raw = (ref: string, path: string, allow404 = false) =>
  get(`https://raw.githubusercontent.com/${REWARDS_SOURCE}/${ref}/${path}`, { allow404 });
const ref = values.ref!;

const previous = await loadValidatorRewards().catch(() => undefined);

// Validator stakers, Beta and production, and the commission beneficiaries they named.
const rpc = rpcClient(values.rpc!);
const head = await rpc.finalized();
const stakers: ValidatorRewardData["stakers"] = [];
const stakerSets: StakerSet[] = []; // production, with times, for self-stake and beneficiaries
const betaStakerSets: StakerSet[] = []; // Beta Consensus, for the Beta periods
for (const [era, c] of [["beta", BETA_CONSENSUS], ["production", PRODUCTION.consensus]] as const)
  for (const l of await rpc.getLogs(c.address, [VALIDATOR_STAKER_SET.topic0], c.deployBlock, head)) {
    const s = { validator: topicAddress(l.topics[1]), staker: `0x${l.data.slice(26, 66)}`.toLowerCase() };
    stakers.push({ ...s, era });
    (era === "production" ? stakerSets : betaStakerSets).push({ ...s, time: await rpc.blockTime(l) });
  }

// Commission beneficiaries: DelegateRegistry delegates named by validator stakers.
const eth = rpcClient(values["eth-rpc"]!);
const ethHead = await eth.finalized();
const R = DELEGATE_REGISTRY;
const delegations: { staker: string; delegate: string | null; time: number }[] = [];
for (const l of await eth.getLogs(R.address, [[R.events.SetDelegate.topic0, R.events.ClearDelegate.topic0], null, R.commissionId], R.fromBlock, ethHead, 500_000))
  delegations.push({ staker: topicAddress(l.topics[1]), delegate: l.topics[0] === R.events.SetDelegate.topic0 ? topicAddress(l.topics[3]) : null, time: await eth.blockTime(l) });
const addresses = [...new Set([...stakers.map((s) => s.staker), ...delegations.flatMap((d) => (d.delegate ? [d.delegate] : []))])].sort();

const proofs = new Map<string, Map<string, RewardsProof>>(); // full proofs by merkle root
const reuse =
  !!previous && !values.full && previous.ref === ref && JSON.stringify(previous.addresses ?? null) === JSON.stringify(addresses);
const roots: ValidatorRewardRoot[] = reuse ? structuredClone(previous!.roots) : [];
const entries: ValidatorRewardEntry[] = reuse ? [...previous!.entries] : [];
const kindOf = (rewardsUntil: string) => (roots.at(-1)?.rewards_until === rewardsUntil ? "reissue" : "period");

// ---------------------------------------------------------------------------------------------
// Beta: safenet-data git history up to ref (frozen; read again only without a reusable record).
if (!reuse) {

type Commit = { sha: string; commit: { committer: { date: string } } };
const commits: Commit[] = [];
for (let page = 1; ; page++) {
  const batch = (await get(
    `https://api.github.com/repos/${REWARDS_SOURCE}/commits?sha=${ref}&path=${REWARDS_INDEX}&per_page=100&page=${page}`,
  )) as Commit[];
  commits.push(...batch);
  if (batch.length < 100) break;
}
commits.reverse();

type Index = { merkleRoot?: string; rewardsUntil?: string; tokenTotal?: string; sentinelTokenTotal?: string; unpaidAmount?: string };
const indexes: { c: Commit; index: Index }[] = [];
for (const c of commits) indexes.push({ c, index: (await raw(c.sha, REWARDS_INDEX)) as Index });
// Launch reset: the last published index with tokenTotal 0. Everything before is test data.
const start = indexes.findLastIndex(({ index }) => index.tokenTotal === "0");
if (start < 0) throw new Error("no launch reset (tokenTotal 0) found in the rewards index history");

for (const { c, index } of indexes.slice(start + 1)) {
  const root = index.merkleRoot?.toLowerCase();
  if (!root || !index.rewardsUntil || roots.some((r) => r.merkle_root === root)) continue;
  roots.push({
    commit: c.sha,
    published_at: c.commit.committer.date,
    rewards_until: index.rewardsUntil,
    merkle_root: root,
    kind: kindOf(index.rewardsUntil),
    token_total: index.tokenTotal ?? "0",
    sentinel_token_total: index.sentinelTokenTotal ?? null,
    unpaid_amount: index.unpaidAmount ?? "0",
    source: "git",
    cid: null,
    ens_block: null,
  });
  for (const address of addresses) {
    const proof = (await raw(c.sha, proofPath(address), true)) as
      | { cumulativeAmount: string; kycAmount?: string; sentinelAmount?: string; merkleRoot: string }
      | undefined;
    if (!proof) continue;
    if (proof.merkleRoot.toLowerCase() !== root) throw new Error(`${c.sha} ${address}: proof root ${proof.merkleRoot} is not ${root}`);
    entries.push({
      address,
      merkle_root: root,
      cumulative_amount: proof.cumulativeAmount,
      kyc_amount: proof.kycAmount ?? "0",
      sentinel_amount: proof.sentinelAmount ?? null,
    });
  }
}
}

// Every proof of each Beta period's last root, for the Beta payouts and their split (read once: the
// mirror is frozen, and the result is reused).
if (!reuse) {
  for (const r of periodEnds(roots)) {
    const tree = (await get(`https://api.github.com/repos/${REWARDS_SOURCE}/git/trees/${r.commit}?recursive=1`)) as { tree: { path: string; type: string }[]; truncated: boolean };
    if (tree.truncated) throw new Error(`rewards tree listing truncated at ${r.commit}`);
    const files = tree.tree.filter((t) => t.type === "blob" && /^assets\/rewards\/proofs\/.*\.json$/.test(t.path)).map((t) => t.path);
    const m = new Map<string, RewardsProof>();
    for (let i = 0; i < files.length; i += 24)
      await Promise.all(
        files.slice(i, i + 24).map(async (f) => {
          const p = (await raw(r.commit, f)) as RewardsProof;
          if (p.merkleRoot.toLowerCase() !== r.merkle_root) throw new Error(`${r.commit} ${f}: proof under another root`);
          m.set(f.split("/").pop()!.replace(".json", "").toLowerCase(), p);
        }),
      );
    const sum = [...m.values()].reduce((a, p) => a + BigInt(p.cumulativeAmount) + BigInt(p.kycAmount ?? "0"), 0n);
    if (sum !== BigInt(r.token_total)) throw new Error(`${r.rewards_until}: Beta proofs add up to ${sum}, not tokenTotal ${r.token_total}`);
    proofs.set(r.merkle_root, m);
  }
}

// ---------------------------------------------------------------------------------------------
// Aegis: ENS contenthash history, rewards DBs from IPFS.

const ens = await contenthashHistory(eth, { fromBlock: REWARDS_DISTRIBUTOR.deployBlock, toBlock: ethHead });
const load = async (cid: string) => {
  const db = await fetchRewardsDb(cid, values.gateway);
  const t = proofTotals(db);
  if (t.cumulative + t.kyc !== BigInt(db.index.tokenTotal))
    throw new Error(`${cid}: proofs add up to ${t.cumulative + t.kyc}, not tokenTotal ${db.index.tokenTotal}`);
  proofs.set(db.index.merkleRoot.toLowerCase(), db.proofs);
  return db;
};
let downloaded = 0;
for (const h of ens.history) {
  if (roots.some((r) => r.cid === h.cid)) continue; // recorded already (reuse)
  const db = await load(h.cid);
  downloaded++;
  const root = db.index.merkleRoot.toLowerCase();
  const known = roots.find((r) => r.merkle_root === root);
  if (known) {
    // Same DB as mirrored in git: the published amounts must be the same.
    if (known.token_total !== db.index.tokenTotal) throw new Error(`${h.cid}: tokenTotal differs from git for ${root}`);
    known.cid = h.cid;
    known.ens_block = h.block;
    continue;
  }
  if (roots.length && db.index.rewardsUntil < roots.at(-1)!.rewards_until) throw new Error(`${h.cid}: rewardsUntil goes back`);
  roots.push({
    commit: h.tx,
    published_at: new Date(h.time * 1000).toISOString(),
    rewards_until: db.index.rewardsUntil,
    merkle_root: root,
    kind: kindOf(db.index.rewardsUntil),
    token_total: db.index.tokenTotal,
    sentinel_token_total: db.index.sentinelTokenTotal ?? null,
    unpaid_amount: db.index.unpaidAmount ?? "0",
    source: "ipfs",
    cid: h.cid,
    ens_block: h.block,
  });
  for (const address of addresses) {
    const p = db.proofs.get(address);
    if (!p) continue;
    entries.push({
      address,
      merkle_root: root,
      cumulative_amount: p.cumulativeAmount,
      kyc_amount: p.kycAmount ?? "0",
      sentinel_amount: p.sentinelAmount ?? null,
    });
  }
}

// A period whose last root is new is compared with the previous period's last root: load that too.
const ends0 = periodEnds(roots);
for (let i = 1; i < ends0.length; i++) {
  if (ends0[i].rewards_until <= AEGIS_REWARDS_START || !proofs.has(ends0[i].merkle_root) || proofs.has(ends0[i - 1].merkle_root)) continue;
  const cid = ends0[i - 1].cid;
  if (!cid) throw new Error(`${ends0[i - 1].rewards_until}: the previous rewards DB is not pinned by ENS; run with --full`);
  await load(cid);
  downloaded++;
}

// On-chain root: the latest DB must be the one the distributor uses (resolvePreviousRewardsDb in the
// reward scripts requires the same). A newer ENS DB whose root is not set yet is reported.
const onChainRoot = (await eth.call<string>("eth_call", [{ to: REWARDS_DISTRIBUTOR.address, data: "0x2eb4a7ab" }, `0x${ethHead.toString(16)}`])).toLowerCase();

// Latest root: every proof file, summed (IPFS: already checked above; git: the tree).
const latest = roots.at(-1)!;
let latestCheck: ValidatorRewardData["latest_check"];
if (reuse && !proofs.has(latest.merkle_root) && previous!.latest_check.merkle_root === latest.merkle_root) {
  latestCheck = previous!.latest_check;
} else if (proofs.has(latest.merkle_root)) {
  const t = proofTotals({ cid: latest.cid!, index: { merkleRoot: latest.merkle_root, rewardsUntil: latest.rewards_until, tokenTotal: latest.token_total }, proofs: proofs.get(latest.merkle_root)! });
  latestCheck = { merkle_root: latest.merkle_root, addresses: t.addresses, sum_cumulative: t.cumulative.toString(), sum_kyc: t.kyc.toString(), token_total: latest.token_total };
} else {
  const tree = (await get(`https://api.github.com/repos/${REWARDS_SOURCE}/git/trees/${latest.commit}?recursive=1`)) as { tree: { path: string; type: string }[]; truncated: boolean };
  if (tree.truncated) throw new Error("rewards tree listing truncated");
  const files = tree.tree.filter((t) => t.type === "blob" && /^assets\/rewards\/proofs\/.*\.json$/.test(t.path)).map((t) => t.path);
  let c = 0n;
  let k = 0n;
  for (let i = 0; i < files.length; i += 16)
    for (const p of (await Promise.all(files.slice(i, i + 16).map((f) => raw(latest.commit, f)))) as RewardsProof[]) {
      c += BigInt(p.cumulativeAmount);
      k += BigInt(p.kycAmount ?? "0");
    }
  latestCheck = { merkle_root: latest.merkle_root, addresses: files.length, sum_cumulative: c.toString(), sum_kyc: k.toString(), token_total: latest.token_total };
}

// Payouts of the periods whose DBs were loaded; earlier ones as recorded.
const endsNow = periodEnds(roots);
const loaded = (until: string) => {
  const i = endsNow.findIndex((r) => r.rewards_until === until);
  return proofs.has(endsNow[i].merkle_root) && (i === 0 || proofs.has(endsNow[i - 1].merkle_root));
};
const fresh = periodPayouts(roots, proofs, loaded);
const freshPeriods = new Set(fresh.map((x) => x.rewards_until));
const payouts = [...(reuse ? (previous!.payouts ?? []).filter((x) => !freshPeriods.has(x.rewards_until)) : []), ...fresh].sort((a, b) =>
  a.rewards_until === b.rewards_until ? (a.address < b.address ? -1 : 1) : a.rewards_until < b.rewards_until ? -1 : 1,
);

// ---------------------------------------------------------------------------------------------
// Commission split, derived from the payouts and chain data (no reward scripts).

const splits = previous?.splits ?? [];
const validatorPeriods = previous?.validator_periods ?? [];
const splitChecks = previous?.split_checks ?? [];
const ends = periodEnds(roots);
const stillMatches = (until: string) => {
  const s = new Map(splits.filter((x) => x.rewards_until === until).map((x) => [x.address, x]));
  const p = payouts.filter((x) => BigInt(x.payout) > 0n && x.rewards_until === until);
  return p.length > 0 && p.length === s.size && p.every((x) => {
    const y = s.get(x.address);
    return !!y && BigInt(y.stake_reward) + BigInt(y.commission) + BigInt(y.sentinel_grant) === BigInt(x.payout) && y.sentinel_grant === x.sentinel;
  });
};
const drop = (until: string) => {
  for (const list of [splits, validatorPeriods, splitChecks] as { rewards_until: string }[][])
    for (let k = list.length - 1; k >= 0; k--) if (list[k].rewards_until === until) list.splice(k, 1);
};
const todo = ends.filter(
  (r) => payouts.some((x) => x.rewards_until === r.rewards_until) && (values.rederive || !splitChecks.some((c) => c.rewards_until === r.rewards_until) || !stillMatches(r.rewards_until)),
);
// A period's unpaid amount as first published: a KYC re-issue may record 0 (Beta).
const firstUnpaid = (until: string) => BigInt(roots.find((r) => r.rewards_until === until)!.unpaid_amount);
const derivedNotes: string[] = [];
if (todo.length) {
  const events = await fetchStakingEvents(eth, ethHead);
  for (const r of todo) {
    const i = ends.indexOf(r);
    const until = r.rewards_until;
    const beta = until <= AEGIS_REWARDS_START;
    const to = Date.parse(until) / 1000;
    // Aegis: the fixed two-week grid (after the gap week); Beta: from the previous period's end.
    const from = !beta ? to - PERIOD_SECONDS : i === 0 ? Date.parse(BETA_REWARDS_START) / 1000 : Date.parse(ends[i - 1].rewards_until) / 1000;
    const sets = beta ? betaStakerSets : stakerSets;
    const pairs = periodStake(events, { from, to }, sets);
    // The validator's staker at the period end, and the delegate it named then (else itself).
    const stakerAt = new Map<string, string>();
    for (const x of [...sets].sort((a, b) => a.time - b.time)) if (x.time <= to) stakerAt.set(x.validator, x.staker);
    const beneficiaries = new Map<string, string>();
    for (const [v, st] of stakerAt) {
      const last = delegations.filter((d) => d.staker === st && d.time <= to).sort((a, b) => a.time - b.time).at(-1);
      beneficiaries.set(v, last?.delegate ?? st);
    }
    // Beta: 1-SAFE minimum payout; its unpaidAmount was recorded inconsistently, so the validator
    // rewards are checked against the base plus at most the previous recorded unpaid amount.
    const budget = beta ? BETA_PERIOD_REWARDS : periodBudget(until, ends[i - 1]);
    const d = deriveSplit({
      periodSeconds: BigInt(to - from),
      pairs,
      payouts: new Map(payouts.filter((x) => x.rewards_until === until).map((x) => [x.address, { payout: BigInt(x.payout), sentinel: BigInt(x.sentinel) }])),
      beneficiaries,
      stakers: stakerAt,
      budget,
      unpaid: beta ? firstUnpaid(until) : BigInt(r.unpaid_amount),
      ...(beta ? { minPayout: BETA_MIN_PAYOUT, budgetCheck: "rewards" as const, carryMax: i === 0 ? 0n : firstUnpaid(ends[i - 1].rewards_until) } : {}),
    });
    if (!d.ok) {
      const why = `${until.slice(0, 10)}: commission split not derivable: ${d.problems.slice(0, 5).join("; ")}${d.problems.length > 5 ? ` (+${d.problems.length - 5} more)` : ""}`;
      // A period that was verified and still matches its payouts must stay verified: fail instead.
      if (splitChecks.some((c) => c.rewards_until === until) && stillMatches(until)) throw new Error(`${why}; it was verified before`);
      drop(until);
      derivedNotes.push(`${why}. Recorded as split not verified.`);
      continue;
    }
    drop(until);
    const s = (v: bigint) => v.toString();
    const rows = [...d.recipients].sort(([a], [b]) => (a < b ? -1 : 1));
    splits.push(...rows.map(([address, x]) => ({ rewards_until: until, address, stake_reward: s(x.stake_reward), commission: s(x.commission), sentinel_grant: s(x.sentinel_grant) })));
    validatorPeriods.push(
      ...d.validators
        .sort((a, b) => (a.validator < b.validator ? -1 : 1))
        .map((v) => ({
          rewards_until: until,
          validator: v.validator,
          beneficiary: v.beneficiary,
          avg_stake: s(v.avg_stake),
          avg_self_stake: s(v.avg_self_stake),
          eligible: v.reward > 0n,
          commission_charged: v.commission_charged,
          reward: s(v.reward),
          self_reward: s(v.self_reward),
          delegator_reward: s(v.delegator_reward),
          commission: s(v.commission),
        })),
    );
    const sum = (f: (x: { stake_reward: bigint; commission: bigint; sentinel_grant: bigint }) => bigint) => rows.reduce((a, [, x]) => a + f(x), 0n);
    splitChecks.push({
      rewards_until: until,
      split_source: `derived from published payouts and chain data, ${d.checked} payouts reproduced`,
      recipients: rows.length,
      payouts_checked: d.checked,
      max_diff: s(d.max_diff),
      budget: s(budget),
      unpaid: r.unpaid_amount,
      stake_rewards: s(sum((x) => x.stake_reward)),
      commission: s(sum((x) => x.commission)),
      sentinel_grants: s(sum((x) => x.sentinel_grant)),
    });
    derivedNotes.push(`${until.slice(0, 10)}: commission split derived; ${d.checked} payouts reproduced (max difference ${d.max_diff} base units), commission ${sum((x) => x.commission)}`);
  }
}
splitChecks.sort((a, b) => (a.rewards_until < b.rewards_until ? -1 : 1));

const data: ValidatorRewardData = {
  source: REWARDS_SOURCE,
  ref,
  // The block only moves with new data, so an unchanged sync leaves the files unchanged (no daily PR).
  ens: { name: REWARDS_ENS_NAME, resolver: ens.resolver, through_block: reuse && downloaded === 0 && previous!.ens ? previous!.ens.through_block : ethHead, cids: ens.history.map((h) => h.cid) },
  addresses,
  stakers,
  roots,
  entries,
  latest_check: latestCheck,
  payouts,
  splits,
  validator_periods: validatorPeriods,
  split_checks: splitChecks,
};
await writeValidatorRewards(data);
for (const n of derivedNotes) console.log(n);
console.log(
  `${reuse ? `incremental: ${downloaded} rewards DB${downloaded === 1 ? "" : "s"} downloaded; ` : "full read; "}${roots.length} roots (${roots.filter((r) => r.kind === "period").length} periods; ${roots.filter((r) => r.source === "ipfs").length} from IPFS), ` +
    `${entries.length} entries for ${addresses.length} validator stakers and beneficiaries, ${payouts.length} payouts (Beta and Aegis); ` +
    `latest root ${latest.merkle_root} (${latest.rewards_until.slice(0, 10)}): ${latestCheck.addresses} proofs, cumulative + KYC ` +
    `${BigInt(latestCheck.sum_cumulative) + BigInt(latestCheck.sum_kyc)} vs tokenTotal ${latest.token_total}; ` +
    `distributor root ${onChainRoot === latest.merkle_root ? "= latest" : `${onChainRoot} (latest not set on chain yet)`}`,
);
