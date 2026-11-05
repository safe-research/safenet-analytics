import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { DEFAULT_ROOT } from "../src/config.ts";
import {
  abiBytes,
  base32,
  cidString,
  DAG_PB,
  decodeContenthash,
  fromBase32,
  namehash,
  parseCid,
  proofTotals,
  RAW,
  REWARDS_ENS_NAME,
  rewardsDbFromCar,
} from "../src/rewards-ipfs.ts";
import {
  loadValidatorRewards,
  periodEnds,
  periodPayouts,
  REWARD_BREAKDOWN_SQL_PATH,
  rewardBreakdownSql,
  type ValidatorRewardRoot,
} from "../src/validator-rewards.ts";
import { apr, byValidator, completedPeriods, periodStake, rewardParticipation } from "../scripts/lib/rewards-apr.ts";
import type { StakingEvent } from "../scripts/lib/staking.ts";
import type { Ceremony } from "../scripts/lib/validators.ts";

const read = (key: string) => readFile(`${DEFAULT_ROOT}/queries/${key}/query.sql`, "utf8");
const meta = async (key: string) => parse(await readFile(`${DEFAULT_ROOT}/queries/${key}/query.yaml`, "utf8"));

// ---------------------------------------------------------------------------------------------
// ENS and IPFS

test("namehash follows EIP-137", () => {
  assert.equal(namehash("eth"), "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae");
  assert.equal(namehash(REWARDS_ENS_NAME), "0x2ca43be3a22c27d01383e19bcae6429fce3b62edb69123ec3d512c9f5f448491");
});

test("the rewards contenthash decodes to the CIDv1 the gateways serve", () => {
  // contenthash() of rewards.safenet-gov.eth at Ethereum block 26341873 (ABI-encoded bytes)
  const word =
    "0x0000000000000000000000000000000000000000000000000000000000000020" +
    "0000000000000000000000000000000000000000000000000000000000000026" +
    "e301017012202d126b79035ab7b826bebcdbe3ece4e63356a7136758de5bd92e912fd75f3a230000000000000000000000000000000000000000000000000000";
  const cid = decodeContenthash(abiBytes(word));
  assert.equal(cidString(cid), "bafybeibncjvxsa22w64cnpv43pr6zzhggnlkoe3hldpfxwjosex5oxz2em");
  assert.deepEqual(parseCid(cidString(cid)), cid);
  assert.deepEqual(fromBase32(base32(Uint8Array.from([1, 2, 3, 250]))), Uint8Array.from([1, 2, 3, 250]));
  assert.throws(() => decodeContenthash("0xe50101701220"), /IPFS namespace/);
});

// A minimal CARv1 writer for fixtures: raw leaves and UnixFS directories.
const varint = (n: number) => {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest();
const cidBytes = (codec: number, data: Uint8Array) => Uint8Array.from([1, codec, 0x12, 32, ...sha(data)]);
const field = (n: number, b: Uint8Array | number[]) => [...varint((n << 3) | 2), ...varint(b.length), ...b];
const dir = (links: { name: string; cid: Uint8Array }[]) =>
  Uint8Array.from([
    ...links.flatMap((l) => field(2, [...field(1, l.cid), ...field(2, [...new TextEncoder().encode(l.name)])])),
    ...field(1, [0x08, 0x01]), // UnixFS Data { Type: Directory }
  ]);
function car(files: Record<string, unknown>) {
  const blocks: { cid: Uint8Array; data: Uint8Array }[] = [];
  const put = (codec: number, data: Uint8Array) => {
    const cid = cidBytes(codec, data);
    blocks.push({ cid, data });
    return cid;
  };
  // Build the tree: path segments → directories.
  const tree: Record<string, unknown> = {};
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/");
    let node = tree as Record<string, unknown>;
    for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Record<string, unknown>;
    node[parts.at(-1)!] = new TextEncoder().encode(JSON.stringify(content));
  }
  const write = (node: Record<string, unknown>): Uint8Array =>
    put(
      DAG_PB,
      dir(
        Object.keys(node)
          .sort()
          .map((name) => ({ name, cid: node[name] instanceof Uint8Array ? put(RAW, node[name] as Uint8Array) : write(node[name] as Record<string, unknown>) })),
      ),
    );
  const root = write(tree);
  // Header: dag-cbor { roots: [CID], version: 1 }
  const header = Uint8Array.from([0xa2, 0x65, ...new TextEncoder().encode("roots"), 0x81, 0xd8, 0x2a, 0x58, root.length + 1, 0x00, ...root, 0x67, ...new TextEncoder().encode("version"), 0x01]);
  const bytes = [...varint(header.length), ...header];
  for (const b of blocks) bytes.push(...varint(b.cid.length + b.data.length), ...b.cid, ...b.data);
  return { car: Uint8Array.from(bytes), cid: `b${base32(root)}` };
}

