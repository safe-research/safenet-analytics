import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ROOT } from "../src/config.ts";
import { DECODED_SOURCES, eventName, formatVerdicts, paritySql, verdicts, type ParityRow } from "../src/decoded-parity.ts";
import { EVENTS, VALIDATOR_EVENTS, VALIDATOR_STAKER_SET } from "../src/safenet.ts";

const ORACLE = DECODED_SOURCES.find((s) => s.table === "safe_gnosis.SafenetAegisSentinelOracle")!;

// Events the models read from contracts Dune has not decoded under the Safenet namespace: USDC.e
// transfers, Safe guard changes and SafenetGuard deployments. They stay on raw logs.
const RAW_ONLY = new Set<string>([EVENTS.Transfer.topic0, EVENTS.ChangedGuard.topic0, EVENTS.EpochInitialized.topic0]);

test("every event a model reads from raw logs is covered by the parity check, or explicitly raw-only", async () => {
  const known = new Map<string, string>(
    [...Object.values(EVENTS), ...Object.values(VALIDATOR_EVENTS), VALIDATOR_STAKER_SET].map((e) => [e.topic0, e.signature]),
  );
  const covered = new Set(DECODED_SOURCES.flatMap((s) => s.events.map((e) => e.topic0)));
  const queries = join(DEFAULT_ROOT, "queries");
  for (const key of await readdir(queries)) {
    const sql = await readFile(join(queries, key, "query.sql"), "utf8");
    if (!/\b(gnosis|ethereum)\.logs\b/.test(sql)) continue;
    for (const [topic] of sql.matchAll(/0x[0-9a-f]{64}\b/g)) {
      if (!known.has(topic)) continue; // ids, roots and other constants
      assert.ok(covered.has(topic) || RAW_ONLY.has(topic), `${key} reads ${known.get(topic)} from raw logs, but the parity check does not cover it`);
    }
  }
});

test("every decoded Safenet table a query reads is covered by the parity check", async () => {
  const covered = new Set(DECODED_SOURCES.flatMap((s) => s.events.map((e) => `${s.table}_evt_${eventName(e)}`.toLowerCase())));
  const queries = join(DEFAULT_ROOT, "queries");
  let reads = 0;
  for (const key of await readdir(queries)) {
    const sql = await readFile(join(queries, key, "query.sql"), "utf8");
    for (const [table] of sql.matchAll(/\bsafe_gnosis\.SafenetAegis\w+_evt_\w+/gi)) {
      reads++;
      assert.ok(covered.has(table.toLowerCase()), `${key} reads ${table}, which the parity check does not cover`);
    }
  }
  assert.ok(reads > 0);
});

test("the parity query matches each decoded table with the raw logs of the same contract and topic0", () => {
  const sql = paritySql(ORACLE);
  for (const e of ORACLE.events) {
    assert.ok(sql.includes(`from safe_gnosis.SafenetAegisSentinelOracle_evt_${eventName(e)}, params`), eventName(e));
    assert.ok(sql.includes(`when ${e.topic0} then '${eventName(e)}'`), eventName(e));
  }
  assert.equal(eventName(EVENTS.RewardsClaimed), "Claimed");
  assert.ok(sql.includes(`where contract_address = ${ORACLE.address}`));
  assert.ok(sql.includes("from gnosis.logs, params"));
  assert.ok(sql.includes(`between ${ORACLE.deployBlock} and to_block`));
  assert.ok(sql.includes("time < now() - interval '1' day"), "compares only blocks at least a day old");
  assert.ok(sql.includes("full outer join decoded as d on d.event = r.event and d.tx_hash = r.tx_hash and d.log_index = r.log_index"));
  const distributor = paritySql(DECODED_SOURCES.find((s) => s.chain === "ethereum")!);
  assert.ok(distributor.includes("from ethereum.logs, params") && distributor.includes("safe_ethereum.CumulativeMerkleDrop_evt_MerkelRootUpdated"));
});

test("verdicts: matching logs pass, any log on one side only fails, events without logs are reported", () => {
  const row = (event: string, over: Partial<ParityRow> = {}): ParityRow => ({
    event,
    raw_logs: 10,
    decoded_rows: 10,
    missing_in_decoded: 0,
    only_in_decoded: 0,
    first_raw_block: 48635900,
    first_decoded_block: 48635900,
    to_block: 49000000,
    ...over,
  });
  const v = verdicts(ORACLE, [
    row("NewRequest"),
    row("Committed", { decoded_rows: 8, missing_in_decoded: 2, first_decoded_block: 48700000 }), // backfill incomplete
    row("Revealed", { decoded_rows: 11, only_in_decoded: 1 }),
  ]);
  const by = (e: string) => v.find((x) => x.event === e)!;
  assert.deepEqual([by("NewRequest").ok, by("NewRequest").reason], [true, "all 10 logs match"]);
  assert.deepEqual([by("Committed").ok, by("Committed").reason], [false, "2 raw logs missing in the decoded table"]);
  assert.deepEqual([by("Revealed").ok, by("Revealed").reason], [false, "1 decoded rows without a raw log"]);
  assert.deepEqual([by("ArbitrationTimedOut").ok, by("ArbitrationTimedOut").reason], [true, "no logs on either side yet"]);
  assert.equal(v.length, ORACLE.events.length);
  const text = formatVerdicts(v, [{ source: "safe_gnosis.SafenetAegisFROSTCoordinator", error: "table not found" }]);
  assert.match(text, /^\*\*Parity does not hold:\*\* 2 events differ, 1 contracts could not be checked\./);
  assert.match(text, /\| `safe_gnosis\.SafenetAegisSentinelOracle_evt_Committed` \| 10 \| 8 \| 48635900 \| 48700000 \| 49000000 \| \*\*differs\*\*/);
  assert.match(formatVerdicts(verdicts(ORACLE, [row("NewRequest")]), []), /^\*\*Parity holds\*\* for all 16 events/);
});
