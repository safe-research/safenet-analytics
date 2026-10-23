// dune/state.json maps config keys to Dune resource IDs and records fingerprints of what was last
// deployed, so redeploys update in place and edits made directly in Dune are detected.

import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "./hash.ts";

export const STATE_PATH = new URL("../dune/state.json", import.meta.url);

// `desired` is the fingerprint of the GitHub configuration last deployed; `remote` is the
// fingerprint of the Dune resource as read back right after that deploy.
export type Tracked = { id: number; desired: string; remote: string };

export type ProtectedRecord = {
  dashboard_id: number;
  query_ids: number[];
  visualization_ids: number[];
  fingerprint: string;
  checked_at: string;
};

export type State = {
  version: 1;
  queries: Record<string, Tracked>;
  visualizations: Record<string, Tracked & { query_id: number }>;
  dashboard: (Tracked & { url: string }) | null;
  protected: Record<string, ProtectedRecord>;
};

export const emptyState = (): State => ({ version: 1, queries: {}, visualizations: {}, dashboard: null, protected: {} });

export async function loadState(path: URL | string = STATE_PATH): Promise<State> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as State;
    if (state.version !== 1) throw new Error(`unsupported state version ${state.version}`);
    return { ...emptyState(), ...state };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw e;
  }
}

export async function saveState(state: State, path: URL | string = STATE_PATH): Promise<void> {
  await writeFile(path, `${JSON.stringify(JSON.parse(canonicalJson(state)), null, 2)}\n`);
}