const ROOT = "0x00000000000000000000000000000000000000000000000000000000000000aa";
const A = "0x0000000000000000000000000000000000000001";
const fixture = car({
  "latest.json": { merkleRoot: ROOT, rewardsUntil: "2026-10-27T00:00:00.000Z", tokenTotal: "30", sentinelTokenTotal: "10", unpaidAmount: "0" },
  [`proofs/00/00/00/00/${A}.json`]: { cumulativeAmount: "20", kycAmount: "10", sentinelAmount: "10", merkleRoot: ROOT, proof: [] },
});

test("a rewards DB is read from a verified CAR", () => {
  const db = rewardsDbFromCar(fixture.car, fixture.cid);
  assert.equal(db.index.merkleRoot, ROOT);
  assert.deepEqual([...db.proofs.keys()], [A]);
  const t = proofTotals(db);
  assert.equal(t.cumulative + t.kyc, 30n);
});

test("a CAR that does not match its CID is rejected", () => {
  const tampered = Uint8Array.from(fixture.car);
  tampered[tampered.length - 3] ^= 1;
  assert.throws(() => rewardsDbFromCar(tampered, fixture.cid), /does not match its hash/);
  const other = car({ "latest.json": { merkleRoot: ROOT, rewardsUntil: "2026-10-27T00:00:00.000Z", tokenTotal: "0" } });
  assert.throws(() => rewardsDbFromCar(other.car, fixture.cid), /CAR root .* is not/);
  // A gateway that leaves out a block cannot pass either.
  const truncated = fixture.car.subarray(0, fixture.car.length - 40);
  assert.throws(() => rewardsDbFromCar(truncated, fixture.cid));
});

// ---------------------------------------------------------------------------------------------
// Payouts

const root = (rewards_until: string, merkle_root: string, kind: "period" | "reissue" = "period"): ValidatorRewardRoot => ({
  commit: "c",
  published_at: rewards_until,
  rewards_until,
  merkle_root,
  kind,
  token_total: "0",
  sentinel_token_total: null,
  unpaid_amount: "0",
});

test("period payouts are changes from the previous period's last root; KYC releases pay nothing", () => {
  const roots = [root("2026-10-06T00:00:00.000Z", "beta"), root("2026-10-27T00:00:00.000Z", "p1"), root("2026-10-27T00:00:00.000Z", "p1b", "reissue"), root("2026-11-10T00:00:00.000Z", "p2")];
  const p = (c: string, k = "0", s = "0") => ({ cumulativeAmount: c, kycAmount: k, sentinelAmount: s });
  const proofs = new Map([
    ["beta", new Map([[A, p("100")]])],
    // the re-issue of period 1 is the one that counts
    ["p1b", new Map([[A, p("100", "50")], ["0xb", p("0", "15", "15")]])],
    ["p2", new Map([[A, p("160")], ["0xb", p("0", "30", "30")]])],
  ]);
  assert.deepEqual(periodEnds(roots).map((r) => r.merkle_root), ["beta", "p1b", "p2"]);
  const out = periodPayouts(roots, proofs);
  assert.deepEqual(
    out.map((x) => [x.rewards_until.slice(0, 10), x.address, x.payout, x.kyc_change, x.sentinel]),
    [
      ["2026-10-27", A, "50", "50", "0"],
      ["2026-10-27", "0xb", "15", "15", "15"],
      // A's 50 withheld are released (kyc → cumulative): only the 10 new SAFE are this period's
      ["2026-11-10", A, "10", "-50", "0"],
      ["2026-11-10", "0xb", "15", "15", "15"],
    ],
  );
  proofs.set("p2", new Map([[A, p("90")], ["0xb", p("0", "30", "30")]]));
  assert.throws(() => periodPayouts(roots, proofs), /decreased/);
});

// ---------------------------------------------------------------------------------------------
// Time-weighted stake, participation, APR

const ev = (event: StakingEvent["event"], time: number, x: Partial<StakingEvent> = {}): StakingEvent => ({
  event,
  block: time,
  time,
  tx: "0x",
  logIndex: 0,
  staker: null,
  validator: null,
  withdrawalId: null,
  amount: 0n,
  isRegistered: null,
  newDelay: null,
  ...x,
});

