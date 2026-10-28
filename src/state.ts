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

// Preview executions (src/preview.ts): what each preview query's latest result was computed from,
// so unchanged queries are not executed again.
export type ExecutionRecord = {
  query_id: number;
  sql: string; // fingerprint of the query's SQL with all references inlined
  execution_id: string;
  ended_at?: string;
  credits?: number;
};

export type TrackedDashboard = Tracked & { url: string };

export type State = {
  version: 1;
  queries: Record<string, Tracked>;
  visualizations: Record<string, Tracked & { query_id: number }>;
  // Keyed by dashboard key (dune/dashboards/<key>.yaml).
  dashboards: Record<string, TrackedDashboard>;
  protected: Record<string, ProtectedRecord>;
  executions?: Record<string, ExecutionRecord>;
};

export const emptyState = (): State => ({ version: 1, queries: {}, visualizations: {}, dashboards: {}, protected: {} });

// State files written before there were several dashboards record the single dashboard as
// `dashboard`; it is the overview (production: dune.com/safe/safenet, dashboard 222526).
type StoredState = Omit<State, "dashboards"> & { dashboards?: State["dashboards"]; dashboard?: TrackedDashboard | null };

export function migrateState(stored: StoredState): State {
  const { dashboard, ...rest } = stored;
  const state: State = { ...emptyState(), ...rest, dashboards: { ...(rest.dashboards ?? {}) } };
  if (dashboard && !state.dashboards.overview) state.dashboards.overview = dashboard;
  return state;
}

export async function loadState(path: URL | string = STATE_PATH): Promise<State> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as StoredState;
    if (state.version !== 1) throw new Error(`unsupported state version ${state.version}`);
    return migrateState(state);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw e;
  }
}

export async function saveState(state: State, path: URL | string = STATE_PATH): Promise<void> {
  await writeFile(path, `${JSON.stringify(JSON.parse(canonicalJson(state)), null, 2)}\n`);
}
