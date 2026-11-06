// Published SAFE staking rewards for the Validators and Staking sections. Each published rewards DB
// (latest.json + one proof file per address with its cumulative SAFE amount) is one Merkle root of
// the Ethereum distributor (REWARDS_DISTRIBUTOR in src/safenet.ts); docs/metrics/validators.md#rewards.
//
// Sources, oldest first:
//   - Beta: github.com/safe-fndn/safenet-data assets/rewards, every version of latest.json since the
//     launch reset, up to BETA_REWARDS_REF. The mirror is frozen; it was last updated for Beta.
//   - Aegis: the on-chain record. Every contenthash the ENS name rewards.safenet-gov.eth has pinned
//     (src/rewards-ipfs.ts), fetched from IPFS and verified block by block. A root already known from
//     the git history (the Beta-final DB was pinned first) is not recorded twice.
//
// Rewards are paid to stakers. A validator's registered staker receives its commission and the
// reward on its own stake as one amount; the published files do not split them. The sync derives
// the split from the published payouts and chain data (scripts/lib/derive-split.ts) and records it
// only if it reproduces every published payout; nothing is estimated.
//
// `npm run sync:validator-rewards` refreshes dune/data/validator-rewards.json and regenerates the
// safenet_validator_rewards and safenet_reward_breakdown queries.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_ROOT } from "./config.ts";

export { proofPath, REWARDS_INDEX, REWARDS_SOURCE } from "./sentinel-rewards.ts";

// Last safenet-data commit that changed assets/rewards (Beta period 13, 2026-10-06; then frozen).
export const BETA_REWARDS_REF = "276526f6c0b204fa7d5aa4f788c0b7983b08bc7f";
// Aegis periods: fixed two-week periods from Tuesday 2026-10-13 00:00 UTC, each Tuesday 00:00 to the
// second-next Tuesday 00:00 (Monday 23:59:59 inclusive), known in advance whether published or not
// (safenet-staking-scripts src/utils/sep.ts). The reward scripts publish exactly one such period per
// rewards DB, starting where the previous one ended (src/distribution/export.ts, MerkleDb.distribute).
export const AEGIS_REWARDS_START = "2026-10-13T00:00:00.000Z";
export const BETA_REWARDS_UNTIL = "2026-10-06T00:00:00.000Z";
export const PERIOD_SECONDS = 14 * 86400;
// Aegis validator budget: 5M SAFE over 52 weeks (sep.ts AEGIS_VALIDATOR_REWARDS, AEGIS_REWARDS_DURATION),
// on top of Beta's final tokenTotal (BETA_TOKEN_TOTAL).
export const AEGIS_VALIDATOR_REWARDS = 5_000_000n * 10n ** 18n;
export const AEGIS_REWARDS_DURATION = 52n * 7n * 86400n;
export const BETA_TOKEN_TOTAL = 4499987774807670271201970n;
// Beta: 4.5M SAFE over 13 two-week periods from 2026-04-07 (346,153.846… each), plus earlier unpaid
// amounts, and payouts below 1 SAFE dropped (safenet-staking-scripts before Aegis, src/safenet.ts
// rewards() MIN_PAYOUT; safenet-data reward PRs #20–#39).
export const BETA_REWARDS_START = "2026-04-07T00:00:00.000Z";
export const BETA_PERIOD_REWARDS = 346153846153846153846153n;
export const BETA_MIN_PAYOUT = 10n ** 18n;

// The validator budget of the Aegis period ending at `end`, given the previous period's last root:
// the programme amount due through `end`, minus what earlier roots already allocated to staking
// (safenet-staking-scripts src/utils/args.ts totalRewardsAmount; unpaid amounts roll forward).
export function periodBudget(end: string, previous: Pick<ValidatorRewardRoot, "token_total" | "sentinel_token_total">) {
  const elapsed = BigInt(unixOf(end) - unixOf(AEGIS_REWARDS_START));
  const due = (AEGIS_VALIDATOR_REWARDS * (elapsed > AEGIS_REWARDS_DURATION ? AEGIS_REWARDS_DURATION : elapsed)) / AEGIS_REWARDS_DURATION;
  return due - (BigInt(previous.token_total) - BigInt(previous.sentinel_token_total ?? "0") - BETA_TOKEN_TOTAL);
}
const unixOf = (iso: string) => Date.parse(iso) / 1000;

