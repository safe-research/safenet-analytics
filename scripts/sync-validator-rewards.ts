// Fetches the published SAFE staking rewards of validator stakers from safe-fndn/safenet-data: every
// published version of assets/rewards/latest.json since the launch reset, up to a commit (default:
// the latest commit on main), and the proof file of each validator staker under each root. Checks
// the latest root against the sum of all its proof files. Writes dune/data/validator-rewards.json and
// regenerates the safenet_validator_rewards SQL (src/validator-rewards.ts).
//
// Validator stakers are every staker in a ValidatorStakerSet on Beta or production Consensus
// (Gnosis Chain RPC, GNOSIS_RPC_URL or --rpc).
//
//   node scripts/sync-validator-rewards.ts [--ref <commit>] [--rpc URL]

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { BETA_CONSENSUS, PRODUCTION, VALIDATOR_STAKER_SET } from "../src/safenet.ts";
import {
  loadValidatorRewards,
  proofPath,
  REWARDS_INDEX,
  REWARDS_SOURCE,
  VALIDATOR_REWARDS_PATH,
  VALIDATOR_REWARDS_SQL_PATH,
  validatorRewardsSql,
  type ValidatorRewardData,
  type ValidatorRewardEntry,
  type ValidatorRewardRoot,
} from "../src/validator-rewards.ts";
import { rpcClient, topicAddress } from "./lib/recount.ts";

const { values } = parseArgs({
  options: { ref: { type: "string" }, rpc: { type: "string", default: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com" } },
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

const ref =
  values.ref ?? ((await get(`https://api.github.com/repos/${REWARDS_SOURCE}/commits/main`)) as { sha: string }).sha;

// Validator stakers, Beta and production.
const rpc = rpcClient(values.rpc!);
const head = await rpc.finalized();
const stakers: ValidatorRewardData["stakers"] = [];
for (const [era, c] of [["beta", BETA_CONSENSUS], ["production", PRODUCTION.consensus]] as const)
  for (const l of await rpc.getLogs(c.address, [VALIDATOR_STAKER_SET.topic0], c.deployBlock, head))
    stakers.push({ validator: topicAddress(l.topics[1]), staker: `0x${l.data.slice(26, 66)}`.toLowerCase(), era });
const addresses = [...new Set(stakers.map((s) => s.staker))].sort();

// Every commit that changed the rewards index, oldest first, up to ref.
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
for (const { c, index } of indexes.slice(start + 1)) {
  const root = index.merkleRoot?.toLowerCase();
  if (!root || !index.rewardsUntil || roots.some((r) => r.merkle_root === root)) continue;
  roots.push({
    commit: c.sha,
    published_at: c.commit.committer.date,
    rewards_until: index.rewardsUntil,
    merkle_root: root,
    kind: roots.at(-1)?.rewards_until === index.rewardsUntil ? "reissue" : "period",
    token_total: index.tokenTotal ?? "0",
    sentinel_token_total: index.sentinelTokenTotal ?? null,
    unpaid_amount: index.unpaidAmount ?? "0",
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

// Latest root: every proof file, summed.
const latest = roots.at(-1)!;
const tree = (await get(`https://api.github.com/repos/${REWARDS_SOURCE}/git/trees/${latest.commit}?recursive=1`)) as {
  tree: { path: string; type: string }[];
  truncated: boolean;
};
if (tree.truncated) throw new Error("rewards tree listing truncated");
const proofFiles = tree.tree.filter((t) => t.type === "blob" && /^assets\/rewards\/proofs\/.*\.json$/.test(t.path)).map((t) => t.path);
let sumCumulative = 0n;
let sumKyc = 0n;
for (let i = 0; i < proofFiles.length; i += 16) {
  const batch = await Promise.all(proofFiles.slice(i, i + 16).map((p) => raw(latest.commit, p)));
  for (const p of batch as { cumulativeAmount: string; kycAmount?: string; merkleRoot: string }[]) {
    if (p.merkleRoot.toLowerCase() !== latest.merkle_root) throw new Error(`proof under another root at ${latest.commit}`);
    sumCumulative += BigInt(p.cumulativeAmount);
    sumKyc += BigInt(p.kycAmount ?? "0");
  }
}

const previous = await loadValidatorRewards().catch(() => undefined);
const data: ValidatorRewardData = {
  source: REWARDS_SOURCE,
  ref,
  stakers,
  roots,
  entries,
  latest_check: {
    merkle_root: latest.merkle_root,
    addresses: proofFiles.length,
    sum_cumulative: sumCumulative.toString(),
    sum_kyc: sumKyc.toString(),
    token_total: latest.token_total,
  },
  // Verified splits are kept across syncs; they are added by hand after reconciliation (see the doc).
  splits: previous?.splits ?? [],
};
await writeFile(VALIDATOR_REWARDS_PATH, `${JSON.stringify(data, null, 2)}\n`);
await writeFile(VALIDATOR_REWARDS_SQL_PATH, validatorRewardsSql(data));
console.log(
  `${roots.length} roots (${roots.filter((r) => r.kind === "period").length} periods), ${entries.length} entries for ${addresses.length} validator stakers ` +
    `from ${REWARDS_SOURCE}@${ref.slice(0, 7)}; latest root: ${proofFiles.length} proofs, cumulative + KYC ${sumCumulative + sumKyc} vs tokenTotal ${latest.token_total}`,
);
