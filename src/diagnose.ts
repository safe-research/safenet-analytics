// Read-only diagnosis of what Dune renders on a dashboard, widget by widget: the visualization as
// stored in Dune, the latest stored result of its query (never executed here), and whether the
// two fit together. Dune's frontend renders each widget from exactly these two inputs, so a widget
// that fails in the browser shows up here as a missing result, a column the options refer to that
// the result lacks, options that differ from GitHub, or nulls where the chart expects values.
//
// It starts from the dashboard's widgets in Dune, not from dune/, so it also reports widgets that
// were added or changed in the Dune UI.

import { pivotProblems, referencedColumns, type VisualizationSpec } from "./config.ts";
import { contains, remoteVisualization } from "./deploy.ts";
import type { DuneClient, Position } from "./dune.ts";

export type Finding = { level: "error" | "note"; message: string };

export type WidgetDiagnosis = {
  dashboard: string; // slug
  position?: Position;
  visualization_id: number;
  query_id?: number;
  key?: string; // <query>/<visualization> in dune/, if managed
  name?: string;
  type?: string;
  result?: { state: string; rows: number; columns: string[]; ended_at?: string };
  findings: Finding[];
  link?: string; // the visualization on its own query page
};

const RESULT_ROWS = 1000;

// Columns a visualization needs from the result, by kind, as Dune stores its options.
function requiredColumns(type: string, options: Record<string, unknown>): { columns: string[]; findings: Finding[] } {
  const findings: Finding[] = [];
  if (type === "pivot") for (const message of pivotProblems(options)) findings.push({ level: "error", message });
  if (type === "table" && options.columns !== undefined && !Array.isArray(options.columns))
    findings.push({ level: "error", message: "table options.columns is not a list" });
  return { columns: referencedColumns({ type, options } as VisualizationSpec), findings };
}

export async function diagnoseDashboard(
  client: DuneClient,
  dashboardId: number,
  managed: ReadonlyMap<number, VisualizationSpec>, // GitHub's visualizations by Dune ID
): Promise<{ slug: string; url?: string; widgets: WidgetDiagnosis[] }> {
  const dashboard = await client.getDashboard(dashboardId);
  if (!dashboard) return { slug: `dashboard ${dashboardId}`, widgets: [] };
  const widgets = [...(dashboard.visualization_widgets ?? [])].sort(
    (a, b) => (a.position?.row ?? 0) - (b.position?.row ?? 0) || (a.position?.col ?? 0) - (b.position?.col ?? 0),
  );
  const results = new Map<number, Awaited<ReturnType<DuneClient["latestResults"]>> | Error>();
  const out: WidgetDiagnosis[] = [];
  for (const w of widgets) {
    const d: WidgetDiagnosis = { dashboard: dashboard.slug, position: w.position, visualization_id: w.visualization_id, findings: [] };
    out.push(d);
    const viz = await client.getVisualization(w.visualization_id);
    if (!viz) {
      d.findings.push({ level: "error", message: "visualization not found (deleted?)" });
      continue;
    }
    const spec = managed.get(viz.id);
    Object.assign(d, {
      query_id: viz.query_id,
      key: spec?.key,
      name: viz.name,
      type: viz.type,
      link: `https://dune.com/queries/${viz.query_id}/${viz.id}`,
    });
    const options = remoteVisualization(viz).options as Record<string, unknown>;
    if (!spec) d.findings.push({ level: "note", message: "not managed in GitHub" });
    else {
      if (spec.type !== viz.type) d.findings.push({ level: "error", message: `type is ${viz.type} in Dune, ${spec.type} in GitHub` });
      if (!contains(options, spec.options)) d.findings.push({ level: "error", message: "options in Dune differ from GitHub" });
    }

    if (!results.has(viz.query_id))
      results.set(viz.query_id, await client.latestResults(viz.query_id, RESULT_ROWS).catch((e: Error) => e));
    const result = results.get(viz.query_id)!;
    if (result instanceof Error) {
      d.findings.push({ level: "error", message: `no stored result (never executed, or not readable): ${result.message.slice(0, 160)}` });
      continue;
    }
    d.result = { state: result.state, rows: result.rows.length, columns: result.columns, ended_at: result.execution_ended_at };
    if (result.state !== "QUERY_STATE_COMPLETED")
      d.findings.push({ level: "error", message: `latest execution is ${result.state}` });
    if (!result.columns.length) {
      d.findings.push({ level: "error", message: "result has no columns" });
      continue;
    }

    const { columns, findings } = requiredColumns(viz.type, options);
    d.findings.push(...findings);
    const missing = [...new Set(columns.filter((c) => !result.columns.includes(c)))];
    if (missing.length) d.findings.push({ level: "error", message: `options use columns missing from the result: ${missing.join(", ")}` });
    if (viz.type === "table" && Array.isArray(options.columns)) {
      const configured = new Set((options.columns as { name?: string }[]).map((c) => c.name));
      const extra = result.columns.filter((c) => !configured.has(c));
      if (extra.length) d.findings.push({ level: "note", message: `result columns without column settings: ${extra.join(", ")}` });
    }
    if (!result.rows.length) d.findings.push({ level: "note", message: "empty result (0 rows)" });
    for (const c of columns.filter((c) => result.columns.includes(c))) {
      const nulls = result.rows.filter((r) => r[c] === null || r[c] === undefined).length;
      if (nulls) d.findings.push({ level: "note", message: `${c} is null in ${nulls} of ${result.rows.length} rows` });
    }
  }
  return { slug: dashboard.slug, url: dashboard.dashboard_url, widgets: out };
}

