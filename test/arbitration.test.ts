import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  arbitrationState,
  hoursToRuling,
  openHours,
  percentile,
  PRODUCTION_START,
  rateDaily,
  rateWindows,
  resolution,
} from "../scripts/lib/arbitration.ts";
import type { RequestRecord } from "../scripts/lib/recount.ts";

const H = 3600;
const D = 24 * H;
const NOW = Date.parse("2026-11-20T12:00:00Z") / 1000;

type Outcome = RequestRecord["outcome"];
const outcome = (event: string, time: number, verdict: "approved" | "denied" | "no_verdict" = "no_verdict"): Outcome => ({
  verdict,
  event,
  time,
  tx: "0xtx",
  slashed: 0n,
});

let id = 0;
const req = (over: Partial<RequestRecord> = {}) => ({
  requestId: `0x${(++id).toString(16)}`,
  safeTxHash: "0xsafetx",
  covered: true,
  proposedAt: NOW - H,
  disputed: false,
  disputedAt: null,
  outcome: null,
  ...over,
});
const disputed = (proposedAt: number, frozenAt: number, end: Outcome = null) =>
  req({ proposedAt, disputed: true, disputedAt: frozenAt, outcome: end });

describe("arbitration state", () => {
  test("maps each disputed request to exactly one state, by its latest event", () => {
    assert.equal(arbitrationState(req()), null);
    assert.equal(arbitrationState(req({ outcome: outcome("OracleResult", NOW, "approved") })), null);
    assert.equal(arbitrationState(disputed(NOW - 2 * H, NOW - H)), "awaiting");
    assert.equal(arbitrationState(disputed(0, 0, outcome("DisputeResolved", 1, "approved"))), "ruled_secure");
    assert.equal(arbitrationState(disputed(0, 0, outcome("DisputeResolved", 1, "denied"))), "ruled_insecure");
    assert.equal(arbitrationState(disputed(0, 0, outcome("DisputeOutOfScope", 1))), "out_of_scope");
    assert.equal(arbitrationState(disputed(0, 0, outcome("ArbitrationTimedOut", 1))), "timed_out");
  });
});

describe("arbitration rate by proposal-time window", () => {
  test("a window without requests has no rate, not 0%", () => {
    const rows = rateWindows([req({ proposedAt: NOW - 10 * D })], NOW);
    const day = rows.find((r) => r.time_window === "Last 24 hours")!;
    assert.equal(day.requests, 0);
    assert.equal(day.arbitrated, 0);
    assert.equal(day.arbitration_rate, null);
    assert.equal(rows.find((r) => r.time_window === "Last 30 days")!.arbitration_rate, 0);
  });

  test("counts each request once, repeated proposals of one Safe transaction separately, in their latest state", () => {
    const requests = [
      // The same Safe transaction proposed twice (two epochs): two requests, one of them disputed.
      req({ safeTxHash: "0xsame", proposedAt: NOW - 2 * D }),
      disputed(NOW - 2 * D, NOW - 2 * D + H, outcome("DisputeResolved", NOW - D, "denied")),
      disputed(NOW - 3 * D, NOW - 3 * D + H), // awaiting
      disputed(NOW - 3 * D, NOW - 3 * D + H, outcome("DisputeOutOfScope", NOW - D)),
      disputed(NOW - 4 * D, NOW - 4 * D + H, outcome("ArbitrationTimedOut", NOW - D)),
      disputed(NOW - 5 * D, NOW - 5 * D + H, outcome("DisputeResolved", NOW - D, "approved")),
      req({ proposedAt: NOW - H }), // still voting
    ];
    requests[1].safeTxHash = "0xsame";
    const week = rateWindows(requests, NOW).find((r) => r.time_window === "Last 7 days")!;
    assert.deepEqual(week, {
      time_window: "Last 7 days",
      requests: 7,
      arbitrated: 5,
      arbitration_rate: 5 / 7,
      awaiting: 1,
      ruled_secure: 1,
      ruled_insecure: 1,
      out_of_scope: 1,
      timed_out: 1,
      still_voting: 2,
    });
    // The arbitrated states add up to the arbitrated requests.
    assert.equal(week.awaiting + week.ruled_secure + week.ruled_insecure + week.out_of_scope + week.timed_out, week.arbitrated);
  });

  test("selects cohorts by proposal time, not dispute or ruling time, and excludes test traffic", () => {
    const requests = [
      disputed(NOW - 40 * D, NOW - 2 * H, outcome("DisputeResolved", NOW - H, "approved")), // proposed 40 days ago
      req({ covered: false, proposedAt: NOW - H, disputed: true, disputedAt: NOW - H }), // other chain
      req({ proposedAt: PRODUCTION_START - D }), // before production
    ];
    const rows = rateWindows(requests, NOW);
    assert.equal(rows.find((r) => r.time_window === "Last 30 days")!.arbitrated, 0);
    assert.deepEqual(
      rows.map((r) => [r.time_window, r.requests, r.arbitrated]),
      [
        ["Last 24 hours", 0, 0],
        ["Last 7 days", 0, 0],
        ["Last 30 days", 0, 0],
        ["Production, all time", 1, 1],
      ],
    );
  });

  test("daily rows cover every UTC proposal day, zero-request days without a rate", () => {
    const first = Date.parse("2026-11-17T08:00:00Z") / 1000;
    const rows = rateDaily([disputed(first, first + H), req({ proposedAt: first + 2 * D })], NOW);
    assert.deepEqual(
      rows.map((r) => [r.day, r.requests, r.arbitrated, r.arbitration_rate]),
      [
        ["2026-11-17", 1, 1, 1],
        ["2026-11-18", 0, 0, null],
        ["2026-11-19", 1, 0, 0],
        ["2026-11-20", 0, 0, null],
      ],
    );
    assert.deepEqual(rateDaily([], NOW), []);
  });
});

