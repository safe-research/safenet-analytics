// Independent replay of the Safenet Staking contract on Ethereum from RPC logs, for
// scripts/verify-staking.ts. It mirrors the contract (safe-research/safenet contracts/src/Staking.sol
// at 4ed5101) and the rules of the staking models (docs/metrics/staking.md) in TypeScript, so the
// Dune results and the contract's own state can be checked against each other.

import { PRODUCTION_START_TIME, STAKING } from "../../src/safenet.ts";
import { type Log, type Rpc, day, order, topicAddress, word } from "./recount.ts";

const E = STAKING.events;
// Default Ethereum RPC for the staking verification. Most free public endpoints refuse this scan
// (archive token required, or 50 to 100 blocks per eth_getLogs); Tenderly's public gateway serves
// archive state and long log ranges. Blockscout's log API was tried and misses logs (a deposit in
// block 25294792), so it is not used. Override with ETHEREUM_RPC_URL or --eth-rpc.
export const DEFAULT_ETH_RPC = "https://gateway.tenderly.co/public/mainnet";
// eth_getLogs block range per request.
export const ETH_LOG_STEP = 250_000;

export type StakingEvent = {
  event: "deposit" | "withdrawal_requested" | "withdrawal_claimed" | "validator_updated" | "delay_changed" | "tokens_recovered";
  block: number;
  time: number;
  tx: string;
  logIndex: number;
  staker: string | null;
  validator: string | null;
  withdrawalId: number | null;
  amount: bigint;
  isRegistered: boolean | null;
  newDelay: bigint | null;
};

export function decodeStakingLog(log: Log, time: number): StakingEvent | null {
  const base = { block: Number(log.blockNumber), time, tx: log.transactionHash.toLowerCase(), logIndex: Number(log.logIndex) };
  const none = { staker: null, validator: null, withdrawalId: null, amount: 0n, isRegistered: null, newDelay: null };
  const t = log.topics;
  switch (t[0]) {
    case E.StakeIncreased.topic0:
      return { ...base, ...none, event: "deposit", staker: topicAddress(t[1]), validator: topicAddress(t[2]), amount: word(log.data, 0) };
    case E.WithdrawalInitiated.topic0:
      return {
        ...base,
        ...none,
        event: "withdrawal_requested",
        staker: topicAddress(t[1]),
        validator: topicAddress(t[2]),
        withdrawalId: Number(BigInt(t[3])),
        amount: word(log.data, 0),
      };
    case E.WithdrawalClaimed.topic0:
      return { ...base, ...none, event: "withdrawal_claimed", staker: topicAddress(t[1]), withdrawalId: Number(BigInt(t[2])), amount: word(log.data, 0) };
    case E.ValidatorUpdated.topic0:
      return { ...base, ...none, event: "validator_updated", validator: topicAddress(t[1]), isRegistered: word(log.data, 0) !== 0n };
    case E.WithdrawDelayChanged.topic0:
      return { ...base, ...none, event: "delay_changed", newDelay: word(log.data, 1) };
    case E.TokensRecovered.topic0:
      return { ...base, ...none, event: "tokens_recovered", amount: word(log.data, 0) };
    default:
      return null;
  }
}

export async function fetchStakingEvents(rpc: Rpc, to: number): Promise<StakingEvent[]> {
  const topics = [Object.values(E).map((e) => e.topic0)];
  const logs = (await rpc.getLogs(STAKING.address, topics, STAKING.deployBlock, to, ETH_LOG_STEP)).sort(order);
  const out: StakingEvent[] = [];
  for (const log of logs) {
    const e = decodeStakingLog(log, await rpc.blockTime(log));
    if (e) out.push(e);
  }
  return out;
}

export type Withdrawal = {
  id: number;
  staker: string;
  validator: string;
  amount: bigint;
  requestedAt: number;
  requestTx: string;
  claimableAt: number;
  claimedAt: number | null;
  claimTx: string | null;
};

export type WithdrawalStatus = "waiting" | "claimable" | "completed";
export const withdrawalStatus = (w: Withdrawal, now: number): WithdrawalStatus =>
  w.claimedAt !== null ? "completed" : w.claimableAt <= now ? "claimable" : "waiting";

export type StakingDay = {
  day: string;
  era: "beta" | "production";
  deposits: bigint;
  withdrawals_requested: bigint;
  withdrawals_completed: bigint;
  active_stake_eod: bigint;
  outstanding_eod: bigint;
  net_flow_cumulative: bigint;
};

export type StakingState = ReturnType<typeof replay>;

// Events are in production from the production Consensus deployment; days from its UTC day.
const PRODUCTION_START = Date.parse(`${PRODUCTION_START_TIME.replace(" ", "T")}Z`) / 1000;
export const era = (time: number) => (time >= PRODUCTION_START ? "production" : "beta");
export const dayEra = (d: string) => (d >= PRODUCTION_START_TIME.slice(0, 10) ? "production" : "beta");