export const hasErrors = (ws: WidgetDiagnosis[]) => ws.some((w) => w.findings.some((f) => f.level === "error"));

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function formatDiagnosis(d: { slug: string; url?: string; widgets: WidgetDiagnosis[] }): string {
  const lines = [
    `#### ${d.url ? `[${d.slug}](${d.url})` : d.slug}`,
    "",
    "| Row | Widget | Type | Latest result | Findings | Alone |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const w of d.widgets) {
    const result = w.result ? `${w.result.state.replace("QUERY_STATE_", "").toLowerCase()}, ${w.result.rows} rows` : "none";
    const findings = w.findings.map((f) => `${f.level === "error" ? "**error**" : "note"}: ${f.message}`).join("<br>") || "ok";
    lines.push(
      `| ${w.position?.row ?? ""} | ${cell(w.key ?? w.name ?? String(w.visualization_id))} (${w.visualization_id}) | ${w.type ?? ""} | ${result} | ${cell(findings)} | ${w.link ? `[open](${w.link})` : ""} |`,
    );
  }
  return lines.join("\n");
}

// Options as Dune stores them, for comparing with a visualization made in Dune's own editor: every
// pivot widget, and every visualization on the diagnosed queries that GitHub does not manage (for
// example one created in the Dune UI as a reference).
export type StoredOptions = { visualization_id: number; query_id: number; name: string; type: string; managed: boolean; options: unknown };

export async function storedOptions(
  client: DuneClient,
  widgets: WidgetDiagnosis[],
  managedIds: ReadonlySet<number>,
): Promise<StoredOptions[]> {
  const out: StoredOptions[] = [];
  const seen = new Set<number>();
  const add = async (id: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    const v = await client.getVisualization(id);
    if (v) out.push({ visualization_id: v.id, query_id: v.query_id, name: v.name, type: v.type, managed: managedIds.has(v.id), options: v.options ?? {} });
  };
  for (const w of widgets) if (w.type === "pivot") await add(w.visualization_id);
  for (const queryId of [...new Set(widgets.flatMap((w) => (w.query_id === undefined ? [] : [w.query_id])))])
    for (const v of await client.listVisualizations(queryId)) if (!managedIds.has(v.id)) await add(v.id);
  // Dune gives every query a default results table without options; it tells nothing.
  return out
    .filter((v) => v.managed || v.type !== "table" || Object.keys(v.options as object).length).sort((a, b) => a.query_id - b.query_id || a.visualization_id - b.visualization_id);
}

export function formatStoredOptions(list: StoredOptions[]): string {
  if (!list.length) return "";
  return [
    "#### Stored options: pivot widgets and visualizations not managed in GitHub",
    "",
    ...list.flatMap((v) => [
      `- ${v.managed ? "managed" : "**not managed**"} ${v.type} "${v.name}" (${v.visualization_id}) on [query ${v.query_id}](https://dune.com/queries/${v.query_id}/${v.visualization_id})`,
      "",
      "  ```json",
      ...JSON.stringify(v.options, null, 2).split("\n").map((l) => `  ${l}`),
      "  ```",
    ]),
  ].join("\n");
}
