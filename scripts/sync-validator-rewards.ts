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
// every Aegis period, and writes dune/data/validator-rewards.json and the generated queries.
// Verified commission splits (scripts/record-reward-split.ts) are kept.
//
// Validator stakers are every staker in a ValidatorStakerSet on Beta or production Consensus
// (Gnosis Chain RPC, GNOSIS_RPC_URL or --rpc), plus the commission beneficiaries of verified periods.
//
//   node scripts/sync-validator-rewards.ts [--ref <commit>] [--rpc URL] [--eth-rpc URL] [--gateway URL]

import { parseArgs } from "node:util";
import { contenthashHistory, DEFAULT_IPFS_GATEWAYS, fetchRewardsDb, proofTotals, REWARDS_ENS_NAME, type RewardsProof } from "../src/rewards-ipfs.ts";
import { BETA_CONSENSUS, PRODUCTION, REWARDS_DISTRIBUTOR, VALIDATOR_STAKER_SET } from "../src/safenet.ts";
import {
  AEGIS_REWARDS_START,
  BETA_REWARDS_REF,
  loadValidatorRewards,
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
import { DEFAULT_ETH_RPC } from "./lib/staking.ts";

const { values } = parseArgs({
  options: {
    ref: { type: "string", default: BETA_REWARDS_REF },
    rpc: { type: "string", default: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com" },
    "eth-rpc": { type: "string", default: process.env.ETHEREUM_RPC_URL || DEFAULT_ETH_RPC },
    gateway: { type: "string", default: process.env.IPFS_GATEWAY_URL || DEFAULT_IPFS_GATEWAYS },
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

// Validator stakers, Beta and production, and verified commission beneficiaries.
const rpc = rpcClient(values.rpc!);
const head = await rpc.finalized();
const stakers: ValidatorRewardData["stakers"] = [];
for (const [era, c] of [["beta", BETA_CONSENSUS], ["production", PRODUCTION.consensus]] as const)
  for (const l of await rpc.getLogs(c.address, [VALIDATOR_STAKER_SET.topic0], c.deployBlock, head))
    stakers.push({ validator: topicAddress(l.topics[1]), staker: `0x${l.data.slice(26, 66)}`.toLowerCase(), era });
const beneficiaries = (previous?.validator_periods ?? []).map((v) => v.beneficiary).filter((b) => !/^0x0{40}$/.test(b));
const addresses = [...new Set([...stakers.map((s) => s.staker), ...beneficiaries])].sort();

// ---------------------------------------------------------------------------------------------
// Beta: safenet-data git history up to ref.

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

const roots: ValidatorRewardRoot[] = [];
const entries: ValidatorRewardEntry[] = [];
const kindOf = (rewardsUntil: string) => (roots.at(-1)?.rewards_until === rewardsUntil ? "reissue" : "period");
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

// ---------------------------------------------------------------------------------------------
// Aegis: ENS contenthash history, rewards DBs from IPFS.

const eth = rpcClient(values["eth-rpc"]!);
const ethHead = await eth.finalized();
const ens = await contenthashHistory(eth, { fromBlock: REWARDS_DISTRIBUTOR.deployBlock, toBlock: ethHead });
const proofs = new Map<string, Map<string, RewardsProof>>(); // full proofs by merkle root
for (const h of ens.history) {
  const db = await fetchRewardsDb(h.cid, values.gateway);
  const root = db.index.merkleRoot.toLowerCase();
  const t = proofTotals(db);
  if (t.cumulative + t.kyc !== BigInt(db.index.tokenTotal))
    throw new Error(`${h.cid}: proofs add up to ${t.cumulative + t.kyc}, not tokenTotal ${db.index.tokenTotal}`);
  proofs.set(root, db.proofs);
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

// On-chain root: the latest DB must be the one the distributor uses (resolvePreviousRewardsDb in the
// reward scripts requires the same). A newer ENS DB whose root is not set yet is reported.
const onChainRoot = (await eth.call<string>("eth_call", [{ to: REWARDS_DISTRIBUTOR.address, data: "0x2eb4a7ab" }, `0x${ethHead.toString(16)}`])).toLowerCase();

// Latest root: every proof file, summed (IPFS: already checked above; git: the tree).
const latest = roots.at(-1)!;
let latestCheck: ValidatorRewardData["latest_check"];
if (proofs.has(latest.merkle_root)) {
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

const payouts = periodPayouts(roots, proofs);
const data: ValidatorRewardData = {
  source: REWARDS_SOURCE,
  ref,
  ens: { name: REWARDS_ENS_NAME, resolver: ens.resolver, through_block: ethHead, cids: ens.history.map((h) => h.cid) },
  stakers,
  roots,
  entries,
  latest_check: latestCheck,
  payouts,
  // Verified splits are kept across syncs; they are added by scripts/record-reward-split.ts.
  splits: previous?.splits ?? [],
  validator_periods: previous?.validator_periods ?? [],
  split_checks: previous?.split_checks ?? [],
};
await writeValidatorRewards(data);
// Published Aegis periods without a verified split: how to record one (docs/metrics/staking.md#commission-split).
const ends = periodEnds(roots);
for (let i = 1; i < ends.length; i++) {
  const r = ends[i];
  if (r.rewards_until <= AEGIS_REWARDS_START || data.split_checks!.some((c) => c.rewards_until === r.rewards_until)) continue;
  console.log(
    `${r.rewards_until.slice(0, 10)}: no verified commission split. In safenet-staking-scripts: ` +
      `npx tsx export-split.ts --previousCid=${ends[i - 1].cid ?? "<not pinned by ENS>"} > split.json; then: node scripts/record-reward-split.ts split.json`,
  );
}
console.log(
  `${roots.length} roots (${roots.filter((r) => r.kind === "period").length} periods; ${roots.filter((r) => r.source === "ipfs").length} from IPFS), ` +
    `${entries.length} entries for ${addresses.length} validator stakers and beneficiaries, ${payouts.length} Aegis payouts; ` +
    `latest root ${latest.merkle_root} (${latest.rewards_until.slice(0, 10)}): ${latestCheck.addresses} proofs, cumulative + KYC ` +
    `${BigInt(latestCheck.sum_cumulative) + BigInt(latestCheck.sum_kyc)} vs tokenTotal ${latest.token_total}; ` +
    `distributor root ${onChainRoot === latest.merkle_root ? "= latest" : `${onChainRoot} (latest not set on chain yet)`}`,
);