// Applies the events in order, exactly as the contract does, and returns the state after the last
// one plus one row per UTC day from the deployment to `untilTime`.
export function replay(events: StakingEvent[], untilTime: number) {
  const stakes = new Map<string, bigint>(); // `${staker}:${validator}`
  const registered = new Map<string, boolean>();
  const withdrawals = new Map<number, Withdrawal>();
  const issues: string[] = [];
  let delay = 0n;
  let totalStaked = 0n;
  let totalPending = 0n;
  let netFlow = 0n;

  const days = new Map<string, StakingDay>();
  const dayRow = (d: string) => {
    let r = days.get(d);
    if (!r) {
      r = { day: d, era: dayEra(d), deposits: 0n, withdrawals_requested: 0n, withdrawals_completed: 0n, active_stake_eod: 0n, outstanding_eod: 0n, net_flow_cumulative: 0n };
      days.set(d, r);
    }
    return r;
  };

  for (const e of [...events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
    const r = dayRow(day(e.time));
    const key = `${e.staker}:${e.validator}`;
    switch (e.event) {
      case "deposit":
        if (!registered.get(e.validator!)) issues.push(`deposit to unregistered validator ${e.validator} in ${e.tx}`);
        stakes.set(key, (stakes.get(key) ?? 0n) + e.amount);
        totalStaked += e.amount;
        netFlow += e.amount;
        r.deposits += e.amount;
        break;
      case "withdrawal_requested": {
        const have = stakes.get(key) ?? 0n;
        if (have < e.amount) issues.push(`withdrawal ${e.withdrawalId} exceeds stake in ${e.tx}`);
        stakes.set(key, have - e.amount);
        totalStaked -= e.amount;
        totalPending += e.amount;
        r.withdrawals_requested += e.amount;
        withdrawals.set(e.withdrawalId!, {
          id: e.withdrawalId!,
          staker: e.staker!,
          validator: e.validator!,
          amount: e.amount,
          requestedAt: e.time,
          requestTx: e.tx,
          claimableAt: e.time + Number(delay),
          claimedAt: null,
          claimTx: null,
        });
        break;
      }
      case "withdrawal_claimed": {
        const w = withdrawals.get(e.withdrawalId!);
        if (!w || w.staker !== e.staker || w.amount !== e.amount || w.claimedAt !== null)
          issues.push(`claim of withdrawal ${e.withdrawalId} does not match its request (${e.tx})`);
        else if (e.time < w.claimableAt) issues.push(`withdrawal ${e.withdrawalId} claimed before claimable_at (${e.tx})`);
        if (w) Object.assign(w, { claimedAt: e.time, claimTx: e.tx });
        totalPending -= e.amount;
        netFlow -= e.amount;
        r.withdrawals_completed += e.amount;
        break;
      }
      case "validator_updated":
        registered.set(e.validator!, e.isRegistered!);
        break;
      case "delay_changed":
        delay = e.newDelay!;
        break;
      case "tokens_recovered":
        break;
    }
    r.active_stake_eod = totalStaked;
    r.outstanding_eod = totalPending;
    r.net_flow_cumulative = netFlow;
  }

  // Fill days without events, up to the day of `untilTime`.
  const daily: StakingDay[] = [];
  let prev: StakingDay | undefined;
  for (let t = Date.parse(`${STAKING.deployDate}T00:00:00Z`) / 1000; day(t) <= day(untilTime); t += 86_400) {
    const d = day(t);
    const r = days.get(d) ?? {
      day: d,
      era: dayEra(d),
      deposits: 0n,
      withdrawals_requested: 0n,
      withdrawals_completed: 0n,
      active_stake_eod: prev?.active_stake_eod ?? 0n,
      outstanding_eod: prev?.outstanding_eod ?? 0n,
      net_flow_cumulative: prev?.net_flow_cumulative ?? 0n,
    };
    daily.push(r);
    prev = r;
  }

  const positions = [...stakes]
    .filter(([, v]) => v > 0n)
    .map(([k, amount]) => {
      const [staker, validator] = k.split(":");
      return { staker, validator, amount };
    });
  const validatorTotals = new Map<string, bigint>();
  for (const p of positions) validatorTotals.set(p.validator, (validatorTotals.get(p.validator) ?? 0n) + p.amount);
  const stakerTotals = new Map<string, bigint>();
  for (const p of positions) stakerTotals.set(p.staker, (stakerTotals.get(p.staker) ?? 0n) + p.amount);

  return { totalStaked, totalPending, netFlow, delay, registered, positions, validatorTotals, stakerTotals, withdrawals, daily, issues };
}

// SAFE base units (18 decimals) as a decimal number of SAFE, for comparison with Dune doubles.
export const safe = (base: bigint) => Number(base) / 1e18;
