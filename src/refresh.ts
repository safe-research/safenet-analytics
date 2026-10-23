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

export async function refresh(
  queries: QuerySpec[],
  state: State,
  client: DuneClient,
  options: { timeoutMs?: number; pollMs?: number; log?: (line: string) => void } = {},
): Promise<RefreshResult[]> {
  const log = options.log ?? console.log;
  const results: RefreshResult[] = [];
  for (const q of queries) {
    const id = state.queries[q.key]?.id;
    if (!id) throw new Error(`query ${q.key} has no Dune ID in dune/state.json; deploy it first`);
    const executionId = await client.execute(id, q.performance);
    log(`executing ${q.key} (${id}) on ${q.performance}: ${executionId}`);
    const status = await client.waitForExecution(executionId, options.timeoutMs ?? 20 * 60_000, options.pollMs);
    log(`${q.key}: ${status.state}${status.execution_cost_credits === undefined ? "" : `, ${status.execution_cost_credits} credits`}`);
    results.push({ key: q.key, id, status });
  }
  return results;
}

export const succeeded = (r: RefreshResult) => r.status.state === "QUERY_STATE_COMPLETED";