// The fixed Aegis period ending at `end` (ISO), or an error why a published root is not one: it
// must end on the two-week grid and start where the previous published period ended (Beta's last
// period is followed by the gap week, then the first Aegis period).
export function aegisPeriodOf(end: string, previousEnd: string): { start: string; end: string } {
  const e = unixOf(end);
  const start = e - PERIOD_SECONDS;
  if ((e - unixOf(AEGIS_REWARDS_START)) % PERIOD_SECONDS !== 0 || e <= unixOf(AEGIS_REWARDS_START))
    throw new Error(`published rewardsUntil ${end} is not the end of a two-week Aegis period (Tuesday 00:00 UTC from ${AEGIS_REWARDS_START})`);
  const expectedPrevious = start === unixOf(AEGIS_REWARDS_START) ? unixOf(BETA_REWARDS_UNTIL) : start;
  if (unixOf(previousEnd) !== expectedPrevious)
    throw new Error(`published period ending ${end} does not start where the previous one (${previousEnd}) ended: not exactly one two-week Aegis period`);
  return { start: new Date(start * 1000).toISOString(), end: new Date(e * 1000).toISOString() };
}

// One published root. kind: "period" ends a new reward period (new rewards_until); "reissue"
// republishes the same period (for example KYC releases). Roots before the launch reset
// (the last published index with tokenTotal 0, "Clear rewards of test data for launch") are test
// data and are not recorded.
export type ValidatorRewardRoot = {
  // git: the safenet-data commit; ipfs: the transaction that set the ENS contenthash.
  commit: string;
  published_at: string;
  rewards_until: string;
  merkle_root: string;
  kind: "period" | "reissue";
  token_total: string;
  sentinel_token_total: string | null;
  unpaid_amount: string;
  source?: "git" | "ipfs";
  cid?: string | null; // IPFS CID of the rewards DB (ENS contenthash)
  ens_block?: number | null;
};

// A validator staker address under one root: cumulative SAFE claimable (base units) and the amount
// withheld until KYC, as published.
export type ValidatorRewardEntry = {
  address: string;
  merkle_root: string;
  cumulative_amount: string;
  kyc_amount: string;
  sentinel_amount: string | null;
};

// What one address was allocated in one Aegis period: the change of its published amounts from the
// previous period's last root to this period's last root (re-issues merged), in base units.
//   payout      cumulative + KYC-withheld (a KYC release moves kyc into cumulative: no payout)
//   kyc_amount  withheld until KYC under the period's last root (outstanding, all periods)
//   sentinel    change of the published sentinelAmount: the Sentinel grant in the payout
//   kyc_change  change of kycAmount (> 0: withheld in the period; < 0: released into cumulative)
export type RewardPayout = { rewards_until: string; address: string; payout: string; kyc_amount: string; kyc_change?: string; sentinel: string };

// A verified split of one address's period payout, derived from public data
// (scripts/lib/derive-split.ts). stake_reward + commission + sentinel_grant = the published payout.
export type ValidatorRewardSplit = {
  rewards_until: string;
  address: string;
  stake_reward: string;
  commission: string;
  sentinel_grant: string;
};

// One validator in one verified period, derived with the split.
//   avg_stake / avg_self_stake  time-weighted over the period while registered (base units)
//   reward                      solved from the payouts of its plain delegators (base units)
//   eligible                    reward > 0 (participation ≥ 75%, checked by verify:rewards-apr)
//   reward = self_reward + delegator_reward + commission, up to rounding
export type ValidatorPeriod = {
  rewards_until: string;
  validator: string;
  beneficiary: string;
  avg_stake: string;
  avg_self_stake: string;
  eligible: boolean;
  commission_charged: boolean;
  reward: string;
  self_reward: string;
  delegator_reward: string;
  commission: string;
};

// How a period's split was verified: every published payout reproduced within max_diff base units.
export type SplitCheck = {
  rewards_until: string;
  split_source: string;
  recipients: number;
  payouts_checked: number;
  max_diff: string;
  budget: string;
  unpaid: string;
  stake_rewards: string;
  commission: string;
  sentinel_grants: string;
};