describe("resolution time", () => {
  test("percentiles interpolate linearly between closest ranks", () => {
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([7], 0.9), 7);
    assert.equal(percentile([4, 1, 3, 2], 0.5), 2.5);
    assert.ok(Math.abs(percentile([1, 2, 3, 4], 0.9)! - 3.7) < 1e-12);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 0.9), 10);
  });

  test("runs from the freeze (DisputeTriggered) to the ruling; other outcomes have none", () => {
    const ruled = disputed(NOW - 3 * D, NOW - 2 * D, outcome("DisputeResolved", NOW - 2 * D + 30 * H, "denied"));
    assert.equal(hoursToRuling(ruled), 30);
    assert.equal(hoursToRuling(disputed(0, 0, outcome("DisputeOutOfScope", 5 * H))), null);
    assert.equal(hoursToRuling(disputed(0, 0, outcome("ArbitrationTimedOut", 5 * H))), null);
    assert.equal(hoursToRuling(disputed(NOW - D, NOW - D)), null);
    assert.equal(openHours(disputed(NOW - D, NOW - 10 * H), NOW), 10);
    assert.equal(openHours(ruled, NOW), null);
  });

  test("no ruled cases gives no statistics, and timeouts and out-of-scope never count as rulings", () => {
    const requests = [
      disputed(NOW - 5 * D, NOW - 5 * D, outcome("DisputeOutOfScope", NOW - 4 * D)),
      disputed(NOW - 40 * D, NOW - 39 * D, outcome("ArbitrationTimedOut", NOW - 11 * D)),
      disputed(NOW - 2 * D, NOW - 36 * H), // awaiting, 36 hours
      disputed(NOW - D, NOW - 6 * H), // awaiting, 6 hours
    ];
    const [last30] = resolution(requests, NOW);
    assert.deepEqual(last30, {
      time_window: "Ruled in the last 30 days",
      ruled_cases: 0,
      median_hours: null,
      p90_hours: null,
      out_of_scope: 1,
      timed_out: 1,
      open_arbitrations: 2,
      oldest_open_hours: 36,
    });
    assert.equal(resolution([], NOW)[0].oldest_open_hours, null);
  });

  test("windows select ruled cases by ruling time and exclude unresolved and test-traffic cases", () => {
    const ruledAfter = (h: number, end: number) =>
      disputed(end - h * H - D, end - h * H, outcome("DisputeResolved", end, "approved"));
    const requests = [
      ruledAfter(10, NOW - D),
      ruledAfter(20, NOW - 2 * D),
      ruledAfter(30, NOW - 40 * D), // ruled before the 30-day window
      { ...ruledAfter(99, NOW - D), covered: false },
      disputed(NOW - D, NOW - D), // unresolved
    ];
    const [last30, all] = resolution(requests, NOW);
    assert.deepEqual([last30.ruled_cases, last30.median_hours, last30.p90_hours], [2, 15, 19]);
    assert.deepEqual([all.ruled_cases, all.median_hours], [3, 20]);
    assert.equal(all.open_arbitrations, 1);
  });
});