test("stake is weighted by the exact seconds held, carried in, while registered", () => {
  const V = "0xv";
  const S = "0xs";
  const D = "0xd";
  const period = { from: 1000, to: 2000 };
  const events = [
    ev("validator_updated", 0, { validator: V, isRegistered: true }),
    ev("deposit", 100, { staker: S, validator: V, amount: 10n }), // carried into the period
    ev("deposit", 1200, { staker: D, validator: V, amount: 4n }), // intra-period
    ev("withdrawal_requested", 1500, { staker: S, validator: V, amount: 6n }), // leaves at once
    ev("validator_updated", 1800, { validator: V, isRegistered: false }), // deregistered
    ev("deposit", 100, { staker: "0xz", validator: "0xw", amount: 5n }),
    ev("withdrawal_requested", 900, { staker: "0xz", validator: "0xw", amount: 5n }), // zero before the period
  ].sort((a, b) => a.time - b.time);
  // S is V's registered staker from 1300 on.
  const pairs = periodStake(events, period, [{ validator: V, staker: S, time: 1300 }]);
  const s = pairs.get(`${S}:${V}`)!;
  assert.equal(s.all, 10n * 500n + 4n * 500n);
  assert.equal(s.registered, 10n * 500n + 4n * 300n);
  assert.equal(s.self, 10n * 200n + 4n * 300n);
  const d = pairs.get(`${D}:${V}`)!;
  assert.deepEqual([d.all, d.registered, d.self], [4n * 800n, 4n * 600n, 0n]);
  assert.equal(pairs.has("0xz:0xw"), false, "zero stake in the period");
  const v = byValidator(pairs).get(V)!;
  assert.equal(v.registered, s.registered + d.registered);
  assert.equal(v.stakers, 2);
});

test("reward participation counts attested transactions completed in the period, to the settlement block", () => {
  const c = (sid: string, completedBlock: number, attestedBlock: number | null, purpose: Ceremony["purpose"], shares: [string, boolean][]): Ceremony => ({
    sid,
    groupId: "g",
    epoch: 0,
    initiatedBlock: 0,
    completedBlock,
    completedTx: null,
    selectionRoot: "r",
    purpose,
    attestedBlock,
    shares: new Map(shares.map(([m, s]) => [m, s ? "0xtx" : null])),
    unrecognised: [],
  });
  const times = new Map([[1, 1000], [2, 1500], [3, 2000], [4, 2001]]);
  const ceremonies = [
    c("a", 1, 1, "transaction", [["x", true], ["y", false]]), // at the start: counts
    c("b", 2, 2, "transaction", [["x", true], ["y", true]]),
    c("c", 3, 9, "transaction", [["x", true]]), // at the end, attested after settlement: excluded
    c("d", 3, 3, "epoch_rollover", [["x", true]]), // not a transaction
    c("e", 4, 4, "transaction", [["x", true]]), // after the period
    c("f", 3, null, "other", [["x", true]]),
  ];
  const r = rewardParticipation(ceremonies, times, { from: 1000, to: 2000 }, 8);
  assert.equal(r.transactions, 2);
  assert.equal(r.signed.get("x"), 2);
  assert.equal(r.signed.get("y"), 1);
});

test("APR annualizes rewards over stake-seconds with 365 days, without compounding", () => {
  // 192,307.69 SAFE on an average of 56,394,566.79 SAFE over two weeks: 8.89%
  const rewards = 192307692307692307691807n;
  const avg = 56394566789283150000000000n;
  const a = apr(rewards, avg * 1209600n)!;
  assert.ok(Math.abs(a - ((192307.692307692307691807 / 56394566.78928315) * (365 / 14) * 100)) < 1e-9);
  assert.equal(apr(1n, 0n), null);
  assert.deepEqual(completedPeriods(1793059200 + 1209600 - 1), [{ from: 1791849600, to: 1793059200 }]);
});

// ---------------------------------------------------------------------------------------------
// Recorded data and queries

test("recorded splits reproduce the published payouts of every address exactly", async () => {
  const data = await loadValidatorRewards();
  assert.ok(data.split_checks?.length, "no verified period");
  for (const c of data.split_checks!) {
    const payouts = (data.payouts ?? []).filter((p) => p.rewards_until === c.rewards_until);
    const splits = new Map(data.splits.filter((s) => s.rewards_until === c.rewards_until).map((s) => [s.address, s]));
    for (const p of payouts) {
      const s = splits.get(p.address);
      const sum = s ? BigInt(s.stake_reward) + BigInt(s.commission) + BigInt(s.sentinel_grant) : 0n;
      assert.equal(sum, BigInt(p.payout), p.address);
      if (s) assert.equal(BigInt(s.sentinel_grant), BigInt(p.sentinel), p.address);
    }
    const ends = periodEnds(data.roots);
    const i = ends.findIndex((r) => r.rewards_until === c.rewards_until);
    const delta = (k: "token_total" | "sentinel_token_total") => BigInt(ends[i][k] ?? "0") - BigInt(ends[i - 1][k] ?? "0");
    assert.equal(BigInt(c.stake_rewards) + BigInt(c.commission) + BigInt(c.sentinel_grants), delta("token_total"));
    assert.equal(BigInt(c.sentinel_grants), delta("sentinel_token_total"));
    assert.equal(BigInt(c.stake_rewards) + BigInt(c.commission) + BigInt(c.unpaid), BigInt(c.budget));
    const vs = (data.validator_periods ?? []).filter((v) => v.rewards_until === c.rewards_until);
    assert.equal(vs.reduce((a, v) => a + BigInt(v.commission), 0n), BigInt(c.commission));
    for (const v of vs) assert.equal(v.eligible, v.signed / v.transactions >= 0.75, v.validator);
  }
});

