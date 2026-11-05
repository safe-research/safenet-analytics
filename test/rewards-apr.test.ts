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
  aegisPeriodOf,
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
  // the first period (Beta here) is paid from zero
  assert.deepEqual(periodPayouts(roots, proofs, (u) => u === "2026-10-06T00:00:00.000Z").map((x) => [x.address, x.payout]), [[A, "100"]]);
  const out = periodPayouts(roots, proofs, (u) => u > "2026-10-13");
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
  // incremental: only the periods asked for, and only their DBs needed (here p1b and p2, not beta)
  const only = periodPayouts(roots, new Map([...proofs].filter(([k]) => k !== "beta")), (u) => u === "2026-11-10T00:00:00.000Z");
  assert.deepEqual(only, out.filter((x) => x.rewards_until === "2026-11-10T00:00:00.000Z"));
  proofs.set("p2", new Map([[A, p("90")], ["0xb", p("0", "30", "30")]]));
  assert.throws(() => periodPayouts(roots, proofs, (u) => u > "2026-10-13"), /decreased/);
});

test("published Aegis roots must be exactly one fixed two-week period, Tuesday to Tuesday", () => {
  assert.deepEqual(aegisPeriodOf("2026-10-27T00:00:00.000Z", "2026-10-06T00:00:00.000Z"), { start: "2026-10-13T00:00:00.000Z", end: "2026-10-27T00:00:00.000Z" });
  assert.deepEqual(aegisPeriodOf("2026-11-10T00:00:00.000Z", "2026-10-27T00:00:00.000Z").start, "2026-10-27T00:00:00.000Z");
  assert.equal(new Date("2026-10-27T00:00:00Z").getUTCDay(), 2, "periods end on a Tuesday 00:00 UTC");
  // a root covering two periods
  assert.throws(() => aegisPeriodOf("2026-11-24T00:00:00.000Z", "2026-10-27T00:00:00.000Z"), /does not start where the previous one/);
  // off the grid
  assert.throws(() => aegisPeriodOf("2026-11-11T00:00:00.000Z", "2026-10-28T00:00:00.000Z"), /not the end of a two-week Aegis period/);
  // a period skipped in the published history
  const p = (c: string) => ({ cumulativeAmount: c, kycAmount: "0" });
  const roots = [root("2026-10-06T00:00:00.000Z", "beta"), root("2026-11-10T00:00:00.000Z", "x")];
  assert.throws(() => periodPayouts(roots, new Map([["beta", new Map([[A, p("1")]])], ["x", new Map([[A, p("2")]])]])), /does not start where/);
});

