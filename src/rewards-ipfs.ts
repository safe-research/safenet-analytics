// Published SAFE rewards from their on-chain source of truth: the `contenthash` of the ENS name
// rewards.safenet-gov.eth pins an IPFS directory (latest.json + proofs/…), and the distributor's
// merkleRoot() must equal that directory's latest.json root. safe-fndn/safenet-data assets/rewards
// was a convenience mirror of it and is no longer updated (the last mirrored root is Beta's
// 2026-10-06 period). This mirrors safe-fndn/safenet-staking-scripts src/distribution/previous.ts.
//
// The directory is fetched as one CAR from an IPFS trustless gateway and verified here: every block
// must hash to its CID (sha256), the CAR's root must be the CID the ENS record pins, and files are
// only read by walking links from that root. A gateway can therefore withhold data but not alter it.
//
// No dependency: CIDs, varints, CARv1, dag-pb and UnixFS (directories, files, raw leaves) are
// decoded below; HAMT-sharded directories are rejected (the rewards DB shards proofs into plain
// directories by address prefix).

import { createHash } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const REWARDS_ENS_NAME = "rewards.safenet-gov.eth";
export const ENS_REGISTRY = "0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e";
export const DEFAULT_IPFS_GATEWAYS = "https://ipfs.filebase.io,https://gateway.pinata.cloud";
// ContenthashChanged(bytes32 indexed node, bytes hash), emitted by ENS public resolvers.
export const CONTENTHASH_CHANGED = "0xe379c1624ed7e714cc0937528a32359d69d5281337765313dba4e081b72d7578";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

export function namehash(name: string): string {
  let node: Uint8Array = new Uint8Array(32);
  for (const label of name.split(".").reverse()) {
    const buf = new Uint8Array(64);
    buf.set(node);
    buf.set(keccak_256(new TextEncoder().encode(label)), 32);
    node = keccak_256(buf);
  }
  return `0x${hex(node)}`;
}

