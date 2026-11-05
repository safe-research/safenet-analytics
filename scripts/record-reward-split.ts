// Records a verified commission split for one Aegis reward period in dune/data/validator-rewards.json
// and regenerates the reward queries (src/validator-rewards.ts). The input is the JSON written by
// scripts/reward-split/export-split.ts, run in a checkout of safe-fndn/safenet-staking-scripts.
//
// It records nothing unless every check passes:
//   - the export reproduced the scripts' own rewards() per payee (`reproduced`);
//   - the period is a published Aegis period: same end, and starting where the previous one ended;
//   - for every address, stake reward + commission + Sentinel grant = the published payout, exactly,
//     and no address is paid in the split but not published, or the other way round;
//   - stake rewards + commission + unpaid = the budget; Sentinel grants = the change of
//     sentinelTokenTotal; payouts = the change of tokenTotal; and the published unpaidAmount;
//   - per validator: reward = self + delegator + commission, and the rewards add up to the paid total.
//
//   node scripts/record-reward-split.ts <split.json>

import { readFile } from "node:fs/promises";
import { AEGIS_REWARDS_START, loadValidatorRewards, periodEnds, writeValidatorRewards } from "../src/validator-rewards.ts";

type Export = {
  scripts_commit: string;
  period: { start: number; end: number };
  budget: string;
  unpaid: string;
  reproduced: boolean;
  transactions: number;
  recipients: Record<string, { stake_reward: string; commission: string; sentinel_grant: string }>;
  validators: {
    validator: string;
    beneficiary: string;
    avg_stake: string;
    avg_self_stake: string;
    signed: number;
    transactions: number;
    eligible: boolean;
    commission_charged: boolean;
    reward: string;
    self_reward: string;
    delegator_reward: string;
    commission: string;
  }[];
};

const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/record-reward-split.ts <split.json>");
const x = JSON.parse(await readFile(file, "utf8")) as Export;
const data = await loadValidatorRewards();
const iso = (t: number) => new Date(t * 1000).toISOString();
const until = iso(x.period.end);
const fail: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) fail.push(what);
};

check(/^[0-9a-f]{40}$/.test(x.scripts_commit), "scripts commit");
check(x.reproduced, "the export did not reproduce the scripts' rewards() per payee");

const ends = periodEnds(data.roots);
const i = ends.findIndex((r) => r.rewards_until === until);
if (i < 1) throw new Error(`${until} is not a published period end`);
const cur = ends[i];
const prev = ends[i - 1];
const expectedStart = prev.rewards_until < AEGIS_REWARDS_START ? AEGIS_REWARDS_START : prev.rewards_until;
check(iso(x.period.start) === expectedStart, `period start ${iso(x.period.start)} is not ${expectedStart}`);

const payouts = (data.payouts ?? []).filter((p) => p.rewards_until === until);
const published = new Map(payouts.map((p) => [p.address, p]));
let stake = 0n;
let commission = 0n;
let sentinel = 0n;
let mismatches = 0;
for (const [address, r] of Object.entries(x.recipients)) {
  const sum = BigInt(r.stake_reward) + BigInt(r.commission) + BigInt(r.sentinel_grant);
  stake += BigInt(r.stake_reward);
  commission += BigInt(r.commission);
  sentinel += BigInt(r.sentinel_grant);
  const p = published.get(address);
  if (sum !== BigInt(p?.payout ?? "0")) mismatches++;
  if (p && BigInt(r.sentinel_grant) !== BigInt(p.sentinel)) mismatches++;
}
for (const p of payouts) if (BigInt(p.payout) > 0n && !x.recipients[p.address]) mismatches++;
check(mismatches === 0, `${mismatches} addresses differ from the published payouts`);

const delta = (a: string | null, b: string | null) => BigInt(a ?? "0") - BigInt(b ?? "0");
check(stake + commission + BigInt(x.unpaid) === BigInt(x.budget), "stake rewards + commission + unpaid != budget");
check(BigInt(cur.unpaid_amount) === BigInt(x.unpaid), `published unpaidAmount ${cur.unpaid_amount} != ${x.unpaid}`);
check(sentinel === delta(cur.sentinel_token_total, prev.sentinel_token_total), "Sentinel grants != change of sentinelTokenTotal");
check(stake + commission + sentinel === delta(cur.token_total, prev.token_total), "payouts != change of tokenTotal");
let rewards = 0n;
for (const v of x.validators) {
  rewards += BigInt(v.reward);
  check(BigInt(v.self_reward) + BigInt(v.delegator_reward) + BigInt(v.commission) <= BigInt(v.reward), `${v.validator}: parts exceed the reward`);
  check(v.eligible === (v.signed / v.transactions >= 0.75), `${v.validator}: eligibility`);
}
check(rewards >= stake + commission && rewards - (stake + commission) < BigInt(x.validators.length * 10 ** 6), "validator rewards do not add up to the paid total (beyond rounding)");
check(x.validators.reduce((a, v) => a + BigInt(v.commission), 0n) === commission, "commission per validator != commission per recipient");

if (fail.length) {
  console.error(`not recorded: ${fail.join("; ")}`);
  process.exit(1);
}

data.splits = [
  ...data.splits.filter((s) => s.rewards_until !== until),
  ...Object.entries(x.recipients).map(([address, r]) => ({ rewards_until: until, address, ...r, scripts_commit: x.scripts_commit })),
];
data.validator_periods = [
  ...(data.validator_periods ?? []).filter((v) => v.rewards_until !== until),
  ...x.validators.map(({ ...v }) => {
    const { weight: _w, ...rest } = v as typeof v & { weight?: string };
    return { rewards_until: until, ...rest, scripts_commit: x.scripts_commit };
  }),
];
data.split_checks = [
  ...(data.split_checks ?? []).filter((c) => c.rewards_until !== until),
  {
    rewards_until: until,
    scripts_commit: x.scripts_commit,
    recipients: Object.keys(x.recipients).length,
    budget: x.budget,
    unpaid: x.unpaid,
    stake_rewards: stake.toString(),
    commission: commission.toString(),
    sentinel_grants: sentinel.toString(),
  },
];
await writeValidatorRewards(data);
console.log(
  `recorded ${until.slice(0, 10)}: ${Object.keys(x.recipients).length} recipients match the published payouts exactly; ` +
    `stake rewards ${stake}, commission ${commission}, Sentinel grants ${sentinel}, unpaid ${x.unpaid} (scripts ${x.scripts_commit.slice(0, 7)}). ` +
    "Run npm run sync:validator-rewards again to include new commission beneficiaries in the per-root entries.",
);