export type ValidatorRewardData = {
  source: string;
  ref: string;
  ens?: { name: string; resolver: string; through_block: number; cids: string[] };
  addresses?: string[]; // validator stakers and beneficiaries whose entries were read (incremental sync)
  stakers: { validator: string; staker: string; era: "beta" | "aegis" }[]; // ValidatorStakerSet
  roots: ValidatorRewardRoot[]; // oldest first
  entries: ValidatorRewardEntry[];
  // Check of the latest root: sum over every published proof file of cumulative + KYC-withheld.
  latest_check: { merkle_root: string; addresses: number; sum_cumulative: string; sum_kyc: string; token_total: string };
  payouts?: RewardPayout[];
  splits: ValidatorRewardSplit[];
  validator_periods?: ValidatorPeriod[];
  split_checks?: SplitCheck[];
};

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ts = (iso: string) => `timestamp ${sqlString(iso.replace("T", " ").replace(/\.\d+Z$|Z$/, ""))}`;
const u256 = (v: string | null) => (v === null ? "cast(null as uint256)" : `cast(${sqlString(v)} as uint256)`);

// The last root of every period, in order (re-issues merged into their period).
export function periodEnds(roots: ValidatorRewardRoot[]) {
  const last = new Map<string, ValidatorRewardRoot>();
  for (const r of roots) last.set(r.rewards_until, r);
  return [...last.values()];
}

// Per-address payouts of every reward period, Beta and Aegis, from the full proofs of each period's
// last root and of the previous period's last root (the first Beta period: from zero, after the launch
// reset). `proofs` maps a merkle root to { address → amounts }.
export function periodPayouts(
  roots: ValidatorRewardRoot[],
  proofs: Map<string, Map<string, { cumulativeAmount: string; kycAmount?: string; sentinelAmount?: string }>>,
  include: (rewardsUntil: string) => boolean = () => true, // the periods to compute (incremental sync)
): RewardPayout[] {
  const ends = periodEnds(roots);
  const out: RewardPayout[] = [];
  for (let i = 0; i < ends.length; i++) {
    const cur = ends[i];
    if (!include(cur.rewards_until)) continue;
    if (cur.rewards_until > AEGIS_REWARDS_START) aegisPeriodOf(cur.rewards_until, ends[i - 1].rewards_until); // exactly one grid period
    const now = proofs.get(cur.merkle_root);
    const before = i === 0 ? new Map() : proofs.get(ends[i - 1].merkle_root);
    if (!now || !before) throw new Error(`payouts for ${cur.rewards_until}: proofs of ${now ? ends[i - 1].merkle_root : cur.merkle_root} missing`);
    const amount = (p?: { cumulativeAmount: string; kycAmount?: string }) => (p ? BigInt(p.cumulativeAmount) + BigInt(p.kycAmount ?? "0") : 0n);
    for (const a of [...before.keys()]) if (!now.has(a)) throw new Error(`${cur.rewards_until}: ${a} dropped from the published proofs`);
    for (const [address, p] of [...now].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const q = before.get(address);
      const payout = amount(p) - amount(q);
      if (payout < 0n) throw new Error(`${cur.rewards_until}: published amount of ${address} decreased`);
      const sentinel = BigInt(p.sentinelAmount ?? "0") - BigInt(q?.sentinelAmount ?? "0");
      const kycChange = BigInt(p.kycAmount ?? "0") - BigInt(q?.kycAmount ?? "0");
      if (payout === 0n && sentinel === 0n && kycChange === 0n) continue;
      out.push({ rewards_until: cur.rewards_until, address, payout: payout.toString(), kyc_amount: p.kycAmount ?? "0", kyc_change: kycChange.toString(), sentinel: sentinel.toString() });
    }
  }
  return out;
}

const header = (data: ValidatorRewardData) =>
  `-- Sources: github.com/${data.source} at commit ${data.ref} (Beta)` +
  (data.ens ? `, then ENS ${data.ens.name} contenthash history to Ethereum block ${data.ens.through_block} (IPFS, ${data.ens.cids.length} CIDs)` : "");

