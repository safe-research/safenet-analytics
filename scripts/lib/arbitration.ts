// Arbitration rates and resolution times, mirroring dune/queries/arbitration_windows,
// arbitration_daily and arbitration_resolution (docs/metrics/sentinels.md#arbitration-rate-and-resolution-time).
//
// Population: requests for Safes on the Charter's chains, as in Network & revenue (operational
// Safes included, other chains excluded as test traffic). Rate cohorts are selected by proposal
// time and each request is judged by its latest state. A request enters arbitration with
// DisputeTriggered, which freezes it (SentinelOracle `finalize`, State.FROZEN); it leaves with
// DisputeResolved (a secure or insecure ruling), DisputeOutOfScope or ArbitrationTimedOut.

import type { RequestRecord } from "./recount.ts";

// Start of the "Production, all time" window, as in network_summary.
export const PRODUCTION_START = Date.parse("2026-10-07T00:00:00Z") / 1000;

export type ArbitrationState = "awaiting" | "ruled_secure" | "ruled_insecure" | "out_of_scope" | "timed_out";

type Req = Pick<RequestRecord, "covered" | "proposedAt" | "disputed" | "disputedAt" | "outcome">;

export function arbitrationState(r: Pick<RequestRecord, "disputed" | "outcome">): ArbitrationState | null {
  if (!r.disputed) return null;
  const o = r.outcome;
  if (!o) return "awaiting";
  if (o.event === "DisputeResolved") return o.verdict === "approved" ? "ruled_secure" : "ruled_insecure";
  if (o.event === "DisputeOutOfScope") return "out_of_scope";
  if (o.event === "ArbitrationTimedOut") return "timed_out";
  throw new Error(`disputed request ended with ${o.event}`);
}

const HOUR = 3600;
const DAY = 24 * HOUR;

// Rate windows, in result order (the overview counter reads "Last 30 days", row 3).
export const RATE_WINDOWS = [
  { label: "Last 24 hours", since: (now: number) => now - DAY },
  { label: "Last 7 days", since: (now: number) => now - 7 * DAY },
  { label: "Last 30 days", since: (now: number) => now - 30 * DAY },
  { label: "Production, all time", since: () => PRODUCTION_START },
] as const;

export type RateCounts = {
  requests: number;
  arbitrated: number;
  arbitration_rate: number | null; // null without requests
  awaiting: number;
  ruled_secure: number;
  ruled_insecure: number;
  out_of_scope: number;
  timed_out: number;
  still_voting: number; // no outcome and no dispute yet: may still enter arbitration
};

export function rateCounts(requests: Req[]): RateCounts {
  const states = requests.map(arbitrationState);
  const n = (s: ArbitrationState) => states.filter((x) => x === s).length;
  const arbitrated = states.filter((x) => x !== null).length;
  return {
    requests: requests.length,
    arbitrated,
    arbitration_rate: requests.length ? arbitrated / requests.length : null,
    awaiting: n("awaiting"),
    ruled_secure: n("ruled_secure"),
    ruled_insecure: n("ruled_insecure"),
    out_of_scope: n("out_of_scope"),
    timed_out: n("timed_out"),
    still_voting: requests.filter((r) => !r.disputed && !r.outcome).length,
  };
}

// One row per window. `now` is the query's execution time (computed_at) in seconds.
export function rateWindows(requests: Req[], now: number) {
  const covered = requests.filter((r) => r.covered);
  return RATE_WINDOWS.map((w) => ({ time_window: w.label, ...rateCounts(covered.filter((r) => r.proposedAt >= w.since(now))) }));
}

const utcDay = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

// One row per UTC proposal day, from the first request's day to `now`'s day, zero days included.
export function rateDaily(requests: Req[], now: number) {
  const covered = requests.filter((r) => r.covered);
  if (!covered.length) return [];
  const first = Math.min(...covered.map((r) => r.proposedAt));
  const rows = [];
  for (let d = Date.parse(`${utcDay(first)}T00:00:00Z`) / 1000; d <= now; d += DAY) {
    const day = utcDay(d);
    const c = rateCounts(covered.filter((r) => utcDay(r.proposedAt) === day));
    rows.push({ day, requests: c.requests, arbitrated: c.arbitrated, arbitration_rate: c.arbitration_rate, still_voting: c.still_voting });
  }
  return rows;
}

// Percentile by linear interpolation between closest ranks (position q·(n−1) in the sorted
// values), as the SQL computes it. null for an empty sample.
export function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (pos - lo) * (s[hi] - s[lo]);
}

// Hours from DisputeTriggered (the freeze) to DisputeResolved; null unless ruled secure or insecure.
export const hoursToRuling = (r: Req) =>
  r.disputed && r.disputedAt !== null && r.outcome?.event === "DisputeResolved" ? (r.outcome.time - r.disputedAt) / HOUR : null;

// Hours since the freeze for a case still awaiting an outcome; null otherwise.
export const openHours = (r: Req, now: number) => (arbitrationState(r) === "awaiting" && r.disputedAt !== null ? (now - r.disputedAt) / HOUR : null);

export const RESOLUTION_WINDOWS = [
  { label: "Ruled in the last 30 days", since: (now: number) => now - 30 * DAY },
  { label: "Ruled since production start", since: () => PRODUCTION_START },
] as const;

// Resolution times of ruled cases, by ruling time. Unresolved cases are excluded; out-of-scope
// outcomes and arbitration timeouts are counted separately and never as rulings. The open
// arbitrations are as of `now`, the same on every row.
export function resolution(requests: Req[], now: number) {
  const cases = requests.filter((r) => r.covered && r.disputed);
  const open = cases.map((r) => openHours(r, now)).filter((h): h is number => h !== null);
  return RESOLUTION_WINDOWS.map((w) => {
    const since = w.since(now);
    const ended = cases.filter((r) => r.outcome && r.outcome.time >= since);
    const hours = ended.map(hoursToRuling).filter((h): h is number => h !== null);
    return {
      time_window: w.label,
      ruled_cases: hours.length,
      median_hours: percentile(hours, 0.5),
      p90_hours: percentile(hours, 0.9),
      max_hours: hours.length ? Math.max(...hours) : null,
      out_of_scope: ended.filter((r) => arbitrationState(r) === "out_of_scope").length,
      timed_out: ended.filter((r) => arbitrationState(r) === "timed_out").length,
      open_arbitrations: open.length,
      oldest_open_hours: open.length ? Math.max(...open) : null,
    };
  });
}
