import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { accounting, status, type RequestRecord } from "../scripts/lib/recount.ts";

const base = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  requestId: "0x01",
  safeTxHash: "0x02",
  chainId: 1,
  safe: "0x03",
  epoch: 1n,
  sponsor: "0xsponsor",
  proposedAt: 0,
  proposedBlock: 1,
  proposalTx: "0xp",
  covered: true,
  operational: false,
  fee: 400_000n,
  daoFeeShare: 0n,
  slashAmount: 400_000n,
  votes: [],
  claims: [],
  bondLocked: 0n,
  disputed: false,
  outcome: null,
  attestedAt: null,
  attestationTx: null,
  ...over,
});
const vote = (sentinel: string, approved: boolean | null) => ({ sentinel, approved, time: 1 });
const outcome = (verdict: "approved" | "denied" | "no_verdict", event: string, slashed = 0n) => ({ verdict, event, time: 2, tx: "0xo", slashed });

describe("request status", () => {
  test("unanimous verdicts, timeouts and pending requests", () => {
    assert.deepEqual(status(base({ outcome: outcome("approved", "OracleResult") })), { status: "secure_unanimous", ruling: null, completed: true });
    assert.deepEqual(status(base({ outcome: outcome("denied", "OracleResult") })), { status: "insecure_unanimous", ruling: null, completed: true });
    assert.deepEqual(status(base({ outcome: outcome("no_verdict", "RequestTimedOut") })), { status: "no_verdict", ruling: null, completed: false });
    assert.deepEqual(status(base()), { status: "pending", ruling: null, completed: false });
  });

  test("disputed requests stay disputed after the ruling; only rulings complete them", () => {
    assert.deepEqual(status(base({ disputed: true })), { status: "disputed", ruling: "awaiting", completed: false });
    assert.deepEqual(status(base({ disputed: true, outcome: outcome("approved", "DisputeResolved") })), { status: "disputed", ruling: "secure", completed: true });
    assert.deepEqual(status(base({ disputed: true, outcome: outcome("denied", "DisputeResolved") })), { status: "disputed", ruling: "insecure", completed: true });
    for (const e of ["DisputeOutOfScope", "ArbitrationTimedOut"])
      assert.deepEqual(status(base({ disputed: true, outcome: outcome("no_verdict", e) })), { status: "disputed", ruling: "none", completed: false });
  });
});

describe("fee accounting (SentinelOracleRequests.sol)", () => {
  test("a three-way split sends the remainder to the protocol funds receiver", () => {
    const a = accounting(base({ votes: [vote("a", true), vote("b", true), vote("c", true)], outcome: outcome("approved", "OracleResult") }));
    assert.equal(a.perWinner, 133_333n);
    assert.equal(a.rewardAccrued, 399_999n);
    assert.equal(a.daoCut, 1n);
    assert.equal(a.receiver, 1n);
    assert.equal(a.sponsorRefund, 0n);
    assert.equal(a.rewardAccrued + a.daoCut, 400_000n);
  });

  test("denials pay the Sentinels too", () => {
    const a = accounting(base({ votes: [vote("a", false), vote("b", false)], outcome: outcome("denied", "OracleResult") }));
    assert.equal(a.rewardAccrued, 400_000n);
    assert.equal(a.perWinner, 200_000n);
  });

  test("a timeout refunds the full fee from the fee and pays no rewards", () => {
    const a = accounting(base({ votes: [vote("a", null)], outcome: outcome("no_verdict", "RequestTimedOut") }));
    assert.equal(a.sponsorRefund, 400_000n);
    assert.equal(a.refundFromFee, 400_000n);
    assert.equal(a.rewardAccrued, 0n);
    assert.equal(a.bondSlashed, 0n, "no reveal at all: committers are not slashed");
  });

  test("an arbitrated dispute refunds the sponsor from the loser's slash; winners keep the fee", () => {
    const r = base({
      disputed: true,
      votes: [vote("a", true), vote("b", true), vote("c", false)],
      outcome: outcome("approved", "DisputeResolved", 400_000n),
    });
    const a = accounting(r);
    assert.equal(a.winners, 2);
    assert.equal(a.rewardAccrued, 400_000n);
    assert.equal(a.sponsorRefund, 400_000n);
    assert.equal(a.refundFromSlashes, 400_000n);
    assert.equal(a.refundFromFee, 0n);
    assert.equal(a.receiver, 0n, "slashed 0.4 - fee 0.4 + dao cut 0");
    assert.equal(a.bondSlashed, 400_000n);
  });

  test("a dispute without a ruling refunds from the fee", () => {
    const a = accounting(base({ disputed: true, votes: [vote("a", true), vote("b", false)], outcome: outcome("no_verdict", "ArbitrationTimedOut") }));
    assert.equal(a.refundFromFee, 400_000n);
    assert.equal(a.rewardAccrued, 0n);
  });

  test("a committed but unrevealed vote is slashed to the receiver once others revealed", () => {
    const a = accounting(base({ votes: [vote("a", true), vote("b", null)], outcome: outcome("approved", "OracleResult") }));
    assert.equal(a.bondSlashed, 400_000n);
    assert.equal(a.receiver, 400_000n);
    assert.equal(a.winners, 1);
  });

  test("a DAO share is taken before the split", () => {
    const a = accounting(base({ daoFeeShare: 10_000n, votes: [vote("a", true), vote("b", true)], outcome: outcome("approved", "OracleResult") }));
    assert.equal(a.daoCut, 40_000n);
    assert.equal(a.rewardAccrued, 360_000n);
  });

  test("undecided requests hold their fee", () => {
    assert.equal(accounting(base()).feeHeld, 400_000n);
    assert.equal(accounting(base({ disputed: true })).feeHeld, 400_000n);
  });
});
