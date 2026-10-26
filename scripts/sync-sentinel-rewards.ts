// Fetches the published SAFE reward allocations of Sentinel addresses from safe-fndn/safenet-data:
// every published version of assets/rewards/latest.json up to a commit (default: the latest commit
// on main), and the proof file of each Sentinel address under each root. Writes
// dune/data/sentinel-rewards.json and regenerates the safenet_sentinel_rewards SQL.
//
// Sentinel addresses are the Sentinel labels (dune/data/participants.json) and every address in a
// production SentinelScheduled event (Gnosis Chain RPC, GNOSIS_RPC_URL or --rpc).
//
//   node scripts/sync-sentinel-rewards.ts [--ref <commit>] [--rpc URL]

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadParticipants } from "../src/participants.ts";
import { EVENTS, PRODUCTION } from "../src/safenet.ts";
import {
  proofPath,
  REWARDS_INDEX,
  REWARDS_SOURCE,
  SENTINEL_REWARDS_PATH,
  SENTINEL_REWARDS_SQL_PATH,
  sentinelRewardsSql,
  type RewardEntry,
  type RewardRoot,
  type SentinelRewardData,
} from "../src/sentinel-rewards.ts";
import { rpcClient, topicAddress } from "./lib/recount.ts";

const { values } = parseArgs({
  options: { ref: { type: "string" }, rpc: { type: "string", default: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com" } },
});

async function get(url: string, { allow404 = false } = {}) {
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
  if (allow404 && res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}
const raw = (ref: string, path: string, allow404 = false) =>
  get(`https://raw.githubusercontent.com/${REWARDS_SOURCE}/${ref}/${path}`, { allow404 });

const ref =
  values.ref ?? ((await get(`https://api.github.com/repos/${REWARDS_SOURCE}/commits/main`)) as { sha: string }).sha;

// Sentinel addresses: labels and onchain schedules.
const rpc = rpcClient(values.rpc!);
const scheduled = await rpc.getLogs(
  PRODUCTION.sentinelOracle.address,
  [EVENTS.SentinelScheduled.topic0],
  PRODUCTION.sentinelOracle.deployBlock,
  await rpc.finalized(),
);
const labels = (await loadParticipants()).participants.filter((p) => p.role === "sentinel").map((p) => p.address);
const addresses = [...new Set([...labels, ...scheduled.map((l) => topicAddress(l.topics[1]))])].sort();

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

const roots: RewardRoot[] = [];
const entries: RewardEntry[] = [];
for (const c of commits) {
  const index = (await raw(c.sha, REWARDS_INDEX)) as { merkleRoot?: string; rewardsUntil?: string };
  const root = index.merkleRoot?.toLowerCase();
  if (!root || !index.rewardsUntil || roots.some((r) => r.merkle_root === root)) continue;
  roots.push({ commit: c.sha, published_at: c.commit.committer.date, rewards_until: index.rewardsUntil, merkle_root: root });
  for (const address of addresses) {
    const proof = (await raw(c.sha, proofPath(address), true)) as
      | { cumulativeAmount: string; kycAmount?: string; merkleRoot: string }
      | undefined;
    if (!proof) continue;
    if (proof.merkleRoot.toLowerCase() !== root) throw new Error(`${c.sha} ${address}: proof root ${proof.merkleRoot} is not ${root}`);
    entries.push({ address, merkle_root: root, cumulative_amount: proof.cumulativeAmount, kyc_amount: proof.kycAmount ?? "0" });
  }
}

const data: SentinelRewardData = { source: REWARDS_SOURCE, ref, addresses, roots, entries };
await writeFile(SENTINEL_REWARDS_PATH, `${JSON.stringify(data, null, 2)}\n`);
await writeFile(SENTINEL_REWARDS_SQL_PATH, sentinelRewardsSql(data));
console.log(
  `${roots.length} published roots, ${entries.length} Sentinel entries for ${addresses.length} addresses from ${REWARDS_SOURCE}@${ref.slice(0, 7)}`,
);
