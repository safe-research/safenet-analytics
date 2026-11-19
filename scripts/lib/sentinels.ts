// Independent recount of Sentinel participation, fees and bonds from Gnosis Chain RPC logs. It
// mirrors dune/queries/safenet_sentinel_terms and safenet_sentinel_responses in TypeScript
// (docs/metrics/sentinels.md), on top of the request records of ./recount.ts.

import { EVENTS } from "../../src/safenet.ts";
import { status, topicAddress, word, type Log, type RequestRecord } from "./recount.ts";

export type Term = { sentinel: string; scheduledBlock: number; activeFromBlock: number; removedBlock: number | null };

// Membership terms from SentinelScheduled and SentinelRemoved (SentinelMap.sol). A term ends at the
// first removal at or after its scheduling and before the Sentinel's next scheduling.
export function buildTerms(oracleLogs: Log[]): Term[] {
  const scheduled = oracleLogs.filter((l) => l.topics[0] === EVENTS.SentinelScheduled.topic0);
  const removed = oracleLogs.filter((l) => l.topics[0] === EVENTS.SentinelRemoved.topic0);
  return scheduled.map((s) => {
    const sentinel = topicAddress(s.topics[1]);
    const block = Number(s.blockNumber);
    const next = scheduled
      .filter((x) => topicAddress(x.topics[1]) === sentinel && Number(x.blockNumber) > block)
      .map((x) => Number(x.blockNumber))
      .sort((a, b) => a - b)[0];
    const end = removed
      .filter((r) => topicAddress(r.topics[1]) === sentinel && Number(r.blockNumber) >= block && (next === undefined || Number(r.blockNumber) < next))
      .map((r) => Number(r.blockNumber))
      .sort((a, b) => a - b)[0];
    return { sentinel, scheduledBlock: block, activeFromBlock: Number(word(s.data, 0)), removedBlock: end ?? null };
  });
}

export type TermStatus = "active" | "scheduled" | "removed";
export function termStatus(t: Term, asOfBlock: number): TermStatus {
  if (t.removedBlock !== null) return "removed";
  return asOfBlock >= t.activeFromBlock ? "active" : "scheduled";
}

// Current status of a Sentinel: that of its latest term.
export function currentStatus(terms: Term[], sentinel: string, asOfBlock: number): TermStatus | undefined {
  const latest = terms.filter((t) => t.sentinel === sentinel).sort((a, b) => b.scheduledBlock - a.scheduledBlock)[0];
  return latest && termStatus(latest, asOfBlock);
}

// Eligible: a member during the request's commit window.
export const isEligible = (terms: Term[], sentinel: string, r: Pick<RequestRecord, "proposedBlock" | "commitDeadline">) =>
  terms.some((t) => t.sentinel === sentinel && t.activeFromBlock <= r.commitDeadline && (t.removedBlock === null || t.removedBlock > r.proposedBlock));

export type ResponseState =
  | "secure"
  | "insecure"
  | "missing_response"
  | "reverted_commit"
  | "no_commit"
  | "pending_reveal"
  | "pending_commit";

export type Response = {
  request: RequestRecord;
  sentinel: string;
  eligible: boolean;
  state: ResponseState;
  windowClosed: boolean;
  valid: boolean;
  committed: boolean;
  bond: bigint;
  claimed: boolean;
  bondReturned: bigint;
  feeRewardClaimed: bigint;
  feeRewardAccrued: bigint;
  slashDue: bigint;
  slashReason: "missing_response" | "dispute_lost" | null;
  // Unix times: the commit, the first claim, and when the slash was taken (null without a slash).
  committedAt: number | null;
  claimedAt: number | null;
  slashAt: number | null;
};

