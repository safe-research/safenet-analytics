import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Log, RequestRecord } from "../scripts/lib/recount.ts";
import { buildResponses, buildTerms, currentStatus, isEligible, sentinelTotals, type Term } from "../scripts/lib/sentinels.ts";
import { EVENTS } from "../src/safenet.ts";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const C = "0x00000000000000000000000000000000000000cc";
const topic = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const log = (topic0: string, sentinel: string, block: number, data = "0x"): Log => ({
  address: "0xoracle",
  topics: [topic0, topic(sentinel)],
  data,
  blockNumber: String(block),
  transactionHash: `0x${block}`,
  logIndex: "0",
});
const scheduled = (s: string, block: number, activeAt: number) =>
  log(EVENTS.SentinelScheduled.topic0, s, block, `0x${activeAt.toString(16).padStart(64, "0")}`);
const removed = (s: string, block: number) => log(EVENTS.SentinelRemoved.topic0, s, block);

const request = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  requestId: "0x01",
  safeTxHash: "0x02",
  chainId: 1,
  safe: "0x03",
  epoch: 1n,
  sponsor: "0xsponsor",
  proposedAt: 0,
  proposedBlock: 100,
  proposalTx: "0xp",
  covered: true,
  operational: false,
  fee: 400_000n,
  daoFeeShare: 0n,
  slashAmount: 400_000n,
  commitDeadline: 106,
  revealDeadline: 112,
  votes: [],
  claims: [],
  bondLocked: 0n,
  disputed: false,
  disputedAt: null,
  disputedBlock: null,
  disputeTx: null,
  arbitrationDeadline: null,
  outcome: null,
  attestedAt: null,
  attestationTx: null,
  ...over,
});
const BOND = 800_000_000n;
const vote = (sentinel: string, approved: boolean | null) => ({ sentinel, approved, time: 1, bond: BOND });
const outcome = (verdict: "approved" | "denied" | "no_verdict", event: string, slashed = 0n) => ({ verdict, event, time: 2, tx: "0xo", slashed });
const term = (sentinel: string, activeFromBlock: number, removedBlock: number | null = null): Term => ({
  sentinel,
  scheduledBlock: activeFromBlock - 50,
  activeFromBlock,
  removedBlock,
});
const stateOf = (rs: ReturnType<typeof buildResponses>, s: string) => rs.find((x) => x.sentinel === s)?.state;

describe("membership", () => {
  test("terms end at removal; a removal before activation means never active", () => {
    const terms = buildTerms([scheduled(A, 10, 60), scheduled(B, 10, 60), removed(B, 20), scheduled(B, 30, 80)]);
    assert.deepEqual(
      terms.map((t) => [t.sentinel, t.activeFromBlock, t.removedBlock]),
      [
        [A, 60, null],
        [B, 60, 20],
        [B, 80, null],
      ],
    );
    assert.equal(currentStatus(terms, B, 70), "scheduled");
    assert.equal(currentStatus(terms, B, 80), "active");
    assert.equal(currentStatus(terms, A, 59), "scheduled");
  });

  test("eligibility follows membership at the request's commit window", () => {
    const terms = [term(A, 105), term(B, 50, 100), term(C, 107)];
    const r = request();
    assert.equal(isEligible(terms, A, r), true, "active before the commit deadline");
    assert.equal(isEligible(terms, B, r), false, "removed at the proposal block");
    assert.equal(isEligible(terms, C, r), false, "active only after the commit deadline");
  });
});

