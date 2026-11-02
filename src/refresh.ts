// Executes deployed queries so the dashboard shows fresh results. Kept separate from deployment:
// deploys change configuration only, refreshes only run queries.

import type { Config, QuerySpec } from "./config.ts";
import type { DuneClient, ExecutionStatus } from "./dune.ts";
import type { State } from "./state.ts";

export type RefreshResult = { key: string; id: number; status: ExecutionStatus };

export function selectQueries(config: Config, options: { schedule?: string; keys?: string[] }): QuerySpec[] {
  if (options.keys?.length) {
    const unknown = options.keys.filter((k) => !config.queries.some((q) => q.key === k));
    if (unknown.length) throw new Error(`unknown queries: ${unknown.join(", ")}`);
    return config.queries.filter((q) => options.keys!.includes(q.key));
  }
  return config.queries.filter((q) => q.refresh === (options.schedule ?? "daily"));
}

// A failed or cancelled execution is retried once, after `retryDelayMs`: Dune occasionally fails
// an execution of unchanged SQL that succeeds again later (fee_allocation, 2026-11-01 and -02).
const RETRY_STATES = ["QUERY_STATE_FAILED", "QUERY_STATE_CANCELED", "QUERY_STATE_EXPIRED"];

export async function refresh(
  queries: QuerySpec[],
  state: State,
  client: DuneClient,
  options: { timeoutMs?: number; pollMs?: number; retryDelayMs?: number; log?: (line: string) => void } = {},
): Promise<RefreshResult[]> {
  const log = options.log ?? console.log;
  const results: RefreshResult[] = [];
  for (const q of queries) {
    const id = state.queries[q.key]?.id;
    // A query deployed without its ID recorded (for example when saving dune/state.json failed)
    // fails here, and the others are still refreshed.
    if (!id) {
      log(`${q.key}: no Dune ID in dune/state.json; deploy it first`);
      results.push({ key: q.key, id: 0, status: { execution_id: "", state: "QUERY_STATE_FAILED", error: { message: "no Dune ID in dune/state.json; deploy it first" } } });
      continue;
    }
    let status!: ExecutionStatus;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const executionId = await client.execute(id, q.performance);
      log(`executing ${q.key} (${id}) on ${q.performance}: ${executionId}${attempt > 1 ? " (retry)" : ""}`);
      status = await client.waitForExecution(executionId, options.timeoutMs ?? 20 * 60_000, options.pollMs);
      const error = status.error ? ` - ${[status.error.type, status.error.message].filter(Boolean).join(": ")}` : "";
      log(`${q.key}: ${status.state}${status.execution_cost_credits === undefined ? "" : `, ${status.execution_cost_credits} credits`}${error}`);
      if (attempt === 1 && RETRY_STATES.includes(status.state)) {
        await new Promise((r) => setTimeout(r, options.retryDelayMs ?? 60_000));
        continue;
      }
      break;
    }
    results.push({ key: q.key, id, status });
  }
  return results;
}

export const succeeded = (r: RefreshResult) => r.status.state === "QUERY_STATE_COMPLETED";
