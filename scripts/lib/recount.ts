// Independent recount of Safenet production activity from Gnosis Chain RPC logs, shared by the
// verification scripts. It mirrors the rules of dune/queries/safenet_requests and
// safenet_fee_flows in TypeScript, so Dune results can be checked against the chain without Dune.

import { COVERED_SAFE_CHAINS, EVENTS, FEE_TOKEN, ORACLE_STATE, PRODUCTION, PROTOCOL_FUNDS_RECEIVER } from "../../src/safenet.ts";

export type Log = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  blockTimestamp?: string;
};

export function rpcClient(url: string) {
  let id = 0;
  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      const body = (await res.json().catch(() => ({}))) as { result?: T; error?: { message: string } };
      if (res.ok && body.result !== undefined) return body.result;
      if (attempt >= 4) throw new Error(`${method} failed: ${res.status} ${body.error?.message ?? ""}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  };

  const STEP = 200_000;
  const getLogs = async (address: string, topics: (string | string[] | null)[], from: number, to: number) => {
    const logs: Log[] = [];
    for (let start = from; start <= to; start += STEP) {
      const end = Math.min(start + STEP - 1, to);
      logs.push(
        ...(await call<Log[]>("eth_getLogs", [{ address, topics, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }])),
      );
    }
    return logs.sort(order);
  };

  const times = new Map<number, number>();
  const blockTime = async (log: Pick<Log, "blockNumber" | "blockTimestamp">): Promise<number> => {
    if (log.blockTimestamp) return Number(log.blockTimestamp);
    const n = Number(log.blockNumber);
    let t = times.get(n);
    if (t === undefined) {
      t = Number((await call<{ timestamp: string }>("eth_getBlockByNumber", [`0x${n.toString(16)}`, false])).timestamp);
      times.set(n, t);
    }
    return t;
  };

  const finalized = async () => Number((await call<{ number: string }>("eth_getBlockByNumber", ["finalized", false])).number);

  return { call, getLogs, blockTime, finalized };
}

export type Rpc = ReturnType<typeof rpcClient>;

export const order = (a: Log, b: Log) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex);
export const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
export const word = (data: string, i: number) => BigInt(`0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1)) || "0"}`);
export const topicAddress = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();
export const safeChain = (safeId: string) => Number(BigInt(safeId) >> 160n);
export const safeAddress = (safeId: string) => `0x${safeId.slice(26)}`.toLowerCase();
export const isCovered = (chainId: number) => (COVERED_SAFE_CHAINS as readonly number[]).includes(chainId);
export const ORACLE_TOPIC = `0x${"0".repeat(24)}${PRODUCTION.sentinelOracle.address.slice(2)}`;

// Every log the network & revenue metrics read, up to `to` (inclusive).
export async function fetchSafenetLogs(rpc: Rpc, to: number) {
  const consensus = PRODUCTION.consensus.address;
  const oracle = PRODUCTION.sentinelOracle.address;
  const [proposed, attested, oracleLogs, transfersIn, transfersOut] = await Promise.all([
    rpc.getLogs(consensus, [EVENTS.TransactionProposed.topic0, null, null, ORACLE_TOPIC], PRODUCTION.consensus.deployBlock, to),
    rpc.getLogs(consensus, [EVENTS.TransactionAttested.topic0, null, null, ORACLE_TOPIC], PRODUCTION.consensus.deployBlock, to),
    rpc.getLogs(oracle, [], PRODUCTION.sentinelOracle.deployBlock, to),
    rpc.getLogs(FEE_TOKEN.address, [EVENTS.Transfer.topic0, null, ORACLE_TOPIC], PRODUCTION.sentinelOracle.deployBlock, to),
    rpc.getLogs(FEE_TOKEN.address, [EVENTS.Transfer.topic0, ORACLE_TOPIC], PRODUCTION.sentinelOracle.deployBlock, to),
  ]);
  return { proposed, attested, oracleLogs, transfers: [...transfersIn, ...transfersOut].sort(order) };
}

export type SafenetLogs = Awaited<ReturnType<typeof fetchSafenetLogs>>;

export const upTo = (logs: SafenetLogs, block: number): SafenetLogs => {
  const keep = (l: Log) => Number(l.blockNumber) <= block;
  return {
    proposed: logs.proposed.filter(keep),
    attested: logs.attested.filter(keep),
    oracleLogs: logs.oracleLogs.filter(keep),
    transfers: logs.transfers.filter(keep),
  };
};

// ---------------------------------------------------------------------------------------------
// Request model, mirroring dune/queries/safenet_requests.

export type Status = "secure_unanimous" | "insecure_unanimous" | "disputed" | "no_verdict" | "pending";
export type Ruling = "secure" | "insecure" | "none" | "awaiting" | null;

export type RequestRecord = {
  requestId: string;
  safeTxHash: string;
  chainId: number;
  safe: string;
  epoch: bigint;
  sponsor: string;
  proposedAt: number;
  proposedBlock: number;
  proposalTx: string;
  covered: boolean;
  operational: boolean;
  fee: bigint;
  daoFeeShare: bigint;
  slashAmount: bigint;
  votes: { sentinel: string; approved: boolean | null; time?: number }[]; // null: committed only
  claims: { sentinel: string; bondReturn: bigint; feeReward: bigint }[];
  bondLocked: bigint;
  disputed: boolean;
  outcome: { verdict: "approved" | "denied" | "no_verdict"; event: string; time: number; tx: string; slashed: bigint } | null;
  attestedAt: number | null;
  attestationTx: string | null;
};

export function status(r: Pick<RequestRecord, "disputed" | "outcome">): { status: Status; ruling: Ruling; completed: boolean } {
  const verdict = r.outcome?.verdict;
  const completed = verdict === "approved" || verdict === "denied";
  if (r.disputed)
    return {
      status: "disputed",
      ruling: verdict === "approved" ? "secure" : verdict === "denied" ? "insecure" : verdict === "no_verdict" ? "none" : "awaiting",
      completed,
    };
  if (verdict === "approved") return { status: "secure_unanimous", ruling: null, completed };
  if (verdict === "denied") return { status: "insecure_unanimous", ruling: null, completed };
  if (verdict === "no_verdict") return { status: "no_verdict", ruling: null, completed };
  return { status: "pending", ruling: null, completed };
}

// Fee accounting of one request (SentinelOracleRequests.sol).
export function accounting(r: RequestRecord) {
  const { completed } = status(r);
  const reveals = r.votes.filter((v) => v.approved !== null);
  const commits = r.votes.length;
  const winners = completed ? reveals.filter((v) => v.approved === (r.outcome!.verdict === "approved")).length : 0;
  const daoShare = (r.fee * r.daoFeeShare) / 100_000n;
  const perWinner = winners > 0 ? (r.fee - daoShare) / BigInt(winners) : 0n;
  const rewardAccrued = perWinner * BigInt(winners);
  const daoCut = winners > 0 ? daoShare + ((r.fee - daoShare) % BigInt(winners)) : 0n;
  const nonRevealerSlashed = reveals.length > 0 ? BigInt(commits - reveals.length) * r.slashAmount : 0n;
  const disputeResolved = r.outcome?.event === "DisputeResolved";
  const sponsorRefund = r.outcome?.verdict === "no_verdict" || disputeResolved ? r.fee : 0n;
  const refundFromFee = r.outcome?.verdict === "no_verdict" ? r.fee : 0n;
  const dispSlashed = r.outcome?.slashed ?? 0n;
  return {
    winners,
    perWinner,
    rewardAccrued,
    rewardClaimed: r.claims.reduce((s, c) => s + c.feeReward, 0n),
    daoCut,
    sponsorRefund,
    refundFromFee,
    refundFromSlashes: sponsorRefund - refundFromFee,
    receiver: daoCut + nonRevealerSlashed + (disputeResolved ? dispSlashed - r.fee : 0n),
    bondSlashed: nonRevealerSlashed + dispSlashed,
    bondReturned: r.claims.reduce((s, c) => s + c.bondReturn, 0n),
    feeHeld: r.outcome ? 0n : r.fee,
  };
}

const T = Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [v.topic0, k])) as Record<string, keyof typeof EVENTS>;

// Builds request records from logs. Issues found on the way are returned, not thrown.
export async function buildRequests(rpc: Pick<Rpc, "blockTime">, logs: SafenetLogs, operationalSafes: Set<string>) {
  const issues: string[] = [];
  const byTx = <L extends Log>(ls: L[]) => {
    const m = new Map<string, L[]>();
    for (const l of ls) m.set(l.transactionHash, [...(m.get(l.transactionHash) ?? []), l]);
    return m;
  };
  const newRequests = logs.oracleLogs.filter((l) => l.topics[0] === EVENTS.NewRequest.topic0);
  const requestsByTx = byTx(newRequests);
  const requests = new Map<string, RequestRecord>();
  for (const [tx, ps] of byTx(logs.proposed)) {
    const rs = requestsByTx.get(tx) ?? [];
    if (rs.length !== ps.length) issues.push(`tx ${tx}: ${ps.length} proposals but ${rs.length} oracle requests`);
    for (const [i, p] of ps.entries()) {
      const r = rs[i];
      if (!r) continue;
      const chainId = safeChain(p.topics[2]);
      const safe = safeAddress(p.topics[2]);
      if (requests.has(r.topics[1])) issues.push(`request ${r.topics[1]}: requested more than once`);
      requests.set(r.topics[1], {
        requestId: r.topics[1],
        safeTxHash: p.topics[1],
        chainId,
        safe,
        epoch: word(p.data, 0),
        sponsor: topicAddress(r.topics[2]),
        proposedAt: await rpc.blockTime(p),
        proposedBlock: Number(p.blockNumber),
        proposalTx: tx,
        covered: isCovered(chainId),
        operational: operationalSafes.has(`${chainId}:${safe}`),
        fee: word(r.data, 0),
        daoFeeShare: word(r.data, 2),
        slashAmount: word(r.data, 3),
        votes: [],
        claims: [],
        bondLocked: 0n,
        disputed: false,
        outcome: null,
        attestedAt: null,
        attestationTx: null,
      });
    }
  }
  for (const l of logs.oracleLogs) {
    const name = T[l.topics[0]];
    if (!name || name === "NewRequest" || name.endsWith("Scheduled") || name === "SentinelRemoved") continue;
    const req = requests.get(l.topics[1]);
    if (!req) {
      issues.push(`${name} ${l.transactionHash}: no production request ${l.topics[1]}`);
      continue;
    }
    const time = await rpc.blockTime(l);
    const sentinel = l.topics[2] ? topicAddress(l.topics[2]) : "";
    if (name === "Committed") {
      req.votes.push({ sentinel, approved: null });
      req.bondLocked += word(l.data, 0);
    } else if (name === "Revealed") {
      const v = req.votes.find((x) => x.sentinel === sentinel);
      if (!v) issues.push(`request ${req.requestId}: reveal without commit by ${sentinel}`);
      else Object.assign(v, { approved: word(l.data, 0) === 1n, time });
    } else if (name === "Claimed") {
      req.claims.push({ sentinel, bondReturn: word(l.data, 0), feeReward: word(l.data, 1) });
    } else if (name === "DisputeTriggered") {
      req.disputed = true;
    } else {
      if (req.outcome) issues.push(`request ${req.requestId}: more than one terminal outcome`);
      const verdict =
        name === "OracleResult"
          ? word(l.data, 1) === 1n
            ? "approved"
            : "denied"
          : name === "DisputeResolved"
            ? Number(word(l.data, 0)) === ORACLE_STATE.RESOLVED_APPROVED
              ? "approved"
              : "denied"
            : "no_verdict";
      req.outcome = { verdict, event: name, time, tx: l.transactionHash, slashed: name === "DisputeResolved" ? word(l.data, 1) : 0n };
    }
  }
  // Attestations of approved, undisputed requests (same safeTxHash and epoch).
  const attestations = [];
  for (const l of logs.attested) attestations.push({ log: l, time: await rpc.blockTime(l), chainId: safeChain(l.topics[2]) });
  for (const req of requests.values()) {
    if (req.disputed || req.outcome?.verdict !== "approved") continue;
    const a = attestations.find((x) => x.log.topics[1] === req.safeTxHash && word(x.log.data, 0) === req.epoch);
    if (a) Object.assign(req, { attestedAt: a.time, attestationTx: a.log.transactionHash });
  }
  for (const a of attestations) {
    const matches = [...requests.values()].some((r) => r.attestationTx === a.log.transactionHash);
    if (!matches) issues.push(`attestation ${a.log.transactionHash}: no approved undisputed request`);
  }
  return { requests: [...requests.values()], attestations, issues };
}

// Classifies USDC.e transfers of the oracle like dune/queries/safenet_fee_flows.
export function classifyTransfers(logs: SafenetLogs, requests: RequestRecord[]) {
  const oracle = PRODUCTION.sentinelOracle.address;
  const inTx = new Map<string, { fee: Set<string>; bond: Set<string>; claim: Set<string>; refund: Set<string> }>();
  const get = (tx: string) => {
    let e = inTx.get(tx);
    if (!e) inTx.set(tx, (e = { fee: new Set(), bond: new Set(), claim: new Set(), refund: new Set() }));
    return e;
  };
  for (const r of requests) {
    get(r.proposalTx).fee.add(r.sponsor);
    if (r.outcome && (r.outcome.verdict === "no_verdict" || r.outcome.event === "DisputeResolved")) get(r.outcome.tx).refund.add(r.sponsor);
  }
  for (const l of logs.oracleLogs) {
    if (l.topics[0] === EVENTS.Committed.topic0) get(l.transactionHash).bond.add(topicAddress(l.topics[2]));
    if (l.topics[0] === EVENTS.Claimed.topic0) get(l.transactionHash).claim.add(topicAddress(l.topics[2]));
  }
  return logs.transfers.map((l) => {
    const from = topicAddress(l.topics[1]);
    const to = topicAddress(l.topics[2]);
    const amount = word(l.data, 0);
    const e = inTx.get(l.transactionHash);
    const flow =
      to === oracle
        ? e?.fee.has(from)
          ? "fee_in"
          : e?.bond.has(from)
            ? "bond_in"
            : "unclassified"
        : to === PROTOCOL_FUNDS_RECEIVER
          ? "receiver_out"
          : e?.claim.has(to)
            ? "claim_out"
            : e?.refund.has(to)
              ? "refund_out"
              : "unclassified";
    return { tx: l.transactionHash, block: Number(l.blockNumber), from, to, amount, flow, direction: to === oracle ? "in" : "out" };
  });
}

export const usdc = (base: bigint) => Number(base) / 10 ** FEE_TOKEN.decimals;
