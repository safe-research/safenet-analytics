import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { DEFAULT_ROOT } from "../src/config.ts";
import { LINK_SQL } from "../src/links.ts";
import { EVENTS, PRODUCTION } from "../src/safenet.ts";

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

test("only safenet_events reads raw logs; metric queries read it by reference", async () => {
  for (const key of ["transaction_checks_daily", "latest_requests"]) {
    const q = await read(key);
    assert.ok(!/\bgnosis\.logs\b/.test(q), `${key} reads gnosis.logs`);
    assert.ok(q.includes("{{query:safenet_events}}"), `${key} does not read safenet_events`);
  }
});

test("safenet_events builds links with the expressions from src/links.ts", () => {
  for (const [column, expression] of Object.entries(LINK_SQL)) assert.ok(sql.includes(`${expression} as ${column}`), column);
});