export function validatorRewardsSql(data: ValidatorRewardData): string {
  const order = new Map(data.roots.map((r, i) => [r.merkle_root, i + 1]));
  const rows = [
    ...data.roots.map(
      (r, i) =>
        `    ('root', ${i + 1}, ${r.merkle_root}, ${ts(r.rewards_until)}, ${sqlString(r.kind)}, ${sqlString(r.cid ?? r.commit)}, cast(null as varbinary), ${u256(r.token_total)}, ${u256(r.sentinel_token_total)}, ${u256(r.unpaid_amount)}, cast(null as uint256), cast(null as uint256))`,
    ),
    ...data.entries.map((e) => {
      const r = data.roots[order.get(e.merkle_root)! - 1];
      return `    ('entry', ${order.get(e.merkle_root)}, ${e.merkle_root}, ${ts(r.rewards_until)}, ${sqlString(r.kind)}, ${sqlString(r.cid ?? r.commit)}, ${e.address}, cast(null as uint256), ${u256(e.sentinel_amount)}, cast(null as uint256), ${u256(e.cumulative_amount)}, ${u256(e.kyc_amount)})`;
    }),
  ];
  return `-- Published SAFE staking rewards for validator stakers. Generated by \`npm run sync:validator-rewards\`;
-- do not edit by hand. src/validator-rewards.ts
${header(data)}.
--
-- kind_row = 'root': every published Merkle root since the launch reset (root_order 1 = oldest);
--   root_kind 'period' ends a reward period (rewards_until), 'reissue' republishes it (KYC release).
--   token_total: SAFE (base units) allocated under the root, cumulative over all periods.
--   source_commit: the safenet-data commit (Beta) or the IPFS CID pinned by ENS (Aegis).
-- kind_row = 'entry': a validator staker address (Consensus.ValidatorStakerSet, Beta or Aegis)
--   or a verified commission beneficiary with a proof under the root: cumulative_amount claimable and
--   kyc_amount withheld until KYC, commission and own-stake reward together, as published. No row =
--   nothing published for it.
-- Commission splits: ${data.split_checks?.length ? `verified for ${data.split_checks.map((c) => c.rewards_until.slice(0, 10)).join(", ")} (safenet_reward_breakdown)` : "none recorded"}.

select kind_row, root_order, merkle_root, rewards_until, root_kind, source_commit, address,
    token_total, sentinel_amount, unpaid_amount, cumulative_amount, kyc_amount
from (
    values
${rows.join(",\n")}
) as t (kind_row, root_order, merkle_root, rewards_until, root_kind, source_commit, address,
    token_total, sentinel_amount, unpaid_amount, cumulative_amount, kyc_amount)
`;
}

// Period totals of every Aegis period, from the per-address payouts (base units).
//   kyc_withheld: payouts newly withheld until KYC in the period (increase of an address's kycAmount);
//   the part above the address's Sentinel grant is staking reward (a payout is withheld as a whole).
export function periodTotals(data: ValidatorRewardData) {
  const out = new Map<string, { payout: bigint; sentinel: bigint; kycWithheld: bigint; kycWithheldStake: bigint; addresses: number }>();
  for (const p of data.payouts ?? []) {
    const t = out.get(p.rewards_until) ?? { payout: 0n, sentinel: 0n, kycWithheld: 0n, kycWithheldStake: 0n, addresses: 0 };
    const withheld = BigInt(p.kyc_change ?? "0") > 0n ? BigInt(p.kyc_change ?? "0") : 0n;
    const sentinel = BigInt(p.sentinel);
    t.payout += BigInt(p.payout);
    t.sentinel += sentinel;
    t.kycWithheld += withheld;
    t.kycWithheldStake += withheld > sentinel ? withheld - sentinel : 0n;
    if (BigInt(p.payout) > 0n) t.addresses++;
    out.set(p.rewards_until, t);
  }
  return out;
}

