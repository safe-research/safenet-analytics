import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { DEFAULT_ROOT } from "../src/config.ts";
import { LINK_SQL } from "../src/links.ts";
import { EVENTS, FEE_TOKEN, ORACLE_FUNCTIONS, PRODUCTION, REWARDS_DISTRIBUTOR } from "../src/safenet.ts";

const read = (key: string) => readFile(`${DEFAULT_ROOT}/queries/${key}/query.sql`, "utf8");
// All raw-log decoding is in safenet_events.
const sql = await read("safenet_events");

test("every topic0 is the keccak hash of its event signature", () => {
  for (const [name, e] of Object.entries(EVENTS)) {
    assert.equal(`0x${bytesToHex(keccak_256(new TextEncoder().encode(e.signature)))}`, e.topic0, name);
  }
});

test("the metric SQL uses the production contracts and the right events", () => {
  for (const name of [
    "TransactionProposed",
    "TransactionAttested",
    "NewRequest",
    "OracleResult",
    "DisputeResolved",
    "RequestTimedOut",
    "DisputeOutOfScope",
    "ArbitrationTimedOut",
    "DisputeTriggered",
  ] as const)
    assert.ok(sql.includes(EVENTS[name].topic0), `${name} topic0 missing from SQL`);
  assert.ok(sql.includes(PRODUCTION.consensus.address));
  assert.ok(sql.includes(PRODUCTION.sentinelOracle.address));
  assert.ok(sql.includes(`0x000000000000000000000000${PRODUCTION.sentinelOracle.address.slice(2)}`));
});

test("the metric SQL does not read Beta, testnet or shared coordinator contracts", () => {
  for (const other of [
    "0x223624cbf099e5a8f8cd5af22afa424a1d1acee9", // Beta Consensus
    "0x73b4bdc3112dfb86085cdd84f26ab908b20a4a84", // Aegis testnet Consensus
    "0xb83c4b66e752d947c1f55fd703b7937e21e401e4", // Aegis testnet SentinelOracle
    "0xc6b34da4c99c043a093214d58423a8be39585b78", // FROSTCoordinator shared by production and testnet
  ])
    assert.ok(!sql.toLowerCase().includes(other.slice(2)), other);
});

// Raw logs are read only by the decoding models; everything else reads the models by reference.
const RAW_LOG_MODELS = [
  "safenet_events",
  "safenet_fee_flows",
  "safenet_guards",
  "safenet_guard_status",
  "safenet_sentinel_failed_calls",
  "safenet_sentinel_wallet_transfers",
  "safenet_reward_events",
];

test("only the decoding models read raw logs; other queries read them by reference", async () => {
  const { readdir } = await import("node:fs/promises");
  const keys = await readdir(`${DEFAULT_ROOT}/queries`);
  for (const key of keys) {
    const q = await read(key);
    const raw = /\b(gnosis|ethereum|arbitrum)\.(logs|traces)\b/.test(q);
    assert.equal(raw, RAW_LOG_MODELS.includes(key), `${key} ${raw ? "reads" : "does not read"} raw logs`);
  }
  for (const key of [
    "transaction_checks_daily",
    "safenet_requests",
    "safenet_fee_flows",
    "safenet_sentinel_terms",
    "safenet_sentinel_responses",
    "safenet_sentinel_wallet_transfers",
  ])
    assert.ok((await read(key)).includes("{{query:safenet_events}}"), `${key} does not read safenet_events`);
});

test("safenet_events builds links with the expressions from src/links.ts", () => {
  for (const [column, expression] of Object.entries(LINK_SQL)) assert.ok(sql.includes(`${expression} as ${column}`), column);
});

const hash = (s: string) => `0x${bytesToHex(keccak_256(new TextEncoder().encode(s)))}`;

test("Sentinel Oracle call selectors match their signatures", () => {
  for (const [name, f] of Object.entries(ORACLE_FUNCTIONS)) assert.equal(hash(f.signature).slice(0, 10), f.selector, name);
});

test("the Sentinel decoding queries use the production contracts, events and selectors", async () => {
  const failed = await read("safenet_sentinel_failed_calls");
  assert.ok(failed.includes(PRODUCTION.sentinelOracle.address));
  for (const f of Object.values(ORACLE_FUNCTIONS)) assert.ok(failed.includes(f.selector), f.signature);
  assert.ok(/\bnot success\b/.test(failed), "only reverted calls");

  const wallet = await read("safenet_sentinel_wallet_transfers");
  assert.ok(wallet.includes(FEE_TOKEN.address) && wallet.includes(EVENTS.Transfer.topic0));

  const rewards = await read("safenet_reward_events");
  assert.ok(rewards.includes(REWARDS_DISTRIBUTOR.address));
  assert.ok(rewards.includes(String(REWARDS_DISTRIBUTOR.deployBlock)) && rewards.includes(REWARDS_DISTRIBUTOR.deployDate));
  for (const name of ["RewardsClaimed", "MerkelRootUpdated"] as const) assert.ok(rewards.includes(EVENTS[name].topic0), name);

  for (const name of ["Committed", "Revealed", "Claimed", "SentinelScheduled", "SentinelRemoved"] as const)
    assert.ok(sql.includes(EVENTS[name].topic0), `${name} topic0 missing from safenet_events`);
});

test("Sentinel panel queries read the shared models, not their own decoding", async () => {
  for (const key of [
    "sentinel_overview",
    "sentinel_windows",
    "sentinel_participation_daily",
    "sentinel_verdicts",
    "sentinel_coverage",
    "sentinel_disputes",
    "sentinel_earnings",
    "sentinel_earnings_daily",
    "sentinel_bonds",
  ]) {
    const q = await read(key);
    assert.ok(/\{\{query:safenet_sentinel_(responses|terms)\}\}/.test(q), `${key} does not read the Sentinel models`);
    assert.ok(q.includes("through_block"), `${key} has no through_block for the verification`);
  }
});
