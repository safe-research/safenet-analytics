// Derives the commission split of one Aegis reward period from public data only, without running the
// reward scripts (docs/metrics/staking.md#commission-split):
//
//   - the published payout of every address (the IPFS rewards DB pinned by ENS, src/rewards-ipfs.ts);
//   - time-weighted stake per (staker, validator) and the validator's self-stake, from the Staking
//     events and ValidatorStakerSet (scripts/lib/rewards-apr.ts periodStake);
//   - the commission beneficiary, from DelegateRegistry SetDelegate / ClearDelegate on Ethereum.
//
// The rules are those of safe-fndn/safenet-staking-scripts `rewards()` (src/safenet.ts): a validator's
// reward R is split pro rata to average stake T; self-stake gets ⌊R·s/T⌋, a delegation ⌊R·d/T⌋ minus
// 5% commission (⌊·×500/10000⌋) if the validator's average self-stake is ≥ 3.5M SAFE, paid to the
// beneficiary. R is the only unknown per validator: it is solved exactly from the payouts of the
// validator's plain delegators, and then every published payout must be reproduced within
// `tolerance` base units, or nothing is recorded. A change of the rules therefore cannot produce a
// wrong split, only no split.

import type { PairStake } from "./rewards-apr.ts";

export const MIN_SELF_STAKE = 3_500_000n * 10n ** 18n;
export const COMMISSION_BPS = 500n;
export const ZERO = "0x0000000000000000000000000000000000000000";

export type SplitInput = {
  periodSeconds: bigint;
  pairs: Map<string, PairStake>; // `${staker}:${validator}`, stake-seconds
  payouts: Map<string, { payout: bigint; sentinel: bigint }>; // published, per address
  beneficiaries: Map<string, string>; // validator → commission beneficiary
  stakers: Map<string, string>; // validator → registered staker at the period end
  budget: bigint; // the period's validator budget
  unpaid: bigint; // published unpaidAmount
  tolerance?: bigint; // per address, base units
};

export type DerivedValidator = {
  validator: string;
  beneficiary: string;
  avg_stake: bigint;
  avg_self_stake: bigint;
  commission_charged: boolean;
  reward: bigint;
  self_reward: bigint;
  delegator_reward: bigint;
  commission: bigint;
  solved_from: number; // plain delegators the reward was bounded by
  range: bigint; // width of the reward range they allowed
};

export type DerivedSplit = {
  ok: boolean;
  problems: string[];
  validators: DerivedValidator[];
  recipients: Map<string, { stake_reward: bigint; commission: bigint; sentinel_grant: bigint }>;
  max_diff: bigint;
  checked: number;
};

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

// All d with d − ⌊d·bps/10000⌋ = p (one or two values), for a delegation net of commission.
function grossCandidates(p: bigint, charged: boolean): bigint[] {
  if (!charged) return [p];
  const out: bigint[] = [];
  const guess = (p * 10000n) / (10000n - COMMISSION_BPS);
  for (let d = guess - 2n; d <= guess + 3n; d++) if (d >= 0n && d - (d * COMMISSION_BPS) / 10000n === p) out.push(d);
  return out;
}

