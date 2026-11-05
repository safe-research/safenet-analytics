// Exports the commission split and per-validator rewards of one Aegis reward period, using
// safe-fndn/safenet-staking-scripts' own code. Not run in this repository: copy it into a checkout of
// the reward scripts at a pinned commit and run it there (docs/metrics/staking.md#commission-split):
//
//   git clone https://github.com/safe-fndn/safenet-staking-scripts && cd safenet-staking-scripts
//   git checkout <commit> && npm ci
//   cp <this repo>/scripts/reward-split/export-split.ts . && set -a && . <safenet-data>/config/aegis.env && set +a
//   DATABASE_FILE=/tmp/safenet.aegis.db npm run cmd:index
//   DATABASE_FILE=/tmp/safenet.aegis.db IPFS_GATEWAY_URL=https://ipfs.filebase.io \
//     npx tsx export-split.ts --previousCid=<CID of the rewards DB before the period> > split.json
//
// `npm run sync:validator-rewards` prints the command for every published period without a split.
// Output: the scripts' rewards() and sentinelRewards() payouts per recipient (the same as
// `cmd:rewards --split`), and per validator its validatorStats, participation and the formula's
// intermediate values (src/safenet.ts rewards()). The per-validator breakdown is recomputed here from
// the public stats; `reproduced` reports whether it gives exactly the scripts' payouts per payee.
// scripts/record-reward-split.ts then checks everything against the published payouts.
//
// As in the production export (src/distribution/export.ts), nothing is chosen by the caller: the
// period is the two weeks starting where the previous rewards DB ends (nextRewardsStart), and the
// budget is the Aegis default measured against the previous rewards DB (totalRewardsAmount), which
// includes the catch-up of earlier unpaid amounts. The previous DB is fetched by CID and verified.

import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CID } from "multiformats/cid";
import { parseUnits } from "viem";
import { z } from "zod";
import { AEGIS_PARAMETERS } from "./src/config/aegis.js";
import { fetchRewardsDb } from "./src/distribution/previous.js";
import { MerkleDb, nextRewardsStart } from "./src/merkledb/index.js";
import { Safenet } from "./src/safenet.js";
import { main, rewardsPeriod, sentinelRewardsAmount, totalRewardsAmount } from "./src/utils/args.js";

const isqrt = (n: bigint) => {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
};
const MIN_SELF_STAKE = parseUnits("3500000", 18);
const COMMISSION_BPS = 500n;

