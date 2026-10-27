// Batched eth_call through Multicall3 (aggregate3, at the same address on Ethereum and Gnosis Chain),
// so that public RPCs see a handful of requests instead of one per read.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Rpc } from "./recount.ts";

export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

export const selector = (signature: string) => bytesToHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 8);
export const pad = (hex: string) => hex.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const hexWord = (n: number) => n.toString(16).padStart(64, "0");
const wordAt = (data: string, i: number) => data.slice(2 + 64 * i, 2 + 64 * (i + 1));

export type Call = { to: string; signature: string; args: string[] };
// success, and the return data as 32-byte hex words (without 0x)
export type CallResult = { success: boolean; words: string[] };

export function encodeCall(c: Call) {
  return `${selector(c.signature)}${c.args.map(pad).join("")}`;
}

export async function multicall(rpc: Rpc, calls: Call[], block: number | "latest", chunk = 250): Promise<CallResult[]> {
  const out: CallResult[] = [];
  const tag = block === "latest" ? "latest" : `0x${block.toString(16)}`;
  for (let i = 0; i < calls.length; i += chunk) {
    // aggregate3((address target, bool allowFailure, bytes callData)[]): each tuple is dynamic.
    const tuples = calls.slice(i, i + chunk).map((c) => {
      const data = encodeCall(c);
      const len = data.length / 2;
      return `${pad(c.to)}${hexWord(1)}${hexWord(0x60)}${hexWord(len)}${data.padEnd(Math.ceil(len / 32) * 64, "0")}`;
    });
    let offset = 32 * tuples.length;
    const heads = tuples.map((t) => {
      const h = hexWord(offset);
      offset += t.length / 2;
      return h;
    });
    const data = `0x${selector("aggregate3((address,bool,bytes)[])")}${hexWord(0x20)}${hexWord(tuples.length)}${heads.join("")}${tuples.join("")}`;
    const result = await rpc.call<string>("eth_call", [{ to: MULTICALL3, data }, tag]);
    // Result[] (bool success, bytes returnData): array offset, length, element offsets, elements.
    const n = Number(BigInt(`0x${wordAt(result, 1)}`));
    for (let j = 0; j < n; j++) {
      const at = 2 + Number(BigInt(`0x${wordAt(result, 2 + j)}`)) / 32;
      const success = BigInt(`0x${wordAt(result, at)}`) === 1n;
      const len = Number(BigInt(`0x${wordAt(result, at + 2)}`));
      out.push({ success, words: Array.from({ length: Math.ceil(len / 32) }, (_, k) => wordAt(result, at + 3 + k)) });
    }
  }
  return out;
}