describe("response states", () => {
  const terms = [term(A, 50), term(B, 50), term(C, 50)];

  test("valid reveals, missing responses and no commits once the windows closed", () => {
    const r = request({ votes: [vote(A, true), vote(B, null)], outcome: outcome("approved", "OracleResult") });
    const rs = buildResponses([r], terms, 200);
    assert.equal(stateOf(rs, A), "secure");
    assert.equal(stateOf(rs, B), "missing_response");
    assert.equal(stateOf(rs, C), "no_commit");
    assert.ok(rs.every((x) => x.windowClosed));
  });

  test("a reverted commit is an invalid submission, not an abstention, when traces are known", () => {
    const r = request({ votes: [vote(A, true)], outcome: outcome("approved", "OracleResult") });
    assert.equal(stateOf(buildResponses([r], terms, 200, new Set([`0x01:${B}`])), B), "reverted_commit");
    assert.equal(stateOf(buildResponses([r], terms, 200, new Set([`0x01:${B}`])), C), "no_commit");
    assert.equal(stateOf(buildResponses([r], terms, 200), B), "no_commit", "without traces");
  });

  test("open windows are pending, not missed", () => {
    const r = request({ votes: [vote(A, null)] });
    assert.equal(stateOf(buildResponses([r], terms, 104), A), "pending_reveal");
    assert.equal(stateOf(buildResponses([r], terms, 104), B), "pending_commit");
    assert.equal(stateOf(buildResponses([r], terms, 110), B), "no_commit", "commit window closed");
    assert.equal(stateOf(buildResponses([r], terms, 110), A), "pending_reveal", "reveal window open");
    assert.equal(stateOf(buildResponses([r], terms, 113), A), "missing_response", "reveal deadline passed, not finalized");
  });

  test("participation rate uses eligible requests with closed windows only", () => {
    const rs = buildResponses(
      [
        request({ requestId: "0x1", votes: [vote(A, true)], outcome: outcome("approved", "OracleResult") }),
        request({ requestId: "0x2", votes: [vote(B, false)], outcome: outcome("denied", "OracleResult") }),
        request({ requestId: "0x3", proposedBlock: 300, commitDeadline: 306, revealDeadline: 312 }),
      ],
      terms,
      200,
    );
    const t = sentinelTotals(rs, A);
    assert.equal(t.eligible_requests, 2);
    assert.equal(t.valid_reveals, 1);
    assert.equal(t.no_commit, 1);
    assert.equal(t.pending, 1);
    assert.equal(t.participation_rate, 0.5);
  });

  test("test traffic is left out of participation but not out of fees", () => {
    const r = request({ covered: false, votes: [vote(A, true)], outcome: outcome("approved", "OracleResult") });
    const t = sentinelTotals(buildResponses([r], terms, 200), A);
    assert.equal(t.eligible_requests, 0);
    assert.equal(t.fee_accrued, 400_000n);
  });
});

describe("fees, bonds and slashes", () => {
  const terms = [term(A, 50), term(B, 50), term(C, 50)];

  test("winners share the fee; the loser of a ruled dispute and a non-revealer are slashed", () => {
    const r = request({
      fee: 400_001n,
      disputed: true,
      votes: [vote(A, true), vote(B, false), vote(C, null)],
      outcome: outcome("approved", "DisputeResolved", 400_000n),
      claims: [{ sentinel: A, bondReturn: BOND, feeReward: 400_001n }],
    });
    const rs = buildResponses([r], terms, 200);
    const by = (s: string) => rs.find((x) => x.sentinel === s)!;
    assert.equal(by(A).feeRewardAccrued, 400_001n);
    assert.equal(by(B).slashReason, "dispute_lost");
    assert.equal(by(C).slashReason, "missing_response");
    assert.equal(by(A).slashDue, 0n);
    const tb = sentinelTotals(rs, B);
    assert.equal(tb.locked, BOND - 400_000n, "the slash already left the bond");
    assert.equal(tb.slashed_unclaimed, 400_000n);
    assert.equal(sentinelTotals(rs, A).slash_rule_mismatches, 0);
  });

  test("no slash without any reveal, after an arbitration timeout, or before finalization", () => {
    const timeout = buildResponses([request({ votes: [vote(A, null)], outcome: outcome("no_verdict", "RequestTimedOut") })], terms, 200);
    assert.equal(timeout.find((x) => x.sentinel === A)!.slashDue, 0n);
    const arbTimeout = buildResponses(
      [request({ disputed: true, votes: [vote(A, true), vote(B, false)], outcome: outcome("no_verdict", "ArbitrationTimedOut") })],
      terms,
      200,
    );
    assert.ok(arbTimeout.every((x) => x.slashDue === 0n));
    const open = buildResponses([request({ votes: [vote(A, true), vote(B, null)] })], terms, 113);
    assert.equal(open.find((x) => x.sentinel === B)!.slashDue, 0n);
  });

  test("claims that differ from the slash rule are counted", () => {
    const r = request({
      votes: [vote(A, true), vote(B, null)],
      outcome: outcome("approved", "OracleResult"),
      claims: [{ sentinel: B, bondReturn: BOND, feeReward: 0n }],
    });
    assert.equal(sentinelTotals(buildResponses([r], terms, 200), B).slash_rule_mismatches, 1);
  });
});
