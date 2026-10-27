import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { parse } from "yaml";
import { DEFAULT_ROOT, inlineSql, loadConfig, referencedColumns, type VisualizationSpec } from "../src/config.ts";
import { loadParticipants } from "../src/participants.ts";
import { BETA_CONSENSUS, EVENTS, FROST_COORDINATOR, GENESIS_GROUP_ID, PRODUCTION, VALIDATOR_EVENTS, VALIDATOR_STAKER_SET } from "../src/safenet.ts";
import { loadValidatorRewards, validatorRewardsSql, VALIDATOR_REWARDS_SQL_PATH } from "../src/validator-rewards.ts";
import { VALIDATOR_COLORS } from "../src/validators.ts";

const read = (key: string) => readFile(`${DEFAULT_ROOT}/queries/${key}/query.sql`, "utf8");
const meta = async (key: string) => parse(await readFile(`${DEFAULT_ROOT}/queries/${key}/query.yaml`, "utf8"));
const hash = (s: string) => `0x${bytesToHex(keccak_256(new TextEncoder().encode(s)))}`;
const word = (address: string) => `0x000000000000000000000000${address.slice(2)}`;

const MODELS = ["validator_epochs", "validator_membership", "validator_ceremonies", "validator_staker_history", "safenet_validator_rewards"];
const PANELS = [
  "validator_overview",
  "validator_stake_status",
  "validator_participation_daily",
  "validator_participation_windows",
  "validator_stake_daily",
  "validator_stake_split_daily",
  "validator_rewards_periods",
  "validator_rewards_by_staker",
  "validator_withdrawal_exposure",
];

test("validator event signatures match their topic0 values", () => {
  for (const [name, e] of Object.entries(VALIDATOR_EVENTS)) assert.equal(hash(e.signature), e.topic0, name);
});

test("epochs come from production Consensus: the genesis group and every EpochStaged", async () => {
  const q = await read("validator_epochs");
  assert.ok(q.includes(PRODUCTION.consensus.address) && q.includes(VALIDATOR_EVENTS.EpochStaged.topic0));
  assert.ok(q.includes(GENESIS_GROUP_ID), "genesis group (getEpochGroupId(0))");
  assert.ok(q.includes(String(PRODUCTION.consensus.deployBlock)));
});

test("membership and ceremonies read the shared coordinator only through production Consensus", async () => {
  const membership = await read("validator_membership");
  assert.ok(membership.includes(FROST_COORDINATOR.address) && membership.includes(VALIDATOR_EVENTS.KeyGenConfirmed.topic0));
  assert.ok(membership.includes(String(FROST_COORDINATOR.deployBlock)));
  assert.ok(membership.includes("{{query:validator_epochs}}"), "groups named by production Consensus");

  const ceremonies = await read("validator_ceremonies");
  for (const name of ["Sign", "SignShared", "SignCompleted"] as const) assert.ok(ceremonies.includes(VALIDATOR_EVENTS[name].topic0), name);
  assert.ok(ceremonies.includes(word(PRODUCTION.consensus.address)), "Sign initiator = production Consensus");
  assert.ok(ceremonies.includes(EVENTS.TransactionAttested.topic0) && ceremonies.includes(VALIDATOR_EVENTS.EpochStaged.topic0));
  assert.ok(ceremonies.includes("{{query:validator_membership}}"));
});

test("a signature share counts only under the completed signature's selection root", async () => {
  const q = await read("validator_ceremonies");
  assert.match(q, /s\.selection_root = c\.selection_root/);
  assert.match(q, /completed_at is not null as completed/);
});

test("Beta Consensus is read only for the staker history", async () => {
  for (const key of await readdir(`${DEFAULT_ROOT}/queries`)) {
    const q = (await read(key)).toLowerCase();
    assert.equal(q.includes(BETA_CONSENSUS.address.slice(2)), key === "validator_staker_history", key);
  }
  const h = await read("validator_staker_history");
  assert.ok(h.includes(PRODUCTION.consensus.address) && h.includes(VALIDATOR_STAKER_SET.topic0));
});

test("validator panels read the shared models and stay within the scan limits", async () => {
  const config = await loadConfig();
  for (const key of PANELS) {
    const q = await read(key);
    assert.ok(/\{\{query:(validator_|staking_|safenet_validator_rewards)/.test(q), `${key} does not read the models`);
    const inlined = inlineSql(config.queries.find((x) => x.key === key)!, config.queries);
    // Dune inlines every reference; see the fan-out tests in test/safenet.test.ts.
    assert.ok((inlined.match(/gnosis\.logs/g) ?? []).length <= 9, `${key}: too many gnosis.logs scans`);
    assert.ok((inlined.match(/from safe_ethereum\.Staking_evt_StakeIncreased/g) ?? []).length <= 3, `${key}: staking_events read too often`);
  }
});

test("models are not scheduled; panels are", async () => {
  for (const key of MODELS) assert.equal((await meta(key)).refresh, "none", key);
  for (const key of PANELS) assert.equal((await meta(key)).refresh, "daily", key);
});

test("every validator has one colour, used by every chart grouped by validator", async () => {
  const labels = (await loadParticipants()).participants.filter((p) => p.role === "validator").map((p) => p.label);
  assert.deepEqual(Object.keys(VALIDATOR_COLORS).sort(), [...new Set(labels)].sort());
  assert.equal(new Set(Object.values(VALIDATOR_COLORS)).size, Object.keys(VALIDATOR_COLORS).length);
  for (const key of PANELS) {
    for (const v of Object.values(((await meta(key)).visualizations ?? {}) as Record<string, { options: Record<string, unknown> }>)) {
      const mapping = (v.options.columnMapping ?? {}) as Record<string, string>;
      if (!Object.entries(mapping).some(([c, role]) => role === "series" && c === "validator")) continue;
      const series = v.options.seriesOptions as Record<string, { color: string }>;
      assert.deepEqual(Object.fromEntries(Object.entries(series).map(([k, s]) => [k, s.color])), VALIDATOR_COLORS, key);
    }
  }
});

test("a chart grouped by a series column keys seriesOptions by value, not column", () => {
  const v = (options: Record<string, unknown>) => ({ key: "c", name: "c", type: "chart", options }) as unknown as VisualizationSpec;
  assert.deepEqual(referencedColumns(v({ columnMapping: { day: "x", stake: "y", validator: "series" }, seriesOptions: { Gnosis: {} } })), ["day", "stake", "validator"]);
  assert.deepEqual(referencedColumns(v({ columnMapping: { day: "x", stake: "y" }, seriesOptions: { stake: {} } })), ["day", "stake", "stake"]);
});

test("the published rewards query is generated from dune/data/validator-rewards.json", async () => {
  const data = await loadValidatorRewards();
  assert.equal(await readFile(VALIDATOR_REWARDS_SQL_PATH, "utf8"), validatorRewardsSql(data));
  assert.equal(
    BigInt(data.latest_check.sum_cumulative) + BigInt(data.latest_check.sum_kyc),
    BigInt(data.latest_check.token_total),
    "latest root: proofs add up to tokenTotal",
  );
  assert.equal(data.roots[0].kind, "period");
  for (const e of data.entries) assert.ok(data.roots.some((r) => r.merkle_root === e.merkle_root));
});
