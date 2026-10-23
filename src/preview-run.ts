// Executes preview queries after a preview deploy, within the cost caps of dune/preview.yaml.
// Only queries shown on the dashboard run, and only if their SQL (with every referenced query
// inlined) changed since their last preview execution. Previews have no schedule.

import { inlineSql, type Config } from "./config.ts";
import type { DuneClient } from "./dune.ts";
import { fingerprint } from "./hash.ts";
import type { PreviewSettings } from "./preview.ts";
import type { ExecutionRecord, State } from "./state.ts";

export type PreviewRun = { key: string; query_id: number; action: "executed" | "unchanged"; credits?: number; state?: string };

export async function runPreviewQueries(
  config: Config, // the preview configuration (toPreview)
  state: State, // the preview state; executions are recorded in it
  client: DuneClient,
  settings: PreviewSettings,
  options: { pollMs?: number; log?: (line: string) => void; force?: boolean } = {},
): Promise<PreviewRun[]> {
  const log = options.log ?? console.log;
  const { performance, timeoutMinutes, maxCreditsPerExecution, maxCreditsPerRun } = settings.execution;
  const shown = new Set(config.dashboard.widgets.flatMap((w) => (w.kind === "visualization" ? [w.ref.split("/")[0]] : [])));
  state.executions ??= {};
  const runs: PreviewRun[] = [];
  let spent = 0;
  for (const q of config.queries.filter((x) => shown.has(x.key))) {
    const id = state.queries[q.key]?.id;
    if (!id) throw new Error(`preview query ${q.key} is not deployed; run the preview deploy first`);
    const sql = fingerprint(inlineSql(q, config.queries));
    const previous = state.executions[q.key];
    if (!options.force && previous?.query_id === id && previous.sql === sql) {
      log(`${q.key} (${id}): unchanged since execution ${previous.execution_id}, not executed`);
      runs.push({ key: q.key, query_id: id, action: "unchanged" });
      continue;
    }
    if (spent >= maxCreditsPerRun)
      throw new Error(`preview credit budget of ${maxCreditsPerRun} per run used up before ${q.key}`);
    const executionId = await client.execute(id, performance);
    log(`executing ${q.key} (${id}) on ${performance}: ${executionId}`);
    let status;
    try {
      status = await client.waitForExecution(executionId, timeoutMinutes * 60_000, options.pollMs);
    } catch (e) {
      await client.cancelExecution(executionId).catch(() => {});
      throw new Error(`${q.key}: cancelled after ${timeoutMinutes} minutes (${(e as Error).message})`);
    }
    const credits = status.execution_cost_credits ?? 0;
    spent += credits;
    log(`${q.key}: ${status.state}, ${credits} credits (run total ${spent})`);
    runs.push({ key: q.key, query_id: id, action: "executed", credits, state: status.state });
    if (status.state !== "QUERY_STATE_COMPLETED")
      throw new Error(`${q.key}: ${status.state} ${status.error?.message ?? ""}`.trim());
    const record: ExecutionRecord = { query_id: id, sql, execution_id: executionId, ended_at: status.execution_ended_at, credits };
    state.executions[q.key] = record;
    if (credits > maxCreditsPerExecution)
      throw new Error(`${q.key} cost ${credits} credits, above the cap of ${maxCreditsPerExecution} per execution`);
  }
  return runs;
}