test("APR attaches published rewards to the fixed period with the same start and end", async () => {
  for (const key of ["staking_rewards_apr", "staking_rewards_apr_by_validator"]) {
    const q = await read(key);
    assert.match(q, /on p\.period_start = [sv]\.period_start and p\.period_end = [sv]\.period_end/, key);
  }
  assert.match(rewardBreakdownSql(await loadValidatorRewards()), /\('period', timestamp '2026-10-13 00:00:00', timestamp '2026-10-27 00:00:00'/);
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
    const delta = (k: "token_total" | "sentinel_token_total") => BigInt(ends[i][k] ?? "0") - BigInt(i === 0 ? "0" : (ends[i - 1][k] ?? "0"));
    assert.equal(BigInt(c.stake_rewards) + BigInt(c.commission) + BigInt(c.sentinel_grants), delta("token_total"));
    assert.equal(BigInt(c.sentinel_grants), delta("sentinel_token_total"));
    // Aegis: payouts + unpaid = budget exactly (Beta's unpaidAmount was recorded inconsistently).
    if (c.rewards_until > "2026-10-13") assert.equal(BigInt(c.stake_rewards) + BigInt(c.commission) + BigInt(c.unpaid), BigInt(c.budget));
    const vs = (data.validator_periods ?? []).filter((v) => v.rewards_until === c.rewards_until);
    assert.equal(vs.reduce((a, v) => a + BigInt(v.commission), 0n), BigInt(c.commission));
    for (const v of vs) assert.equal(v.eligible, BigInt(v.reward) > 0n, v.validator);
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
  // Per-address payouts stay in the JSON: the query grows by a few rows per period, not by addresses.
  const periods = new Set((data.payouts ?? []).map((x) => x.rewards_until)).size;
  assert.ok(sql.length < 8_000 * periods + 10_000, `generated query: ${sql.length} characters for ${periods} periods`);
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

// ---------------------------------------------------------------------------------------------
// Commission split derived from payouts and chain data (scripts/lib/derive-split.ts)

import { deriveSplit, type SplitInput } from "../scripts/lib/derive-split.ts";
import type { PairStake } from "../scripts/lib/rewards-apr.ts";

const E18 = 10n ** 18n;
// A synthetic period paid with the reward scripts' rounding (src/safenet.ts rewards()).
function synthetic({ bps = 500n, threshold = 3_500_000n * E18, minPayout = 0n, tiny = false } = {}) {
  const L = 1209600n;
  const pair = (staker: string, validator: string, avg: bigint, self = 0n): PairStake => ({ staker, validator, all: avg * L, registered: avg * L, self: self * L });
  const pairs = [
    pair("0xs1", "0xv1", 4_000_000n * E18 + 7n, 4_000_000n * E18 + 7n), // v1's staker: commission charged
    pair("0xd1", "0xv1", 1_234_567n * E18 + 89n),
    pair("0xd2", "0xv1", 9_876n * E18 + 5n),
    pair("0xm", "0xv1", 500_000n * E18 + 3n), // on two validators
    pair("0xs2", "0xv2", 1_000_000n * E18, 1_000_000n * E18), // v2: self-stake < 3.5M, no commission
    pair("0xd3", "0xv2", 2_345_678n * E18 + 1n),
    pair("0xm", "0xv2", 700_000n * E18 + 9n),
    pair("0xd4", "0xv3", 3_000_000n * E18), // v3: ineligible
    ...(tiny ? [pair("0xtiny", "0xv1", 5n * E18)] : []), // paid below the minimum payout
  ];
  const R = new Map([["0xv1", 40_000n * E18 + 123_456_789n], ["0xv2", 30_000n * E18 + 987_654_321n], ["0xv3", 0n]]);
  const beneficiaries = new Map([["0xv1", "0xbenef"], ["0xv2", "0xs2"]]); // v1's staker named a delegate
  const T = new Map<string, bigint>();
  const S = new Map<string, bigint>();
  for (const p of pairs) {
    T.set(p.validator, (T.get(p.validator) ?? 0n) + p.registered / L);
    S.set(p.validator, (S.get(p.validator) ?? 0n) + p.self / L);
  }
  const pay = new Map<string, bigint>();
  const add = (a: string, x: bigint) => pay.set(a, (pay.get(a) ?? 0n) + x);
  for (const p of pairs) {
    const r = R.get(p.validator)!;
    const t = T.get(p.validator)!;
    const self = p.self / L;
    add(p.staker, (r * self) / t);
    const gross = (r * (p.registered / L - self)) / t;
    const c = S.get(p.validator)! >= threshold ? (gross * bps) / 10000n : 0n;
    add(p.staker, gross - c);
    if (c > 0n) add(beneficiaries.get(p.validator)!, c);
  }
  for (const [a, x] of pay) if (x < minPayout) pay.delete(a); // dropped, stays unpaid
  const paid = [...pay.values()].reduce((a, b) => a + b, 0n);
  const input: SplitInput = {
    periodSeconds: L,
    pairs: new Map(pairs.map((p) => [`${p.staker}:${p.validator}`, p])),
    payouts: new Map([...pay].map(([a, x]) => [a, { payout: x, sentinel: 0n }])),
    beneficiaries,
    stakers: new Map([["0xv1", "0xs1"], ["0xv2", "0xs2"]]),
    // as the reward scripts: budget = validator rewards + dust; unpaid = budget − payouts (dropped ones included)
    budget: [...R.values()].reduce((a, b) => a + b, 0n) + 77n,
    unpaid: [...R.values()].reduce((a, b) => a + b, 0n) + 77n - paid,
  };
  return { input, R, pay };
}

test("the split is derived from payouts and stake alone, exactly, with the beneficiary's commission", () => {
  const { input, R, pay } = synthetic();
  const d = deriveSplit(input);
  assert.ok(d.ok, d.problems.join("; "));
  assert.equal(d.max_diff, 0n);
  const v = new Map(d.validators.map((x) => [x.validator, x]));
  assert.equal(v.get("0xv3")!.reward, 0n, "ineligible: exactly 0");
  assert.ok(v.get("0xv1")!.commission_charged && !v.get("0xv2")!.commission_charged);
  for (const k of ["0xv1", "0xv2"]) {
    const diff = v.get(k)!.reward - R.get(k)!;
    assert.ok((diff < 0n ? -diff : diff) <= 10n, `${k}: ${diff}`);
  }
  // the beneficiary's whole payout is commission; the staker's is stake reward only
  assert.equal(d.recipients.get("0xbenef")!.commission, pay.get("0xbenef"));
  assert.equal(d.recipients.get("0xbenef")!.stake_reward, 0n);
  assert.equal(d.recipients.get("0xs1")!.commission, 0n);
  for (const [a, x] of d.recipients) assert.equal(x.stake_reward + x.commission + x.sentinel_grant, pay.get(a), a);
});

test("a change of the reward rules gives no split rather than a wrong one", () => {
  for (const changed of [{ bps: 600n }, { threshold: 1_000_000n * E18 }]) {
    const d = deriveSplit(synthetic(changed).input);
    assert.equal(d.ok, false, JSON.stringify(changed, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
  }
  const { input } = synthetic();
  input.unpaid += 1n; // published unpaidAmount inconsistent with the budget (Aegis: exact)
  assert.equal(deriveSplit(input).ok, false);
});

test("the derived split of 2026-10-13 – 10-27 equals the reward scripts' own split", async () => {
  // test/fixtures: safenet-staking-scripts 8401845 rewards(), run once for this period.
  const f = JSON.parse(await readFile(new URL("./fixtures/split-2026-10-27-scripts.json", import.meta.url), "utf8"));
  const data = await loadValidatorRewards();
  const until = "2026-10-27T00:00:00.000Z";
  const splits = new Map(data.splits.filter((s) => s.rewards_until === until).map((s) => [s.address, s]));
  assert.equal(splits.size, Object.keys(f.recipients).length);
  for (const [a, r] of Object.entries(f.recipients) as [string, { stake_reward: string; commission: string; sentinel_grant: string }][]) {
    const s = splits.get(a)!;
    assert.deepEqual([s.stake_reward, s.commission, s.sentinel_grant], [r.stake_reward, r.commission, r.sentinel_grant], a);
  }
  // Per validator: the payouts identify each reward up to a few base units (10^-18 SAFE).
  for (const v of f.validators) {
    const x = data.validator_periods!.find((y) => y.rewards_until === until && y.validator === v.validator)!;
    assert.equal(x.eligible, v.eligible, v.validator);
    assert.equal(x.avg_stake, v.avg_stake, v.validator);
    assert.equal(x.avg_self_stake, v.avg_self_stake, v.validator);
    assert.equal(x.beneficiary, v.beneficiary, v.validator);
    assert.equal(x.commission, v.commission, v.validator);
    for (const k of ["reward", "self_reward", "delegator_reward"] as const) {
      const d = BigInt(x[k]) - BigInt(v[k]);
      assert.ok((d < 0n ? -d : d) <= 5n, `${v.validator} ${k}: ${d}`);
    }
    if (!v.eligible) assert.equal(x.reward, "0");
  }
  const c = data.split_checks!.find((y) => y.rewards_until === until)!;
  assert.equal(c.max_diff, "0");
  assert.equal(c.budget, f.budget);
});

test("with a minimum payout (Beta), dropped payouts below it do not break the derivation", () => {
  const { input, R } = synthetic({ minPayout: E18, tiny: true });
  assert.equal(input.payouts.has("0xtiny"), false, "the tiny payout was dropped");
  const rewards = [...R.values()].reduce((a, b) => a + b, 0n);
  const d = deriveSplit({ ...input, minPayout: E18, budgetCheck: "rewards", budget: rewards, carryMax: 77n });
  assert.ok(d.ok, d.problems.join("; "));
  assert.equal(d.max_diff, 0n);
  assert.equal(d.recipients.has("0xtiny"), false);
  // without knowing the minimum, the dropped payout (0) contradicts the other delegators: no split
  assert.equal(deriveSplit(input).ok, false);
});

test("every Beta period has a derived split that reproduces its published payouts", async () => {
  const data = await loadValidatorRewards();
  const beta = periodEnds(data.roots).filter((r) => r.rewards_until <= "2026-10-06T00:00:00.000Z");
  assert.equal(beta.length, 13);
  for (const r of beta) {
    const c = data.split_checks!.find((x) => x.rewards_until === r.rewards_until);
    assert.ok(c, `${r.rewards_until}: no split`);
    assert.ok(BigInt(c!.max_diff) <= 2n, `${r.rewards_until}: max difference ${c!.max_diff}`);
    // the validator stakers' and beneficiaries' commission is the whole commission
    const v = data.validator_periods!.filter((x) => x.rewards_until === r.rewards_until);
    assert.equal(v.reduce((a, x) => a + BigInt(x.commission), 0n), BigInt(c!.commission));
  }
});