main(
  {
    previousCid: z.string().min(1),
    ipfsGatewayUrl: z.string().optional(),
  },
  async (args) => {
    const dir = await mkdtemp(join(tmpdir(), "previous-rewards-db-"));
    let previous: Awaited<ReturnType<typeof fetchRewardsDb>>;
    try {
      // Verified against the CID before anything is read (unpackCar).
      previous = await fetchRewardsDb(CID.parse(args.previousCid), { ipfsGatewayUrl: args.ipfsGatewayUrl }, join(dir, "db"));
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    const period = rewardsPeriod({ rewardPeriodStart: nextRewardsStart(previous.rewardsUntil) });
    const periodArgs = { rewardPeriodStart: period.fromTimestamp, rewardPeriodEnd: period.toTimestamp };
    const budget = await totalRewardsAmount(periodArgs, new MerkleDb({ root: previous.dir }));
    await rm(dir, { recursive: true, force: true });
    const perSentinel = sentinelRewardsAmount(periodArgs);
    const safenet = await Safenet.create({ ...args, ...AEGIS_PARAMETERS });
    const stats = await safenet.validatorStats(period);
    const participation = await safenet.participation(period);
    const official = await safenet.rewards(period, budget, 0n);
    const sentinels = await safenet.sentinelRewards(period, perSentinel);

    // The rewards() formula on the public stats, per validator.
    const validators = Object.keys(stats) as `0x${string}`[];
    const totalStake = validators.reduce((a, v) => a + stats[v].stake.total, 0n);
    const threshold = totalStake / BigInt(validators.length);
    const weight: Record<string, bigint> = {};
    for (const v of validators) {
      if (participation.validators[v] / participation.total < 0.75) {
        weight[v] = 0n;
        continue;
      }
      const s = stats[v].stake.total <= threshold ? stats[v].stake.total : isqrt(threshold * stats[v].stake.total);
      weight[v] = (s * BigInt(participation.validators[v]) * 10n ** 18n) / BigInt(participation.total);
    }
    const totalWeight = Object.values(weight).reduce((a, b) => a + b, 0n);
    const per = Object.fromEntries(
      validators.map((v) => [v, { reward: (budget * weight[v]) / totalWeight, self: 0n, delegator: 0n, commission: 0n }]),
    );
    const pay = new Map<string, { stake: bigint; commission: bigint }>();
    const add = (p: string, stake: bigint, commission: bigint) => {
      const k = p.toLowerCase();
      const c = pay.get(k) ?? { stake: 0n, commission: 0n };
      pay.set(k, { stake: c.stake + stake, commission: c.commission + commission });
    };
    for (const v of validators) {
      if (stats[v].stake.total === 0n) continue;
      for (const [staker, amount] of Object.entries(stats[v].stake.self.stakers)) {
        const r = (per[v].reward * amount) / stats[v].stake.total;
        per[v].self += r;
        add(staker, r, 0n);
      }
    }
    for await (const { staker, amounts } of safenet.staked(period)) {
      for (const { validator, amount } of amounts) {
        const st = stats[validator];
        const delegated = amount - (st.stake.self.stakers[staker] ?? 0n);
        const reward = (per[validator].reward * delegated) / st.stake.total;
        const commission = st.stake.self.amount >= MIN_SELF_STAKE ? (reward * COMMISSION_BPS) / 10000n : 0n;
        per[validator].delegator += reward - commission;
        per[validator].commission += commission;
        add(staker, reward - commission, 0n);
        add(st.beneficiary, 0n, commission);
      }
    }
    const payouts = Object.fromEntries(Object.entries(official.payouts).map(([k, v]) => [k.toLowerCase(), v]));
    const payees = new Set([...Object.keys(payouts), ...[...pay].filter(([, v]) => v.stake + v.commission > 0n).map(([k]) => k)]);
    const reproduced = [...payees].every(
      (k) => (payouts[k]?.stakeRewards ?? 0n) === (pay.get(k)?.stake ?? 0n) && (payouts[k]?.commission ?? 0n) === (pay.get(k)?.commission ?? 0n),
    );

    const s = (v: bigint) => v.toString();
    const out = {
      scripts_commit: execSync("git rev-parse HEAD").toString().trim(),
      previous_cid: args.previousCid,
      period: { start: Number(period.fromTimestamp), end: Number(period.toTimestamp) },
      budget: s(budget),
      unpaid: s(official.unpaid),
      sentinel_per_sentinel: s(perSentinel),
      threshold: s(threshold),
      transactions: participation.total,
      reproduced,
      recipients: Object.fromEntries(
        [...new Set([...Object.keys(payouts), ...Object.keys(sentinels.payouts).map((k) => k.toLowerCase())])].sort().map((k) => {
          const sentinel = Object.entries(sentinels.payouts).find(([a]) => a.toLowerCase() === k)?.[1] ?? 0n;
          return [k, { stake_reward: s(payouts[k]?.stakeRewards ?? 0n), commission: s(payouts[k]?.commission ?? 0n), sentinel_grant: s(sentinel) }];
        }),
      ),
      validators: validators.map((v) => ({
        validator: v.toLowerCase(),
        beneficiary: stats[v].beneficiary.toLowerCase(),
        avg_stake: s(stats[v].stake.total),
        avg_self_stake: s(stats[v].stake.self.amount),
        signed: participation.validators[v] ?? 0,
        transactions: participation.total,
        eligible: weight[v] > 0n,
        commission_charged: stats[v].stake.self.amount >= MIN_SELF_STAKE,
        weight: s(weight[v]),
        reward: s(per[v].reward),
        self_reward: s(per[v].self),
        delegator_reward: s(per[v].delegator),
        commission: s(per[v].commission),
      })),
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  },
);
