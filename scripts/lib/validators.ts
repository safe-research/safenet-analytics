// Independent rebuild of Safenet production validator membership and signing participation from
// Gnosis Chain RPC logs, for scripts/verify-validators.ts. It mirrors the rules of
// dune/queries/validator_epochs, validator_membership and validator_ceremonies in TypeScript
// (docs/metrics/validators.md).

import { EVENTS, FROST_COORDINATOR, GENESIS_GROUP_ID, PRODUCTION, VALIDATOR_EVENTS } from "../../src/safenet.ts";
import { type Log, type Rpc, order, topicAddress } from "./recount.ts";

const V = VALIDATOR_EVENTS;
const w = (data: string, i: number) => `0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}`;
const CONSENSUS_WORD = `0x${"0".repeat(24)}${PRODUCTION.consensus.address.slice(2)}`;

export async function fetchValidatorLogs(rpc: Rpc, to: number) {
  const consensus = await rpc.getLogs(
    PRODUCTION.consensus.address,
    [[V.EpochStaged.topic0, EVENTS.TransactionAttested.topic0]],
    PRODUCTION.consensus.deployBlock,
    to,
    50_000,
  );
  const coordinator = await rpc.getLogs(
    FROST_COORDINATOR.address,
    [[V.KeyGenConfirmed.topic0, V.Sign.topic0, V.SignShared.topic0, V.SignCompleted.topic0]],
    FROST_COORDINATOR.deployBlock,
    to,
    50_000,
  );
  return { consensus, coordinator };
}
export type ValidatorLogs = Awaited<ReturnType<typeof fetchValidatorLogs>>;

export type Epoch = { epoch: number; groupId: string; activeFrom: number; activeTo: number | null };
export type Ceremony = {
  sid: string;
  groupId: string;
  epoch: number;
  initiatedBlock: number;
  completedBlock: number | null;
  completedTx: string | null;
  selectionRoot: string | null;
  purpose: "transaction" | "epoch_rollover" | "other";
  // member -> recognised share (tx), or null if the member did not sign under the completed root
  shares: Map<string, string | null>;
  unrecognised: string[]; // members with a share under another root
};

// State up to block `to` (inclusive), with `head` deciding which epochs are active.
export function build(logs: ValidatorLogs, to: number) {
  const consensus = logs.consensus.filter((l) => Number(l.blockNumber) <= to).sort(order);
  const coordinator = logs.coordinator.filter((l) => Number(l.blockNumber) <= to).sort(order);

  const staged = consensus
    .filter((l) => l.topics[0] === V.EpochStaged.topic0)
    .map((l) => ({ epoch: Number(BigInt(l.topics[2])), activeFrom: Number(BigInt(w(l.data, 0))), groupId: w(l.data, 1), sid: w(l.data, 4) }));
  const all = [{ epoch: 0, activeFrom: PRODUCTION.consensus.deployBlock, groupId: GENESIS_GROUP_ID, sid: null as string | null }, ...staged].sort(
    (a, b) => a.activeFrom - b.activeFrom,
  );
  const epochs: Epoch[] = all.map((e, i) => ({ epoch: e.epoch, groupId: e.groupId, activeFrom: e.activeFrom, activeTo: all[i + 1]?.activeFrom ?? null }));
  const activeAt = (block: number) => epochs.filter((e) => e.activeFrom <= block).at(-1);

  const members = new Map<string, Set<string>>();
  const groups = new Set(epochs.map((e) => e.groupId));
  for (const l of coordinator.filter((x) => x.topics[0] === V.KeyGenConfirmed.topic0 && groups.has(x.topics[1]))) {
    if (!members.has(l.topics[1])) members.set(l.topics[1], new Set());
    members.get(l.topics[1])!.add(`0x${l.data.slice(26, 66)}`.toLowerCase());
  }
  const epochOfGroup = new Map<string, number>();
  for (const e of epochs) if (!epochOfGroup.has(e.groupId)) epochOfGroup.set(e.groupId, e.epoch);

  const purposes = new Map<string, Ceremony["purpose"]>();
  for (const l of consensus)
    purposes.set(l.topics[0] === EVENTS.TransactionAttested.topic0 ? w(l.data, 2) : w(l.data, 4), l.topics[0] === EVENTS.TransactionAttested.topic0 ? "transaction" : "epoch_rollover");

  const ceremonies = new Map<string, Ceremony>();
  for (const l of coordinator.filter((x) => x.topics[0] === V.Sign.topic0 && x.topics[1] === CONSENSUS_WORD && members.has(x.topics[2]))) {
    const sid = w(l.data, 0);
    ceremonies.set(sid, {
      sid,
      groupId: l.topics[2],
      epoch: epochOfGroup.get(l.topics[2])!,
      initiatedBlock: Number(l.blockNumber),
      completedBlock: null,
      completedTx: null,
      selectionRoot: null,
      purpose: purposes.get(sid) ?? "other",
      shares: new Map([...members.get(l.topics[2])!].map((m) => [m, null])),
      unrecognised: [],
    });
  }
  for (const l of coordinator.filter((x) => x.topics[0] === V.SignCompleted.topic0)) {
    const c = ceremonies.get(l.topics[1]);
    if (c) Object.assign(c, { completedBlock: Number(l.blockNumber), completedTx: l.transactionHash, selectionRoot: l.topics[2] });
  }
  for (const l of coordinator.filter((x) => x.topics[0] === V.SignShared.topic0)) {
    const c = ceremonies.get(l.topics[1]);
    if (!c || c.selectionRoot === null) continue;
    const m = `0x${l.data.slice(26, 66)}`.toLowerCase();
    if (!c.shares.has(m)) continue;
    if (l.topics[2] === c.selectionRoot) c.shares.set(m, l.transactionHash);
    else c.unrecognised.push(m);
  }

  const memberships = epochs.flatMap((e) => [...(members.get(e.groupId) ?? [])].map((validator) => ({ ...e, validator })));
  return { epochs, members, memberships, activeAt, ceremonies: [...ceremonies.values()] };
}
export type ValidatorState = ReturnType<typeof build>;

// Signed / eligible over completed ceremonies, per validator, for those completed in [from, to).
export function participation(state: ValidatorState, times: Map<number, number>, from: number, to = Infinity) {
  const out = new Map<string, { eligible: number; signed: number; signedTransactions: number }>();
  let transactions = 0;
  for (const c of state.ceremonies) {
    if (c.completedBlock === null) continue;
    const t = times.get(c.completedBlock)!;
    if (t < from || t >= to) continue;
    if (c.purpose === "transaction") transactions++;
    for (const [m, share] of c.shares) {
      const s = out.get(m) ?? { eligible: 0, signed: 0, signedTransactions: 0 };
      s.eligible++;
      if (share) {
        s.signed++;
        if (c.purpose === "transaction") s.signedTransactions++;
      }
      out.set(m, s);
    }
  }
  return { byValidator: out, transactions };
}

export { topicAddress, type Log };
