// Independent recomputation of the realized staking APR (docs/metrics/staking.md#realized-apr), for
// scripts/verify-rewards-apr.ts. It mirrors dune/queries/staking_period_stake,
// staking_period_validators, staking_rewards_apr and staking_rewards_apr_by_validator in TypeScript,
// from RPC logs, with exact integer stake-seconds.

import type { StakingEvent } from "./staking.ts";
import type { Ceremony } from "./validators.ts";

export type Period = { from: number; to: number }; // unix seconds; [from, to)
export const YEAR_SECONDS = 365 * 86400;

// Aegis reward periods (two weeks from 2026-10-13 00:00 UTC) that have ended by `now`.
export function completedPeriods(now: number): Period[] {
  const out: Period[] = [];
  for (let to = 1793059200; to <= now; to += 1209600) out.push({ from: to - 1209600, to });
  return out;
}

// The 13 Beta reward periods: two weeks each from 2026-04-07 to 2026-10-06 (then the gap week).
export function betaPeriods(): Period[] {
  const out: Period[] = [];
  for (let to = 1776729600; to <= 1791244800; to += 1209600) out.push({ from: to - 1209600, to });
  return out;
}
export const isBeta = (p: Period) => p.to <= 1791244800;

export type StakerSet = { validator: string; staker: string; time: number }; // Aegis ValidatorStakerSet

export type PairStake = { staker: string; validator: string; all: bigint; registered: bigint; self: bigint };

const overlap = (a: number, b: number, c: number, d: number) => Math.max(0, Math.min(b, d) - Math.max(a, c));

// Stake-seconds of every (staker, validator) over the period, by the rules of staking_period_stake:
// deposits add and withdrawal requests subtract at their block time; `registered` only while the
// validator is registered in the Staking contract; `self` the registered part while the staker is
// the validator's registered staker. Events must be in chain order.
export function periodStake(events: StakingEvent[], period: Period, stakerSets: StakerSet[]): Map<string, PairStake> {
  const END = 9_999_999_999;
  const registrations = new Map<string, { from: number; to: number; on: boolean }[]>();
  const segments = new Map<string, { from: number; to: number; balance: bigint }[]>();
  const balances = new Map<string, bigint>();
  for (const e of events) {
    if (e.event === "validator_updated") {
      const r = registrations.get(e.validator!) ?? [];
      if (r.length) r[r.length - 1].to = e.time;
      r.push({ from: e.time, to: END, on: !!e.isRegistered });
      registrations.set(e.validator!, r);
    } else if (e.event === "deposit" || e.event === "withdrawal_requested") {
      const k = `${e.staker}:${e.validator}`;
      const b = (balances.get(k) ?? 0n) + (e.event === "deposit" ? e.amount : -e.amount);
      balances.set(k, b);
      const s = segments.get(k) ?? [];
      if (s.length) s[s.length - 1].to = e.time;
      s.push({ from: e.time, to: END, balance: b });
      segments.set(k, s);
    }
  }
  const sets = [...stakerSets].sort((a, b) => a.time - b.time);
  const stakerIntervals = (validator: string) => {
    const s = sets.filter((x) => x.validator === validator);
    return s.map((x, i) => ({ staker: x.staker, from: x.time, to: s[i + 1]?.time ?? END }));
  };
  const out = new Map<string, PairStake>();
  for (const [k, segs] of segments) {
    const [staker, validator] = k.split(":");
    const regs = (registrations.get(validator) ?? []).filter((r) => r.on);
    const own = stakerIntervals(validator).filter((x) => x.staker === staker);
    let all = 0n;
    let registered = 0n;
    let self = 0n;
    for (const s of segs) {
      if (s.balance <= 0n) continue;
      const f = Math.max(s.from, period.from);
      const t = Math.min(s.to, period.to);
      if (t <= f) continue;
      all += s.balance * BigInt(t - f);
      for (const r of regs) {
        const rf = Math.max(f, r.from);
        const rt = Math.min(t, r.to);
        if (rt <= rf) continue;
        registered += s.balance * BigInt(rt - rf);
        for (const o of own) self += s.balance * BigInt(overlap(rf, rt, o.from, o.to));
      }
    }
    if (all > 0n) out.set(k, { staker, validator, all, registered, self });
  }
  return out;
}

// The reward scripts' participation (src/data/attestations.ts): transaction ceremonies completed in
// [from, to] whose attestation is at or before the settlement block; signed = recognised shares.
export function rewardParticipation(ceremonies: Ceremony[], times: Map<number, number>, period: Period, settlementBlock: number) {
  let transactions = 0;
  const signed = new Map<string, number>();
  for (const c of ceremonies) {
    if (c.purpose !== "transaction" || c.completedBlock === null || c.attestedBlock === null) continue;
    const t = times.get(c.completedBlock)!;
    if (t < period.from || t > period.to || c.attestedBlock > settlementBlock) continue;
    transactions++;
    for (const [m, share] of c.shares) if (share) signed.set(m, (signed.get(m) ?? 0) + 1);
  }
  return { transactions, signed };
}

// Realized APR in percent: rewards (base units) over stake-seconds (base units × s), annualized with
// 365 days. Equivalent to rewards / (stake-seconds / period) × 365 d / period × 100.
export const apr = (rewards: bigint, stakeSeconds: bigint) =>
  stakeSeconds > 0n ? (Number(rewards) * YEAR_SECONDS * 100) / Number(stakeSeconds) : null;

export type ValidatorStake = { validator: string; all: bigint; registered: bigint; self: bigint; stakers: number };

export function byValidator(pairs: Map<string, PairStake>): Map<string, ValidatorStake> {
  const out = new Map<string, ValidatorStake>();
  for (const p of pairs.values()) {
    const v = out.get(p.validator) ?? { validator: p.validator, all: 0n, registered: 0n, self: 0n, stakers: 0 };
    v.all += p.all;
    v.registered += p.registered;
    v.self += p.self;
    if (p.registered > 0n) v.stakers++;
    out.set(p.validator, v);
  }
  return out;
}