export function rewardBreakdownSql(data: ValidatorRewardData): string {
  const roots = new Map(periodEnds(data.roots).map((r) => [r.rewards_until, r]));
  const splitSource = (until: string) => data.split_checks?.find((c) => c.rewards_until === until)?.split_source ?? "";
  const start = (until: string) => ts(new Date(unixOf(until) * 1000 - PERIOD_SECONDS * 1000).toISOString());
  const periods = [...periodTotals(data)].map(([until, t]) => {
    const c = (data.split_checks ?? []).find((x) => x.rewards_until === until);
    return `    ('period', ${start(until)}, ${ts(until)}, ${roots.get(until)!.merkle_root}, cast(null as varbinary), cast(null as varbinary), ${u256(t.payout.toString())}, ${u256((t.payout - t.sentinel).toString())}, ${u256(t.sentinel.toString())}, ${u256(t.kycWithheld.toString())}, ${u256(t.kycWithheldStake.toString())}, ${t.addresses}, cast(null as uint256), cast(null as uint256), cast(null as boolean), cast(null as boolean), cast(null as uint256), cast(null as uint256), cast(null as uint256), ${c ? u256(c.commission) : "cast(null as uint256)"}, ${c ? sqlString(c.split_source) : "cast(null as varchar)"})`;
  });
  const validators = (data.validator_periods ?? []).map(
    (v) =>
      `    ('validator', ${start(v.rewards_until)}, ${ts(v.rewards_until)}, ${roots.get(v.rewards_until)!.merkle_root}, ${v.validator}, ${v.beneficiary}, cast(null as uint256), cast(null as uint256), cast(null as uint256), cast(null as uint256), cast(null as uint256), cast(null as integer), ${u256(v.avg_stake)}, ${u256(v.avg_self_stake)}, ${v.eligible}, ${v.commission_charged}, ${u256(v.reward)}, ${u256(v.self_reward)}, ${u256(v.delegator_reward)}, ${u256(v.commission)}, ${sqlString(splitSource(v.rewards_until))})`,
  );
  return `-- Aegis reward periods as published, and verified per-validator rewards. Generated by
-- \`npm run sync:validator-rewards\`; do not edit by hand.
-- src/validator-rewards.ts, docs/metrics/staking.md#realized-apr
${header(data)}.
--
-- Periods are the fixed two-week Aegis periods [period_start, period_end): Tuesday 00:00 UTC to the
-- second-next Tuesday 00:00, from 2026-10-13. The sync rejects a published root that is not exactly one.
-- kind_row = 'period': one row per published Aegis period, summed over the per-address payouts (the
--   change of every address's published amounts from the previous period's last root; base units):
--     payout_raw              everything allocated in the period (= change of tokenTotal)
--     stake_rewards_raw       payout minus Sentinel grants: staking rewards and commission
--     sentinel_raw            Sentinel grants (published sentinelAmount); not staking rewards
--     kyc_withheld_raw        newly withheld until KYC; kyc_withheld_stake_raw: its staking part
--     commission_raw          commission, from a verified split (split_source); null otherwise
-- kind_row = 'validator': one row per (period, validator) of a verified split, derived from the
--   published payouts and chain data (scripts/lib/derive-split.ts) and recorded only because it
--   reproduces every published payout (split_source says how many):
--     avg_stake_raw / avg_self_stake_raw  time-weighted over the period while registered
--     eligible                            reward > 0 (participation >= 75%)
--     commission_charged                  avg self-stake >= 3.5M SAFE (5% of delegated rewards)
--     reward_raw = self_reward_raw + delegator_reward_raw (net) + commission_raw (to beneficiary)

select kind_row, period_start, period_end, merkle_root, validator, beneficiary, payout_raw, stake_rewards_raw, sentinel_raw,
    kyc_withheld_raw, kyc_withheld_stake_raw, payout_addresses, avg_stake_raw, avg_self_stake_raw,
    eligible, commission_charged, reward_raw, self_reward_raw, delegator_reward_raw,
    commission_raw, split_source
from (
    values
${[...periods, ...validators].join(",\n") || "    ('none', cast(null as timestamp), cast(null as timestamp), cast(null as varbinary), cast(null as varbinary), cast(null as varbinary), cast(null as uint256), cast(null as uint256), cast(null as uint256), cast(null as uint256), cast(null as uint256), cast(null as integer), cast(null as uint256), cast(null as uint256), cast(null as boolean), cast(null as boolean), cast(null as uint256), cast(null as uint256), cast(null as uint256), cast(null as uint256), cast(null as varchar))"}
) as t (kind_row, period_start, period_end, merkle_root, validator, beneficiary, payout_raw, stake_rewards_raw, sentinel_raw,
    kyc_withheld_raw, kyc_withheld_stake_raw, payout_addresses, avg_stake_raw, avg_self_stake_raw,
    eligible, commission_charged, reward_raw, self_reward_raw, delegator_reward_raw,
    commission_raw, split_source)
where kind_row <> 'none'
`;
}

export const VALIDATOR_REWARDS_PATH = join(DEFAULT_ROOT, "data", "validator-rewards.json");
export const VALIDATOR_REWARDS_SQL_PATH = join(DEFAULT_ROOT, "queries", "safenet_validator_rewards", "query.sql");
export const REWARD_BREAKDOWN_SQL_PATH = join(DEFAULT_ROOT, "queries", "safenet_reward_breakdown", "query.sql");

export async function loadValidatorRewards(path = VALIDATOR_REWARDS_PATH): Promise<ValidatorRewardData> {
  return JSON.parse(await readFile(path, "utf8")) as ValidatorRewardData;
}

export async function writeValidatorRewards(data: ValidatorRewardData) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(VALIDATOR_REWARDS_PATH, `${JSON.stringify(data, null, 2)}\n`);
  await writeFile(VALIDATOR_REWARDS_SQL_PATH, validatorRewardsSql(data));
  await writeFile(REWARD_BREAKDOWN_SQL_PATH, rewardBreakdownSql(data));
}