// One response per (request, Sentinel) where the Sentinel was eligible or committed, as of asOfBlock.
// revertedCommits: `${requestId}:${sentinel}` of reverted commit calls (traces). Without it, a
// reverted commit cannot be told from no commit, and both are no_commit.
export function buildResponses(requests: RequestRecord[], terms: Term[], asOfBlock: number, revertedCommits?: Set<string>): Response[] {
  const sentinels = [...new Set(terms.map((t) => t.sentinel))];
  const out: Response[] = [];
  for (const r of requests) {
    const finalized = r.outcome !== null || r.disputed;
    const { completed } = status(r);
    const reveals = r.votes.filter((v) => v.approved !== null);
    const approveVotes = reveals.filter((v) => v.approved).length;
    const denyVotes = reveals.length - approveVotes;
    const winners = completed ? (r.outcome!.verdict === "approved" ? approveVotes : denyVotes) : 0;
    const daoShare = (r.fee * r.daoFeeShare) / 100_000n;
    const committedBy = new Set(r.votes.map((v) => v.sentinel));
    for (const sentinel of new Set([...sentinels.filter((s) => isEligible(terms, s, r)), ...committedBy])) {
      const v = r.votes.find((x) => x.sentinel === sentinel);
      const claims = r.claims.filter((c) => c.sentinel === sentinel);
      let state: ResponseState;
      if (v && v.approved !== null) state = v.approved ? "secure" : "insecure";
      else if (v) state = finalized || asOfBlock > r.revealDeadline ? "missing_response" : "pending_reveal";
      else if (asOfBlock > r.commitDeadline || finalized)
        state = revertedCommits?.has(`${r.requestId}:${sentinel}`) ? "reverted_commit" : "no_commit";
      else state = "pending_commit";
      const won = completed && v?.approved != null && v.approved === (r.outcome!.verdict === "approved") && winners > 0;
      let slashReason: Response["slashReason"] = null;
      if (v && finalized) {
        if (v.approved === null) slashReason = approveVotes + denyVotes > 0 ? "missing_response" : null;
        else if (r.outcome?.event === "DisputeResolved" && approveVotes > 0 && denyVotes > 0 && v.approved !== (r.outcome.verdict === "approved"))
          slashReason = "dispute_lost";
      }
      out.push({
        request: r,
        sentinel,
        eligible: isEligible(terms, sentinel, r),
        state,
        windowClosed: state !== "pending_reveal" && state !== "pending_commit",
        valid: state === "secure" || state === "insecure",
        committed: !!v,
        bond: v?.bond ?? 0n,
        claimed: claims.length > 0,
        bondReturned: claims.reduce((s, c) => s + c.bondReturn, 0n),
        feeRewardClaimed: claims.reduce((s, c) => s + c.feeReward, 0n),
        feeRewardAccrued: won ? (r.fee - daoShare) / BigInt(winners) : 0n,
        slashDue: slashReason ? r.slashAmount : 0n,
        slashReason,
        committedAt: v?.committedAt ?? null,
        claimedAt: claims.length ? Math.min(...claims.map((c) => c.time ?? Infinity)) : null,
        // A missing response is slashed at finalize (the freeze, or the outcome); a dispute loser at the ruling.
        slashAt: slashReason === "dispute_lost" ? r.outcome!.time : slashReason ? (r.disputedAt ?? r.outcome?.time ?? null) : null,
      });
    }
  }
  return out;
}

// A request's response window has closed: it has an outcome or a dispute, or the reveal deadline passed.
export const requestWindowClosed = (r: RequestRecord, asOfBlock: number) => r.outcome !== null || r.disputed || asOfBlock > r.revealDeadline;