export function deriveSplit(input: SplitInput): DerivedSplit {
  const L = input.periodSeconds;
  const tolerance = input.tolerance ?? 2n;
  const problems: string[] = [];

  // Averages as the reward scripts compute them: validator totals over the summed stake-seconds,
  // per staker over its own.
  const byValidator = new Map<string, { total: bigint; self: bigint; pairs: PairStake[] }>();
  for (const p of input.pairs.values()) {
    if (p.registered === 0n) continue;
    const v = byValidator.get(p.validator) ?? { total: 0n, self: 0n, pairs: [] };
    v.total += p.registered;
    v.self += p.self;
    v.pairs.push(p);
    byValidator.set(p.validator, v);
  }
  const positions = new Map<string, number>();
  for (const p of input.pairs.values()) if (p.registered > 0n) positions.set(p.staker, (positions.get(p.staker) ?? 0) + 1);
  const special = new Set([...input.beneficiaries.values(), ...input.stakers.values()]);
  const stakePart = (a: string) => {
    const x = input.payouts.get(a);
    return x ? x.payout - x.sentinel : 0n;
  };

  const validators: DerivedValidator[] = [];
  const ranges = new Map<string, { lo: bigint; hi: bigint }>();
  for (const [validator, v] of byValidator) {
    const T = v.total / L;
    const S = v.self / L;
    const charged = S >= MIN_SELF_STAKE;
    // Plain delegators: one position, no self-stake, not a staker or beneficiary of any validator.
    const plain = v.pairs.filter((p) => p.self === 0n && positions.get(p.staker) === 1 && !special.has(p.staker) && p.registered / L > 0n);
    let lo = 0n;
    let hi: bigint | null = null;
    for (const p of plain) {
      const d = p.registered / L;
      let cLo: bigint | null = null;
      let cHi: bigint | null = null;
      for (const g of grossCandidates(stakePart(p.staker), charged)) {
        // ⌊R·d/T⌋ = g  ⇔  g·T ≤ R·d < (g+1)·T
        const rLo = ceilDiv(g * T, d);
        const rHi = ((g + 1n) * T - 1n) / d;
        cLo = cLo === null || rLo < cLo ? rLo : cLo;
        cHi = cHi === null || rHi > cHi ? rHi : cHi;
      }
      if (cLo === null || cHi === null) {
        problems.push(`${validator}: payout of ${p.staker} is not a delegation net of commission`);
        continue;
      }
      if (cLo > lo) lo = cLo;
      if (hi === null || cHi < hi) hi = cHi;
    }
    if (hi === null || plain.length === 0) {
      problems.push(`${validator}: no plain delegator to solve its reward from`);
      continue;
    }
    if (lo > hi) {
      problems.push(`${validator}: no single reward reproduces its delegators' payouts`);
      continue;
    }
    // Ineligible (participation < 75%): weight 0, so the reward is exactly 0, never a few base units
    // that a payout-preserving trade with another validator could shift onto it.
    if (plain.every((p) => stakePart(p.staker) === 0n)) {
      lo = 0n;
      hi = 0n;
    }
    ranges.set(validator, { lo, hi });
    const beneficiary = input.beneficiaries.get(validator) ?? ZERO;
    validators.push({
      validator,
      beneficiary,
      avg_stake: T,
      avg_self_stake: S,
      commission_charged: charged,
      reward: lo,
      self_reward: 0n,
      delegator_reward: 0n,
      commission: 0n,
      solved_from: plain.length,
      range: hi - lo,
    });
  }

  // Predict every payout with the scripts' rounding, for given validator rewards.
  const derived = new Map(validators.map((x) => [x.validator, x]));
  const predict = (rewards: Map<string, bigint>, totals = false) => {
    const out = new Map<string, { stake: bigint; commission: bigint }>();
    const add = (a: string, stake: bigint, commission: bigint) => {
      const x = out.get(a) ?? { stake: 0n, commission: 0n };
      out.set(a, { stake: x.stake + stake, commission: x.commission + commission });
    };
    for (const x of validators) if (totals) Object.assign(x, { self_reward: 0n, delegator_reward: 0n, commission: 0n });
    for (const p of input.pairs.values()) {
      const x = derived.get(p.validator);
      if (!x || p.registered === 0n || x.avg_stake === 0n) continue;
      const R = rewards.get(p.validator)!;
      const amount = p.registered / L;
      const self = p.self / L;
      const selfReward = (R * self) / x.avg_stake;
      const gross = (R * (amount - self)) / x.avg_stake;
      const c = x.commission_charged ? (gross * COMMISSION_BPS) / 10000n : 0n;
      if (totals) {
        x.self_reward += selfReward;
        x.delegator_reward += gross - c;
        x.commission += c;
      }
      add(p.staker, selfReward + gross - c, 0n);
      if (c > 0n) add(x.beneficiary, 0n, c);
    }
    return out;
  };
  const misfit = (rewards: Map<string, bigint>) => {
    const got = predict(rewards);
    let total = 0n;
    for (const a of new Set([...input.payouts.keys(), ...got.keys()])) {
      const x = got.get(a);
      const d = stakePart(a) - (x ? x.stake + x.commission : 0n);
      total += d < 0n ? -d : d;
    }
    return total;
  };
  // Every R in a validator's [lo, hi] reproduces its plain delegators. The other payouts (its own
  // staker, large and multi-validator holders, beneficiaries) pin R down: coordinate descent over
  // the validators, each R within its range, until every payout is reproduced or nothing improves.
  const solved = new Map(validators.map((x) => [x.validator, x.reward]));
  let current = misfit(solved);
  for (let round = 0; round < 10 && current > 0n; round++) {
    let improved = false;
    for (const x of validators) {
      const { lo, hi } = ranges.get(x.validator)!;
      const last = hi - lo > 10_000n ? lo + 10_000n : hi;
      for (let R = lo; R <= last; R++) {
        if (R === solved.get(x.validator)) continue;
        const trial = new Map(solved).set(x.validator, R);
        const m = misfit(trial);
        if (m < current) {
          solved.set(x.validator, R);
          current = m;
          improved = true;
        }
      }
    }
    if (!improved) {
      // Stalled: two validators may have to move together (a staker on both). Try joint moves of
      // every pair within ±16 base units, inside their ranges.
      const span = 16n;
      for (let i = 0; i < validators.length && !improved; i++)
        for (let j = i + 1; j < validators.length && !improved; j++) {
          const [a, b] = [validators[i].validator, validators[j].validator];
          const [ra, rb] = [ranges.get(a)!, ranges.get(b)!];
          for (let da = -span; da <= span && !improved; da++)
            for (let db = -span; db <= span && !improved; db++) {
              const A = solved.get(a)! + da;
              const B = solved.get(b)! + db;
              if ((da === 0n && db === 0n) || A < ra.lo || A > ra.hi || B < rb.lo || B > rb.hi) continue;
              const trial = new Map(solved).set(a, A).set(b, B);
              const m = misfit(trial);
              if (m < current) {
                solved.set(a, A).set(b, B);
                current = m;
                improved = true;
              }
            }
        }
      if (!improved) break;
    }
  }
  for (const x of validators) x.reward = solved.get(x.validator)!;
  const predicted = predict(solved, true);

  let maxDiff = 0n;
  let checked = 0;
  const addresses = new Set([...input.payouts.keys(), ...predicted.keys()]);
  const recipients: DerivedSplit["recipients"] = new Map();
  let paid = 0n;
  for (const a of addresses) {
    const published = stakePart(a);
    const x = predicted.get(a) ?? { stake: 0n, commission: 0n };
    const diff = published > x.stake + x.commission ? published - x.stake - x.commission : x.stake + x.commission - published;
    if (diff > maxDiff) maxDiff = diff;
    if (diff > tolerance) problems.push(`${a}: published ${published}, derived ${x.stake + x.commission}`);
    checked++;
    paid += published;
    const sentinel = input.payouts.get(a)?.sentinel ?? 0n;
    // Exact by construction: the commission is derived, the stake reward is the rest of the payout.
    if (published + sentinel > 0n)
      recipients.set(a, { stake_reward: published - x.commission, commission: x.commission, sentinel_grant: sentinel });
  }
  if (paid + input.unpaid !== input.budget) problems.push(`staking payouts ${paid} + unpaid ${input.unpaid} != budget ${input.budget}`);
  const rewards = validators.reduce((a, x) => a + x.reward, 0n);
  if (rewards < paid || rewards - paid > BigInt(input.pairs.size) + 10n)
    problems.push(`validator rewards ${rewards} do not cover the payouts ${paid} up to rounding`);

  return { ok: problems.length === 0, problems, validators, recipients, max_diff: maxDiff, checked };
}
