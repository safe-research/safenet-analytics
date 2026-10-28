// Loads and validates the Dune configuration under dune/.
//
//   dune/project.yaml                  team, managed tag, protected dashboards
//   dune/dashboards/<key>.yaml         one dashboard each: name, slug, text and layout
//   dune/queries/<key>/query.yaml      query metadata, refresh schedule, visualizations
//   dune/queries/<key>/query.sql       query SQL; {{query:<key>}} refers to another managed query
//   dune/preview.yaml                  preview dashboard settings (src/preview.ts)

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Performance, Position, QueryParameter } from "./dune.ts";

export const DEFAULT_ROOT = fileURLToPath(new URL("../dune", import.meta.url));

// Dune's dashboard grid width. The official CLI's example uses size_x 3 for half-width widgets;
// confirm against the first deployed dashboard (docs/deployment.md).
export const GRID_COLUMNS = 6;

export const REFRESH_SCHEDULES = ["daily", "none"] as const;
export type Refresh = (typeof REFRESH_SCHEDULES)[number];

const VIZ_TYPES = [
  "chart",
  "table",
  "counter",
  "pivot",
  "cohort",
  "funnel",
  "choropleth",
  "sankey",
  "sunburst_sequence",
  "word_cloud",
];

export type Project = { team: string; managedTag: string; protectedDashboards: string[] };

export type VisualizationSpec = {
  key: string; // <query key>/<visualization key>
  query: string;
  name: string;
  type: string;
  description: string;
  options: Record<string, unknown>;
};

export type QuerySpec = {
  key: string;
  name: string;
  description: string;
  sql: string;
  isPrivate: boolean;
  tags: string[];
  parameters: QueryParameter[];
  refresh: Refresh;
  performance: Performance;
  visualizations: VisualizationSpec[];
  // Keys of managed queries this query reads through {{query:<key>}}.
  dependencies: string[];
};

export type Widget =
  | { kind: "text"; text: string; position: Position }
  | { kind: "visualization"; ref: string; position: Position };

// `key` is the file name in dune/dashboards/ and the target of {{dashboard:<key>}} links.
// `previewOnly` dashboards are deployed to previews and never to production.
export type DashboardSpec = {
  key: string;
  name: string;
  slug: string;
  isPrivate: boolean;
  tags: string[];
  previewOnly: boolean;
  widgets: Widget[];
};

// The overview is listed first, then the other dashboards by key.
export type Config = { project: Project; queries: QuerySpec[]; dashboards: DashboardSpec[] };

export const OVERVIEW = "overview";

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid Dune configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.problems = problems;
  }
}

type Raw = Record<string, unknown>;

