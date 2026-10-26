import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { loadSentinelRewards, proofPath, SENTINEL_REWARDS_SQL_PATH, sentinelRewardsSql } from "../src/sentinel-rewards.ts";

test("proof files are sharded by the lowercase address", () => {
  assert.equal(
    proofPath("0x0484Bf598554aB04b9B21421eD28bFF6B7742993"),
    "assets/rewards/proofs/04/84/bf/59/0x0484bf598554ab04b9b21421ed28bff6b7742993.json",
  );
});

test("the published rewards query is generated from dune/data/sentinel-rewards.json", async () => {
  const data = await loadSentinelRewards();
  assert.match(data.ref, /^[0-9a-f]{40}$/);
  assert.ok(data.roots.length > 0);
  assert.equal(await readFile(SENTINEL_REWARDS_SQL_PATH, "utf8"), sentinelRewardsSql(data));
});

test("entries keep published amounts exactly and name their root", () => {
  const sql = sentinelRewardsSql({
    source: "x/y",
    ref: "0".repeat(40),
    addresses: ["0x0000000000000000000000000000000000000001"],
    roots: [{ commit: "c", published_at: "2026-10-08T00:00:00Z", rewards_until: "2026-10-06T00:00:00.000Z", merkle_root: "0xab" }],
    entries: [{ address: "0x0000000000000000000000000000000000000001", merkle_root: "0xab", cumulative_amount: "4499987774807670271201970", kyc_amount: "0" }],
  });
  assert.ok(sql.includes("cast('4499987774807670271201970' as uint256)"));
  assert.ok(sql.includes("timestamp '2026-10-06 00:00:00'"));
});