// Per-Sentinel totals as shown in sentinel_overview (Charter-chain requests) and sentinel_bonds and
// sentinel_earnings (every request).
export function sentinelTotals(responses: Response[], sentinel: string) {
  const all = responses.filter((x) => x.sentinel === sentinel);
  const cov = all.filter((x) => x.request.covered);
  const count = (s: ResponseState) => cov.filter((x) => x.state === s).length;
  const eligible = cov.filter((x) => x.eligible && x.windowClosed).length;
  const validEligible = cov.filter((x) => x.eligible && x.windowClosed && x.valid).length;
  const committed = all.filter((x) => x.committed);
  const sum = (xs: Response[], f: (x: Response) => bigint) => xs.reduce((s, x) => s + f(x), 0n);
  return {
    eligible_requests: eligible,
    commits: cov.filter((x) => x.committed).length,
    valid_reveals: cov.filter((x) => x.valid).length,
    participation_rate: eligible > 0 ? validEligible / eligible : null,
    secure: count("secure"),
    insecure: count("insecure"),
    no_commit: count("no_commit"),
    reverted_commit: count("reverted_commit"),
    missing_responses: count("missing_response"),
    pending: count("pending_commit") + count("pending_reveal"),
    fee_accrued: sum(all, (x) => x.feeRewardAccrued),
    fee_claimed: sum(all, (x) => x.feeRewardClaimed),
    posted: sum(committed, (x) => x.bond),
    locked: sum(committed.filter((x) => !x.claimed), (x) => x.bond - x.slashDue),
    unclaimed_commitments: committed.filter((x) => !x.claimed).length,
    returned: sum(committed, (x) => x.bondReturned),
    slashed_confirmed: sum(committed.filter((x) => x.claimed), (x) => x.bond - x.bondReturned),
    slashed_unclaimed: sum(committed.filter((x) => !x.claimed), (x) => x.slashDue),
    slash_rule_mismatches: committed.filter((x) => x.claimed && x.bond - x.bondReturned !== x.slashDue).length,
  };
}

// ---------------------------------------------------------------------------------------------
// Realized APR per reward period (sentinel_apr). Independent of the SQL's segment approach: the
// average of a step function over [from, to) is Σ delta × (to − max(t, from)) ÷ (to − from) over the
// changes before `to`, given that the balance before the first change is 0.

export type CapitalChange = { sentinel: string; kind: "locked" | "wallet"; t: number; delta: bigint };

// Bonds held by the oracle: + bond at the commit, − slash when taken, − (bond − slash) at the claim.
export function lockedChanges(responses: Response[]): CapitalChange[] {
  const out: CapitalChange[] = [];
  for (const x of responses) {
    if (!x.committed || x.committedAt === null) continue;
    out.push({ sentinel: x.sentinel, kind: "locked", t: x.committedAt, delta: x.bond });
    if (x.slashDue > 0n && x.slashAt !== null) out.push({ sentinel: x.sentinel, kind: "locked", t: x.slashAt, delta: -x.slashDue });
    if (x.claimedAt !== null) out.push({ sentinel: x.sentinel, kind: "locked", t: x.claimedAt, delta: -(x.bond - x.slashDue) });
  }
  return out;
}

// Average balance over [from, to), in base units.
export function timeWeighted(changes: CapitalChange[], sentinel: string, kind: CapitalChange["kind"], from: number, to: number): number {
  let sum = 0;
  for (const c of changes)
    if (c.sentinel === sentinel && c.kind === kind && c.t < to) sum += Number(c.delta) * (to - Math.max(c.t, from));
  return sum / (to - from);
}

// Fee rewards accrued on requests decided in [from, to), and slashes taken in it, in base units.
export function periodFlows(responses: Response[], sentinel: string, from: number, to: number) {
  let fees = 0n;
  let slashed = 0n;
  for (const x of responses.filter((y) => y.sentinel === sentinel)) {
    const decided = x.request.outcome?.time;
    if (decided !== undefined && decided >= from && decided < to) fees += x.feeRewardAccrued;
    if (x.slashAt !== null && x.slashAt >= from && x.slashAt < to) slashed += x.slashDue;
  }
  return { fees, slashed };
}

// APR in percent from one period's return and average capital (null without capital).
export const apr = (ret: number | null, capital: number, days = 14) => (ret === null || !(capital > 0) ? null : (ret / capital) * (365 / days) * 100);
