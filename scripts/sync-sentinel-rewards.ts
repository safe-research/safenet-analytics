// Fetches the published SAFE reward allocations of Sentinel addresses: every published version of
// assets/rewards/latest.json in safe-fndn/safenet-data up to a commit (default BETA_REWARDS_REF; the
// mirror is frozen since Beta), then every rewards DB the ENS name rewards.safenet-gov.eth has pinned
// on Ethereum, from IPFS and verified against its CID (src/rewards-ipfs.ts), with the proof of each
// Sentinel address under each root. Writes dune/data/sentinel-rewards.json and regenerates the
// safenet_sentinel_rewards SQL.
//
// Sentinel addresses are the Sentinel labels (dune/data/participants.json) and every address in a
// production SentinelScheduled event (Gnosis Chain RPC, GNOSIS_RPC_URL or --rpc).
//
//   node scripts/sync-sentinel-rewards.ts [--ref <commit>] [--rpc URL] [--eth-rpc URL] [--gateway URLS]

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadParticipants } from "../src/participants.ts";
import { contenthashHistory, DEFAULT_IPFS_GATEWAYS, fetchRewardsDb } from "../src/rewards-ipfs.ts";
import { EVENTS, PRODUCTION, REWARDS_DISTRIBUTOR } from "../src/safenet.ts";
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
import { BETA_REWARDS_REF } from "../src/validator-rewards.ts";
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
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
  if (allow404 && res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}
const raw = (ref: string, path: string, allow404 = false) =>
  get(`https://raw.githubusercontent.com/${REWARDS_SOURCE}/${ref}/${path}`, { allow404 });

const ref = values.ref!;

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

// Aegis: the rewards DBs pinned by ENS, oldest first. A root already mirrored in git is skipped.
const eth = rpcClient(values["eth-rpc"]!);
const ens = await contenthashHistory(eth, { fromBlock: REWARDS_DISTRIBUTOR.deployBlock, toBlock: await eth.finalized() });
for (const h of ens.history) {
  const db = await fetchRewardsDb(h.cid, values.gateway);
  const root = db.index.merkleRoot.toLowerCase();
  if (roots.some((r) => r.merkle_root === root)) continue;
  roots.push({ commit: h.cid, published_at: new Date(h.time * 1000).toISOString(), rewards_until: db.index.rewardsUntil, merkle_root: root });
  for (const address of addresses) {
    const p = db.proofs.get(address);
    if (p) entries.push({ address, merkle_root: root, cumulative_amount: p.cumulativeAmount, kyc_amount: p.kycAmount ?? "0" });
  }
}

const data: SentinelRewardData = { source: REWARDS_SOURCE, ref, addresses, roots, entries };
await writeFile(SENTINEL_REWARDS_PATH, `${JSON.stringify(data, null, 2)}\n`);
await writeFile(SENTINEL_REWARDS_SQL_PATH, sentinelRewardsSql(data));
console.log(
  `${roots.length} published roots (${ens.history.length} ENS CIDs), ${entries.length} Sentinel entries for ${addresses.length} addresses from ${REWARDS_SOURCE}@${ref.slice(0, 7)} and IPFS`,
);