async function readYaml(path: string): Promise<Raw> {
  const value = parse(await readFile(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigError([`${path}: expected a mapping`]);
  return value as Raw;
}

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const strList = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

export async function loadConfig(root = DEFAULT_ROOT): Promise<Config> {
  const problems: string[] = [];
  const projectRaw = await readYaml(join(root, "project.yaml"));
  const project: Project = {
    team: str(projectRaw.team),
    managedTag: str(projectRaw.managed_tag, "safenet-analytics"),
    protectedDashboards: strList(projectRaw.protected_dashboards),
  };
  if (!project.team) problems.push("project.yaml: `team` is required");

  const queries: QuerySpec[] = [];
  const queriesDir = join(root, "queries");
  const keys = existsSync(queriesDir)
    ? (await readdir(queriesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  for (const key of keys.sort()) {
    const where = `queries/${key}`;
    if (!/^[a-z0-9_]+$/.test(key)) problems.push(`${where}: directory name must match [a-z0-9_]+`);
    const yamlPath = join(queriesDir, key, "query.yaml");
    const sqlPath = join(queriesDir, key, "query.sql");
    if (!existsSync(yamlPath) || !existsSync(sqlPath)) {
      problems.push(`${where}: needs query.yaml and query.sql`);
      continue;
    }
    const raw = await readYaml(yamlPath);
    const sql = normalizeSql(await readFile(sqlPath, "utf8"));
    const vizRaw = (raw.visualizations ?? {}) as Record<string, Raw>;
    const visualizations: VisualizationSpec[] = Object.entries(vizRaw).map(([vKey, v]) => ({
      key: `${key}/${vKey}`,
      query: key,
      name: str(v?.name),
      type: str(v?.type),
      description: str(v?.description).trim(),
      options: (v?.options ?? {}) as Record<string, unknown>,
    }));
    const spec: QuerySpec = {
      key,
      name: str(raw.name),
      description: str(raw.description).trim(),
      sql,
      isPrivate: raw.private === true,
      tags: strList(raw.tags),
      parameters: (raw.parameters ?? []) as QueryParameter[],
      refresh: str(raw.refresh, "daily") as Refresh,
      performance: str(raw.performance, "medium") as Performance,
      visualizations,
      dependencies: queryReferences(sql),
    };
    problems.push(...validateQuery(spec, where));
    queries.push(spec);
  }

  const dashboards: DashboardSpec[] = [];
  const dashboardsDir = join(root, "dashboards");
  // Configurations from before dune/dashboards/ (for example main's, read as a preview baseline,
  // or an older commit being restored) have a single dune/dashboard.yaml: the overview.
  const files: { key: string; file: string; path: string }[] = existsSync(dashboardsDir)
    ? (await readdir(dashboardsDir))
        .filter((f) => f.endsWith(".yaml"))
        .sort()
        .map((f) => ({ key: f.slice(0, -".yaml".length), file: `dashboards/${f}`, path: join(dashboardsDir, f) }))
    : existsSync(join(root, "dashboard.yaml"))
      ? [{ key: OVERVIEW, file: "dashboard.yaml", path: join(root, "dashboard.yaml") }]
      : [];
  for (const { key, file, path: dashPath } of files) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) problems.push(`${file}: file name must match [a-z0-9-]+.yaml`);
    const dashRaw = await readYaml(dashPath);
    const widgets: Widget[] = [];
    for (const [i, w] of ((dashRaw.widgets ?? []) as Raw[]).entries()) {
      const where = `${file} widgets[${i}]`;
      const position = w.position as Position;
      if (typeof w.text_file === "string") {
        const path = join(root, w.text_file);
        if (!existsSync(path)) problems.push(`${where}: text_file ${w.text_file} not found`);
        else widgets.push({ kind: "text", text: (await readFile(path, "utf8")).trim(), position });
      } else if (typeof w.text === "string") {
        widgets.push({ kind: "text", text: w.text.trim(), position });
      } else if (typeof w.visualization === "string") {
        widgets.push({ kind: "visualization", ref: w.visualization, position });
      } else problems.push(`${where}: needs one of text, text_file or visualization`);
    }
    const dashboard: DashboardSpec = {
      key,
      name: str(dashRaw.name),
      slug: str(dashRaw.slug),
      isPrivate: dashRaw.private === true,
      tags: strList(dashRaw.tags),
      previewOnly: dashRaw.preview_only === true,
      widgets,
    };
    problems.push(...validateDashboard(dashboard, queries, project));
    dashboards.push(dashboard);
  }
  dashboards.sort((a, b) => Number(b.key === OVERVIEW) - Number(a.key === OVERVIEW));
  problems.push(...validateDashboards(dashboards, queries, project));

  const names = queries.map((q) => q.name);
  for (const n of new Set(names.filter((n, i) => names.indexOf(n) !== i))) problems.push(`duplicate query name "${n}"`);

  const ordered = orderByDependencies(queries, problems);
  if (problems.length) throw new ConfigError(problems);
  return { project, queries: ordered, dashboards };
}

// {{dashboard:<key>}} in dashboard text links to another managed dashboard. It renders to that
// dashboard's URL in the target environment: production slugs in production, preview slugs in a
// preview. The deployer creates every dashboard and checks its URL before writing links to it.
export const DASHBOARD_LINK = /\{\{\s*dashboard:([a-z0-9-]+)\s*\}\}/g;

export const dashboardLinks = (text: string) => [...new Set([...text.matchAll(DASHBOARD_LINK)].map((m) => m[1]))].sort();

export const dashboardUrl = (team: string, slug: string) => `https://dune.com/${team}/${slug}`;

// Dashboard text with {{dashboard:<key>}} replaced by `url(key)`.
export function renderLinks(text: string, url: (key: string) => string): string {
  return text.replace(DASHBOARD_LINK, (_, key: string) => url(key));
}

// Dashboards deployed to production.
export const productionDashboards = (config: Config) => config.dashboards.filter((d) => !d.previewOnly);

// {{query:<key>}} in a query's SQL refers to another managed query. The deployer renders it as
// query_<id> with the ID of that query in the target environment (production or a preview), so a
// preview query never reads a production query and vice versa.
export const QUERY_REFERENCE = /\{\{\s*query:([a-z0-9_]+)\s*\}\}/g;

export function queryReferences(sql: string): string[] {
  return [...new Set([...sql.matchAll(QUERY_REFERENCE)].map((m) => m[1]))].sort();
}

// Renders {{query:<key>}} references. `resolve` returns the replacement for a key: query_<id> for a
// saved query, or the referenced SQL as a subquery for unsaved executions.
export function renderSql(sql: string, resolve: (key: string) => string): string {
  return sql.replace(QUERY_REFERENCE, (_, key: string) => resolve(key));
}

// The query's SQL with every reference replaced by the referenced SQL, recursively. Used to run
// SQL on Dune without saving it and to fingerprint everything a query's result depends on.
export function inlineSql(q: QuerySpec, queries: QuerySpec[]): string {
  const byKey = new Map(queries.map((x) => [x.key, x]));
  const inline = (spec: QuerySpec): string =>
    renderSql(spec.sql, (key) => `(\n${inline(byKey.get(key)!).trim()}\n)`);
  return inline(q);
}

// Dependencies first, so a referenced query exists before the query that reads it is written.
function orderByDependencies(queries: QuerySpec[], problems: string[]): QuerySpec[] {
  const byKey = new Map(queries.map((q) => [q.key, q]));
  const ordered: QuerySpec[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (q: QuerySpec, path: string[]) => {
    if (state.get(q.key) === "done") return;
    if (state.get(q.key) === "visiting") {
      problems.push(`queries/${q.key}: circular {{query:...}} references (${[...path, q.key].join(" -> ")})`);
      return;
    }
    state.set(q.key, "visiting");
    for (const dep of q.dependencies) {
      const d = byKey.get(dep);
      if (!d) problems.push(`queries/${q.key}: {{query:${dep}}} refers to an unknown query`);
      else visit(d, [...path, q.key]);
    }
    state.set(q.key, "done");
    ordered.push(q);
  };
  for (const q of queries) visit(q, []);
  return ordered;
}

export function normalizeSql(sql: string): string {
  return `${sql.replace(/\r\n/g, "\n").trim()}\n`;
}

function validateQuery(q: QuerySpec, where: string): string[] {
  const problems: string[] = [];
  if (!q.name) problems.push(`${where}: name is required`);
  if (!q.sql.trim()) problems.push(`${where}: query.sql is empty`);
  if (!REFRESH_SCHEDULES.includes(q.refresh)) problems.push(`${where}: refresh must be one of ${REFRESH_SCHEDULES}`);
  if (!["medium", "large"].includes(q.performance)) problems.push(`${where}: performance must be medium or large`);

  const declared = new Set(q.parameters.map((p) => p.key));
  const used = new Set(
    [...q.sql.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]).filter((p) => !p.startsWith("query:")),
  );
  for (const p of used) if (!declared.has(p)) problems.push(`${where}: SQL uses undeclared parameter {{${p}}}`);
  for (const p of declared) if (!used.has(p)) problems.push(`${where}: parameter ${p} is not used in the SQL`);
  if (q.refresh !== "none" && declared.size) problems.push(`${where}: scheduled refresh needs a query without parameters`);

  const vizNames = new Set<string>();
  for (const v of q.visualizations) {
    const vw = `${where} visualization ${v.key}`;
    if (!v.name) problems.push(`${vw}: name is required`);
    if (vizNames.has(v.name)) problems.push(`${vw}: duplicate visualization name "${v.name}"`);
    vizNames.add(v.name);
    if (!VIZ_TYPES.includes(v.type)) problems.push(`${vw}: type must be one of ${VIZ_TYPES.join(", ")}`);
    for (const col of referencedColumns(v))
      if (!new RegExp(`\\b${col.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(q.sql))
        problems.push(`${vw}: column "${col}" does not appear in query.sql`);
  }
  return problems;
}

// Result columns a visualization refers to, for typo checks against the SQL.
export function referencedColumns(v: VisualizationSpec): string[] {
  const o = v.options as {
    columnMapping?: Record<string, string>;
    counterColName?: string;
    columns?: { name?: string }[];
    seriesOptions?: Record<string, unknown>;
  };
  // With a `series` column (one series per value), seriesOptions are keyed by values, not columns.
  const grouped = Object.values(o.columnMapping ?? {}).includes("series");
  return [
    ...Object.keys(o.columnMapping ?? {}),
    ...(grouped ? [] : Object.keys(o.seriesOptions ?? {})),
    ...(o.counterColName ? [o.counterColName] : []),
    ...(o.columns ?? []).map((c) => c.name ?? "").filter(Boolean),
  ];
}

function validateDashboard(d: DashboardSpec, queries: QuerySpec[], project: Project): string[] {
  const problems: string[] = [];
  const where = `dashboards/${d.key}.yaml`;
  if (!d.name) problems.push(`${where}: name is required`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(d.slug)) problems.push(`${where}: slug must match [a-z0-9-]+`);
  if (d.slug.includes("preview")) problems.push(`${where}: slug must not contain "preview" (reserved for previews)`);
  if (project.protectedDashboards.includes(`${project.team}/${d.slug}`))
    problems.push(`${where}: slug ${d.slug} belongs to a protected dashboard`);

  const vizKeys = new Set(queries.flatMap((q) => q.visualizations.map((v) => v.key)));
  const seen = new Set<string>();
  const cells = new Map<string, number>();
  for (const [i, w] of d.widgets.entries()) {
    const ww = `${where} widgets[${i}]`;
    if (w.kind === "visualization") {
      if (!vizKeys.has(w.ref)) problems.push(`${ww}: unknown visualization ${w.ref} (use <query>/<visualization>)`);
      if (seen.has(w.ref)) problems.push(`${ww}: ${w.ref} is placed twice`);
      seen.add(w.ref);
    } else if (!w.text) problems.push(`${ww}: text is empty`);

    const p = w.position;
    const ints = p && [p.row, p.col, p.size_x, p.size_y].every((n) => Number.isInteger(n));
    if (!ints) {
      problems.push(`${ww}: position needs integer row, col, size_x and size_y`);
      continue;
    }
    if (p.row < 0 || p.col < 0 || p.size_x < 1 || p.size_y < 1 || p.col + p.size_x > GRID_COLUMNS)
      problems.push(`${ww}: position is outside the ${GRID_COLUMNS}-column grid`);
    for (let r = p.row; r < p.row + p.size_y; r++)
      for (let c = p.col; c < p.col + p.size_x; c++) {
        const other = cells.get(`${r}:${c}`);
        if (other !== undefined && other !== i) {
          problems.push(`${ww}: overlaps widgets[${other}]`);
          r = Number.POSITIVE_INFINITY;
          break;
        }
        cells.set(`${r}:${c}`, i);
      }
  }
  return problems;
}

// Checks across dashboards: unique slugs, known link targets, complete navigation, and every
// visualization placed in production, so moving widgets between dashboards cannot drop one.
function validateDashboards(dashboards: DashboardSpec[], queries: QuerySpec[], project: Project): string[] {
  const problems: string[] = [];
  const keys = new Set(dashboards.map((d) => d.key));
  const production = dashboards.filter((d) => !d.previewOnly);
  if (!production.some((d) => d.key === OVERVIEW)) problems.push(`dashboards/${OVERVIEW}.yaml is required (the landing page)`);
  const slugs = dashboards.map((d) => d.slug);
  for (const s of new Set(slugs.filter((s, i) => slugs.indexOf(s) !== i))) problems.push(`dashboards: slug ${s} is used twice`);

  const managed = new Map(dashboards.map((d) => [d.slug, d.key]));
  for (const d of dashboards) {
    const where = `dashboards/${d.key}.yaml`;
    const text = d.widgets.flatMap((w) => (w.kind === "text" ? [w.text] : [])).join("\n");
    const links = dashboardLinks(text);
    for (const k of links.filter((k) => !keys.has(k))) problems.push(`${where}: {{dashboard:${k}}} refers to an unknown dashboard`);
    for (const k of links.filter((k) => dashboards.find((x) => x.key === k)?.previewOnly && !d.previewOnly))
      problems.push(`${where}: links to the preview-only dashboard ${k}`);
    // Hard-coded links would point to production from a preview; use {{dashboard:<key>}}.
    for (const m of text.matchAll(new RegExp(`dune\\.com/${project.team}/([a-z0-9-]+)`, "g")))
      if (managed.has(m[1])) problems.push(`${where}: links to dune.com/${project.team}/${m[1]} directly; use {{dashboard:${managed.get(m[1])}}}`);
    if (d.previewOnly) continue;
    const missing = production.filter((x) => x.key !== d.key && !links.includes(x.key)).map((x) => x.key);
    if (missing.length) problems.push(`${where}: no link to ${missing.join(", ")}; every dashboard links to all the others`);
  }

  const placed = new Set(production.flatMap((d) => d.widgets.flatMap((w) => (w.kind === "visualization" ? [w.ref] : []))));
  for (const v of queries.flatMap((q) => q.visualizations))
    if (!placed.has(v.key)) problems.push(`visualization ${v.key} is not placed on any production dashboard`);
  return problems;
}
