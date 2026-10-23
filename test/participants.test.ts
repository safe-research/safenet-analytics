import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { LABELS_SQL_PATH, labelFor, loadParticipants, normalize, participantLabelsSql } from "../src/participants.ts";

test("normalizes addresses, drops invalid entries and falls back to the address", () => {
  const out = normalize("validator", [
    { address: "0x3D58a5475c1336b0A755c3aBd298CeB9b7BB9CDe", label: "Gnosis" },
    { address: "0x3d58a5475c1336b0a755c3abd298ceb9b7bb9cde", label: "Duplicate" },
    { address: "0xF6EA21D702983c443f58A267265912FE03D2FF0b", label: "  " },
    { address: "not an address", label: "Broken" },
    { label: "No address" },
  ]);
  assert.deepEqual(out, [
    { role: "validator", address: "0x3d58a5475c1336b0a755c3abd298ceb9b7bb9cde", label: "Gnosis" },
    { role: "validator", address: "0xf6ea21d702983c443f58a267265912fe03d2ff0b", label: "0xf6ea21d702983c443f58a267265912fe03d2ff0b" },
  ]);
});

test("labels match case-insensitively per role and fall back to the address", () => {
  const ps = normalize("sentinel", [{ address: "0xc84a0928632382E75c543ACCeD101B9525027362", label: "BlockSec" }]);
  assert.equal(labelFor(ps, "sentinel", "0xC84A0928632382E75C543ACCED101B9525027362"), "BlockSec");
  assert.equal(labelFor(ps, "validator", "0xc84a0928632382e75c543acced101b9525027362"), "0xc84a0928632382e75c543acced101b9525027362");
  assert.equal(labelFor(ps, "sentinel", "0x0000000000000000000000000000000000000001"), "0x0000000000000000000000000000000000000001");
});

test("the participant labels query is generated from dune/data/participants.json", async () => {
  const data = await loadParticipants();
  assert.match(data.ref, /^[0-9a-f]{40}$/);
  assert.equal(await readFile(LABELS_SQL_PATH, "utf8"), participantLabelsSql(data));
});

test("labels are escaped in SQL", () => {
  const sql = participantLabelsSql({
    source: "x/y",
    ref: "0".repeat(40),
    participants: [{ role: "sentinel", address: "0x0000000000000000000000000000000000000001", label: "O'Brien" }],
  });
  assert.ok(sql.includes("'O''Brien'"));
});