test("the first Aegis period is recorded as published on chain", async () => {
  const data = await loadValidatorRewards();
  const p = periodEnds(data.roots).find((r) => r.rewards_until === "2026-10-27T00:00:00.000Z");
  assert.ok(p, "2026-10-27 not recorded");
  assert.equal(p!.merkle_root, "0xab638c08ac00981fb708a6d9e0c4667605579aa945629231313ba6c87d1d711e");
  assert.equal(p!.cid, "bafybeibncjvxsa22w64cnpv43pr6zzhggnlkoe3hldpfxwjosex5oxz2em");
  assert.equal(p!.token_total, "4723064697884593348124545");
});

test("the reward breakdown query is generated from dune/data/validator-rewards.json", async () => {
  const data = await loadValidatorRewards();
  assert.equal(await readFile(REWARD_BREAKDOWN_SQL_PATH, "utf8"), rewardBreakdownSql(data));
  const sql = rewardBreakdownSql(data);
  // exact amounts: stake rewards = payouts minus Sentinel grants
  assert.ok(sql.includes("cast('192307692307692307691807' as uint256)"));
  assert.ok(sql.includes("cast('30769230769230769230768' as uint256)"));
  assert.ok(sql.length < 100_000, "the generated query stays small (per-address payouts stay in the JSON)");
});

test("APR uses staking rewards only: Sentinel grants are excluded from every numerator", async () => {
  const q = await read("staking_rewards_apr");
  assert.ok(q.includes("cast(p.stake_rewards_raw as double) / 1e18 as stake_rewards"));
  assert.ok(!/payout_raw\) as double\) \/ 1e18 as stake_rewards/.test(q));
  for (const key of ["staking_rewards_apr", "staking_rewards_apr_by_validator"]) {
    const s = await read(key);
    assert.ok(s.includes("365.0 * 86400"), `${key}: 365-day annualization`);
    assert.ok(!/sentinel_raw\) as double\) \/ 1e18 \/|sentinel_grants \//.test(s), `${key}: Sentinel grants in an APR`);
  }
  const b = await read("staking_rewards_apr_by_validator");
  assert.ok(b.includes("if(verified and avg_delegated_stake > 0, 100 * delegator_reward / avg_delegated_stake"), "delegator APR only from a verified split");
});

test("stake is time-weighted from events, never daily snapshots", async () => {
  const q = await read("staking_period_stake");
  assert.ok(q.includes("{{query:staking_events}}"));
  assert.ok(!q.includes("staking_daily") && !q.includes("validator_stake_daily"));
  assert.ok(q.includes("cast(1793059200 as bigint)") && q.includes("1209600"), "two-week periods from 2026-10-13");
  const v = await read("staking_period_validators");
  assert.ok(v.includes("boundary_block + 48"), "settlement 48 Gnosis blocks after the period end");
  assert.ok(v.includes(">= 0.75"), "participation threshold");
});

test("APR panels are scheduled, the models are not, and the headline reads the latest published period", async () => {
  for (const key of ["staking_period_stake", "staking_period_validators", "safenet_reward_breakdown"]) assert.equal((await meta(key)).refresh, "none", key);
  for (const key of ["staking_rewards_apr", "staking_rewards_apr_by_validator"]) assert.equal((await meta(key)).refresh, "daily", key);
  const h = (await meta("staking_rewards_apr")).visualizations.headline;
  assert.equal(h.type, "counter");
  assert.equal(h.options.counterColName, "pool_apr");
  assert.equal(h.options.rowNumber, 1);
  assert.ok((await read("staking_rewards_apr")).includes("order by is_published desc, period_end desc"));
});

test("the APR panels are on the Staking and Validators dashboards, never on safe/safenet-staking", async () => {
  const staking = await readFile(`${DEFAULT_ROOT}/dashboards/staking.yaml`, "utf8");
  for (const v of ["staking_rewards_apr/headline", "staking_rewards_apr/history", "staking_rewards_apr/table", "staking_rewards_apr_by_validator/bars", "staking_rewards_apr_by_validator/table"])
    assert.ok(staking.includes(`visualization: ${v}`), v);
  assert.match(staking, /^slug: safenet-staking-withdrawals$/m);
  assert.ok((await readFile(`${DEFAULT_ROOT}/dashboards/validators.yaml`, "utf8")).includes("visualization: staking_rewards_apr_by_validator/table"));
});