// ---------------------------------------------------------------------------------------------
// CIDs

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of s) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error(`invalid base32 character ${c}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

type Cursor = { buf: Uint8Array; pos: number };
function varint(c: Cursor): number {
  let x = 0;
  let shift = 0;
  for (;;) {
    if (c.pos >= c.buf.length) throw new Error("truncated varint");
    const b = c.buf[c.pos++];
    x += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return x;
    shift += 7;
  }
}

export type Cid = { codec: number; digest: string }; // sha2-256 digest, hex
export const DAG_PB = 0x70;
export const RAW = 0x55;
const SHA2_256 = 0x12;

// Reads a binary CID (v1, or v0 = bare sha2-256 multihash, as dag-pb links may use).
function readCid(c: Cursor): Cid {
  if (c.buf[c.pos] === SHA2_256 && c.buf[c.pos + 1] === 32) {
    c.pos += 2;
    const digest = hex(c.buf.subarray(c.pos, c.pos + 32));
    c.pos += 32;
    return { codec: DAG_PB, digest };
  }
  const version = varint(c);
  if (version !== 1) throw new Error(`unsupported CID version ${version}`);
  const codec = varint(c);
  const mh = varint(c);
  const len = varint(c);
  if (mh !== SHA2_256 || len !== 32) throw new Error(`unsupported multihash 0x${mh.toString(16)}`);
  const digest = hex(c.buf.subarray(c.pos, c.pos + len));
  c.pos += len;
  return { codec, digest };
}

export const cidString = (cid: Cid) => {
  const bytes = [0x01, cid.codec, SHA2_256, 32, ...fromHex(cid.digest)];
  return `b${base32(Uint8Array.from(bytes))}`;
};

export function parseCid(s: string): Cid {
  if (!s.startsWith("b")) throw new Error(`only base32 CIDv1 is supported: ${s}`);
  return readCid({ buf: fromBase32(s.slice(1)), pos: 0 });
}

// ENS contenthash (EIP-1577): 0xe3 01 (ipfs-ns) followed by a binary CIDv1.
export function decodeContenthash(contenthash: string): Cid {
  const buf = fromHex(contenthash);
  const c = { buf, pos: 0 };
  const ns = varint(c);
  if (ns !== 0xe3) throw new Error(`contenthash is not an IPFS namespace: ${contenthash}`);
  return readCid(c);
}

// ABI-decodes `bytes` returned by contenthash() or carried by ContenthashChanged.
export function abiBytes(data: string): string {
  const d = data.replace(/^0x/, "");
  const offset = Number(BigInt(`0x${d.slice(0, 64)}`)) * 2;
  const len = Number(BigInt(`0x${d.slice(offset, offset + 64)}`)) * 2;
  return `0x${d.slice(offset + 64, offset + 64 + len)}`;
}

// ---------------------------------------------------------------------------------------------
// CAR

export type Blocks = Map<string, { codec: number; data: Uint8Array }>; // by digest

// Parses a CARv1 and verifies every block's sha256 against its CID.
export function readCar(car: Uint8Array): { roots: Cid[]; blocks: Blocks } {
  const c = { buf: car, pos: 0 };
  const headerLen = varint(c);
  const header = car.subarray(c.pos, c.pos + headerLen);
  c.pos += headerLen;
  // The header is dag-cbor {roots: [CID], version: 1}; CIDs are tag 42 byte strings (0x00 prefix).
  const roots: Cid[] = [];
  for (let i = 0; i + 1 < header.length; i++) {
    if (header[i] === 0xd8 && header[i + 1] === 0x2a) {
      const h = { buf: header, pos: i + 2 };
      const major = header[h.pos] >> 5;
      if (major !== 2) continue;
      let len = header[h.pos] & 0x1f;
      h.pos++;
      if (len === 24) len = header[h.pos++];
      if (header[h.pos] !== 0) throw new Error("CAR root CID without multibase identity prefix");
      roots.push(readCid({ buf: header.subarray(h.pos + 1, h.pos + len), pos: 0 }));
    }
  }
  if (roots.length === 0) throw new Error("CAR has no root");
  const blocks: Blocks = new Map();
  while (c.pos < car.length) {
    const len = varint(c);
    const end = c.pos + len;
    const cid = readCid(c);
    const data = car.subarray(c.pos, end);
    c.pos = end;
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== cid.digest) throw new Error(`CAR block ${cidString(cid)} does not match its hash`);
    blocks.set(cid.digest, { codec: cid.codec, data });
  }
  return { roots, blocks };
}

// dag-pb PBNode: Links (2) { Hash (1), Name (2), Tsize (3) }, Data (1).
function pbNode(data: Uint8Array) {
  const c = { buf: data, pos: 0 };
  const links: { cid: Cid; name: string }[] = [];
  let unixfs: Uint8Array | undefined;
  while (c.pos < data.length) {
    const key = varint(c);
    if ((key & 7) !== 2) throw new Error("unexpected dag-pb field");
    const len = varint(c);
    const field = data.subarray(c.pos, c.pos + len);
    c.pos += len;
    if (key >> 3 === 1) unixfs = field;
    else if (key >> 3 === 2) {
      const l = { buf: field, pos: 0 };
      let cid: Cid | undefined;
      let name = "";
      while (l.pos < field.length) {
        const k = varint(l);
        if ((k & 7) === 2) {
          const n = varint(l);
          const v = field.subarray(l.pos, l.pos + n);
          l.pos += n;
          if (k >> 3 === 1) cid = readCid({ buf: v, pos: 0 });
          if (k >> 3 === 2) name = new TextDecoder().decode(v);
        } else varint(l);
      }
      if (!cid) throw new Error("dag-pb link without hash");
      links.push({ cid, name });
    }
  }
  // UnixFS Data: Type (1) varint, Data (2) bytes.
  let type = 0;
  let inline: Uint8Array = new Uint8Array(0);
  if (unixfs) {
    const u = { buf: unixfs, pos: 0 };
    while (u.pos < unixfs.length) {
      const k = varint(u);
      if ((k & 7) === 0) {
        const v = varint(u);
        if (k >> 3 === 1) type = v;
      } else if ((k & 7) === 2) {
        const n = varint(u);
        if (k >> 3 === 2) inline = unixfs.subarray(u.pos, u.pos + n);
        u.pos += n;
      } else throw new Error("unexpected UnixFS field");
    }
  }
  return { links, type, inline };
}

const UNIXFS_DIRECTORY = 1;
const UNIXFS_FILE = 2;
const UNIXFS_HAMT = 5;

function readFile(blocks: Blocks, cid: Cid): Uint8Array {
  const b = blocks.get(cid.digest);
  if (!b) throw new Error(`CAR is missing block ${cidString(cid)}`);
  if (cid.codec === RAW) return b.data;
  if (cid.codec !== DAG_PB) throw new Error(`unsupported codec 0x${cid.codec.toString(16)}`);
  const node = pbNode(b.data);
  if (node.type !== UNIXFS_FILE && node.type !== 0) throw new Error(`${cidString(cid)} is not a file`);
  return Buffer.concat([node.inline, ...node.links.map((l) => readFile(blocks, l.cid))]);
}

// Every file under the root, by path relative to it, read only through links from the root.
export function unpack(blocks: Blocks, root: Cid): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (cid: Cid, path: string) => {
    const b = blocks.get(cid.digest);
    if (!b) throw new Error(`CAR is missing block ${cidString(cid)} (${path || "/"})`);
    if (cid.codec === DAG_PB) {
      const node = pbNode(b.data);
      if (node.type === UNIXFS_HAMT) throw new Error(`HAMT-sharded directory at ${path || "/"} is not supported`);
      if (node.type === UNIXFS_DIRECTORY) {
        for (const l of node.links) walk(l.cid, path ? `${path}/${l.name}` : l.name);
        return;
      }
    }
    files.set(path, readFile(blocks, cid));
  };
  walk(root, "");
  return files;
}

// ---------------------------------------------------------------------------------------------
// The rewards DB

export type RewardsIndex = {
  merkleRoot: string;
  rewardsUntil: string;
  tokenTotal: string;
  sentinelTokenTotal?: string;
  unpaidAmount?: string;
};
export type RewardsProof = { cumulativeAmount: string; kycAmount?: string; sentinelAmount?: string; merkleRoot: string };
export type RewardsDb = { cid: string; index: RewardsIndex; proofs: Map<string, RewardsProof> }; // proofs by lowercase address

export function rewardsDbFromCar(car: Uint8Array, cid: string): RewardsDb {
  const expected = parseCid(cid);
  const { roots, blocks } = readCar(car);
  if (roots.length !== 1 || roots[0].digest !== expected.digest || roots[0].codec !== expected.codec)
    throw new Error(`CAR root ${roots.map(cidString).join(",")} is not ${cid}`);
  const files = unpack(blocks, expected);
  const json = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));
  const latest = files.get("latest.json");
  if (!latest) throw new Error(`rewards DB ${cid} has no latest.json`);
  const index = json(latest) as RewardsIndex;
  if (!index.merkleRoot || !index.rewardsUntil || index.tokenTotal === undefined) throw new Error(`rewards DB ${cid}: incomplete latest.json`);
  const proofs = new Map<string, RewardsProof>();
  for (const [path, data] of files) {
    const m = /^proofs\/(?:[0-9a-f]{2}\/){4}(0x[0-9a-fA-F]{40})\.json$/.exec(path);
    if (!m) continue;
    const p = json(data) as RewardsProof;
    if (p.merkleRoot.toLowerCase() !== index.merkleRoot.toLowerCase()) throw new Error(`${path}: proof under another root`);
    proofs.set(m[1].toLowerCase(), p);
  }
  return { cid, index, proofs };
}

// Gateways to try in order (comma-separated). Public gateways only serve some content (Pinata's
// public gateway, which safenet-data's config names, refuses content not pinned with it), and any
// gateway is untrusted: a CAR that fails verification is treated like a failed request.
export const gateways = (list = process.env.IPFS_GATEWAY_URL || DEFAULT_IPFS_GATEWAYS) => list.split(",").map((g) => g.trim()).filter(Boolean);

export async function fetchRewardsDb(cid: string, gatewayList?: string): Promise<RewardsDb> {
  const errors: string[] = [];
  for (const gateway of gateways(gatewayList)) {
    const url = `${gateway.replace(/\/+$/, "")}/ipfs/${cid}?format=car`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { headers: { accept: "application/vnd.ipld.car" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return rewardsDbFromCar(new Uint8Array(await res.arrayBuffer()), cid);
      } catch (e) {
        errors.push(`${gateway} (${attempt + 1}): ${(e as Error).message}`);
        if (/HTTP 4\d\d/.test((e as Error).message) && !/HTTP 429/.test((e as Error).message)) break;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
  }
  throw new Error(`rewards DB ${cid} not available from any gateway:\n  ${errors.join("\n  ")}`);
}

// Sums cumulative + KYC-withheld over every proof, for the check against tokenTotal.
export function proofTotals(db: RewardsDb) {
  let cumulative = 0n;
  let kyc = 0n;
  let sentinel = 0n;
  for (const p of db.proofs.values()) {
    cumulative += BigInt(p.cumulativeAmount);
    kyc += BigInt(p.kycAmount ?? "0");
    sentinel += BigInt(p.sentinelAmount ?? "0");
  }
  return { addresses: db.proofs.size, cumulative, kyc, sentinel };
}

// ---------------------------------------------------------------------------------------------
// ENS history

type Call = <T>(method: string, params: unknown[]) => Promise<T>;
type GetLogs = (address: string, topics: (string | string[] | null)[], from: number, to: number, step?: number) => Promise<
  { blockNumber: string; transactionHash: string; logIndex: string; data: string }[]
>;

// Every contenthash the ENS name has pinned on its current resolver, oldest first.
export async function contenthashHistory(
  rpc: { call: Call; getLogs: GetLogs; blockTime: (l: { blockNumber: string }) => Promise<number> },
  { name = REWARDS_ENS_NAME, fromBlock, toBlock }: { name?: string; fromBlock: number; toBlock: number },
) {
  const node = namehash(name);
  const resolverWord = await rpc.call<string>("eth_call", [{ to: ENS_REGISTRY, data: `0x0178b8bf${node.slice(2)}` }, `0x${toBlock.toString(16)}`]);
  const resolver = `0x${resolverWord.slice(26)}`;
  if (/^0x0+$/.test(resolver)) throw new Error(`ENS name ${name} has no resolver`);
  const current = abiBytes(
    await rpc.call<string>("eth_call", [{ to: resolver, data: `0xbc1c58d1${node.slice(2)}` }, `0x${toBlock.toString(16)}`]),
  );
  const logs = await rpc.getLogs(resolver, [CONTENTHASH_CHANGED, node], fromBlock, toBlock, 500_000);
  const history = [];
  for (const l of logs) {
    history.push({
      cid: cidString(decodeContenthash(abiBytes(l.data))),
      block: Number(l.blockNumber),
      time: await rpc.blockTime(l),
      tx: l.transactionHash.toLowerCase(),
    });
  }
  const currentCid = current === "0x" ? null : cidString(decodeContenthash(current));
  if (currentCid !== (history.at(-1)?.cid ?? null))
    throw new Error(`contenthash ${currentCid} at block ${toBlock} is not the last ContenthashChanged (${history.at(-1)?.cid})`);
  return { resolver, node, history };
}
