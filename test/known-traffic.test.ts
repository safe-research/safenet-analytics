import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { KNOWN_TRAFFIC_SQL_PATH, knownTrafficSql, loadKnownSafes, validateKnownSafes } from "../src/known-traffic.ts";

test("the known-traffic query is generated from dune/data/known-traffic.json", async () => {
  const safes = await loadKnownSafes();
  assert.deepEqual(validateKnownSafes(safes), []);
  assert.equal(await readFile(KNOWN_TRAFFIC_SQL_PATH, "utf8"), knownTrafficSql(safes));
});

test("rejects malformed entries", () => {
  const p = validateKnownSafes([
    { chain_id: 100, address: "0xC89A", category: "operational", label: "x", source: "y" },
    { chain_id: 0, address: `0x${"a".repeat(40)}`, category: "other" as "test", label: "", source: "" },
  ]);
  assert.equal(p.length, 4, p.join("\n"));
});

test("an empty list still yields a valid, empty query", () => {
  const sql = knownTrafficSql([]);
  assert.match(sql, /where safe_address is not null/);
});
