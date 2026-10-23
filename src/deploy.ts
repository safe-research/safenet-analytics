// Plans and applies a deployment of the configuration in dune/ to Dune.
//
// Every resource is matched to Dune by its ID in dune/state.json. If there is no recorded ID, an
// existing resource is looked up (query by name and managed tag, visualization by name on its
// query, dashboard by slug) before anything is created, so a lost state file does not duplicate
// resources. A resource whose Dune version no longer matches what the last deploy left behind
// has been edited in Dune: the plan reports a conflict and nothing is written unless --force.

import {
  normalizeSql,
  renderSql,
  type Config,
  type DashboardSpec,
  type QuerySpec,
  type VisualizationSpec,
} from "./config.ts";
import type {
  DashboardWrite,
  DuneClient,
  QueryWrite,
  RemoteDashboard,
  RemoteQuery,
  RemoteVisualization,
  VisualizationWrite,
} from "./dune.ts";
import { canonicalJson, fingerprint } from "./hash.ts";
import type { ProtectedRecord, State } from "./state.ts";

export type Action = "create" | "update" | "noop" | "adopt" | "conflict" | "archive" | "delete";

export type Step = {
  resource: "query" | "visualization" | "dashboard";
  key: string;
  action: Action;
  id?: number;
  reason?: string;
};

export type Plan = { steps: Step[]; conflicts: Step[]; protectedIds: ProtectedIds };

export type ProtectedIds = { dashboards: Set<number>; queries: Set<number>; visualizations: Set<number> };

// IDs a deploy must never write to or reference, with the reason shown in errors: the resources of
// protected dashboards, and for previews also every production resource.
export type Guard = { label: string; ids: ProtectedIds };

export const emptyIds = (): ProtectedIds => ({ dashboards: new Set(), queries: new Set(), visualizations: new Set() });

const union = (guards: Guard[]): ProtectedIds => {
  const all = emptyIds();
  for (const g of guards)
    for (const kind of ["dashboards", "queries", "visualizations"] as const) for (const id of g.ids[kind]) all[kind].add(id);
  return all;
};

// Dune IDs of saved queries that an SQL text reads (query_<id>).
export const sqlQueryIds = (sql: string) => [...sql.matchAll(/\bquery_(\d+)\b/g)].map((m) => Number(m[1]));

// ---------------------------------------------------------------------------------------------
// Normalized representations. Fingerprints of these decide whether something changed.

// `ids` maps query keys to their Dune IDs in the target environment, for rendering {{query:<key>}}.
// A reference to a query that does not exist yet renders as a placeholder that never matches Dune.
export function desiredQuery(
  q: QuerySpec,
  managedTag: string,
  ids: ReadonlyMap<string, number> = new Map(),
): QueryWrite & { is_private: boolean } {
  return {
    name: q.name,
    description: q.description,
    query_sql: renderSql(q.sql, (key) => (ids.has(key) ? `query_${ids.get(key)}` : `query_<new:${key}>`)),
    is_private: q.isPrivate,
    tags: [...new Set([...q.tags, managedTag])].sort(),
    parameters: q.parameters,
  };
}

export function remoteQuery(r: RemoteQuery) {
  return {
    name: r.name,
    description: (r.description ?? "").trim(),
    query_sql: normalizeSql(r.query_sql ?? ""),
    is_private: r.is_private,
    tags: [...(r.tags ?? [])].sort(),
    parameters: r.parameters ?? [],
  };
}

export function desiredVisualization(v: VisualizationSpec): VisualizationWrite {
  return { name: v.name, type: v.type, description: v.description, options: v.options };
}

export function remoteVisualization(r: RemoteVisualization) {
  return { name: r.name, type: r.type, description: (r.description ?? "").trim(), options: r.options ?? {} };
}

export function desiredDashboard(d: DashboardSpec, vizIds: Map<string, number | string>) {
  return {
    name: d.name,
    slug: d.slug,
    is_private: d.isPrivate,
    tags: [...d.tags].sort(),
    visualization_widgets: d.widgets
      .filter((w) => w.kind === "visualization")
      .map((w) => ({ visualization_id: vizIds.get(w.ref) ?? `new:${w.ref}`, position: w.position })),
    text_widgets: d.widgets.filter((w) => w.kind === "text").map((w) => ({ text: w.text, position: w.position })),
  };
}

export function remoteDashboard(r: RemoteDashboard) {
  return {
    name: r.name,
    slug: r.slug,
    is_private: r.is_private,
    tags: [...(r.tags ?? [])].sort(),
    visualization_widgets: (r.visualization_widgets ?? []).map((w) => ({
      visualization_id: w.visualization_id,
      position: w.position,
    })),
    text_widgets: (r.text_widgets ?? []).map((w) => ({ text: w.text.trim(), position: w.position })),
    param_widgets: (r.param_widgets ?? []).map((w) => ({ key: w.key, query_id: w.query_id, position: w.position })),
  };
}

// Widget order in Dune responses is not meaningful.
function sortedDashboard<T extends { visualization_widgets: unknown[]; text_widgets: unknown[] }>(d: T): T {
  const byJson = (a: unknown, b: unknown) => (canonicalJson(a) < canonicalJson(b) ? -1 : 1);
  return {
    ...d,
    visualization_widgets: [...d.visualization_widgets].sort(byJson),
    text_widgets: [...d.text_widgets].sort(byJson),
  };
}

const dashboardFingerprint = (d: { visualization_widgets: unknown[]; text_widgets: unknown[] }) =>
  fingerprint(sortedDashboard(d));

const sameQuery = (r: RemoteQuery, q: QuerySpec, tag: string, ids: ReadonlyMap<string, number>) =>
  canonicalJson(remoteQuery(r)) === canonicalJson(desiredQuery(q, tag, ids));

// Dune may add default chart options, so the GitHub options only need to be contained in Dune's.
const sameVisualization = (r: RemoteVisualization, v: VisualizationSpec) => {
  const { options, ...rest } = remoteVisualization(r);
  const { options: wanted, ...wantedRest } = desiredVisualization(v);
  return canonicalJson(rest) === canonicalJson(wantedRest) && contains(options, wanted);
};

export function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => contains(actual[i], e));
  if (expected && typeof expected === "object")
    return (
      !!actual &&
      typeof actual === "object" &&
      Object.entries(expected).every(([k, e]) => contains((actual as Record<string, unknown>)[k], e))
    );
  return actual === expected;
}

const sameDashboard = (r: RemoteDashboard, d: DashboardSpec, vizIds: Map<string, number | string>) => {
  const { param_widgets, ...remote } = remoteDashboard(r);
  return param_widgets.length === 0 && dashboardFingerprint(remote) === dashboardFingerprint(desiredDashboard(d, vizIds));
};

// ---------------------------------------------------------------------------------------------
// Guards

export async function checkIdentity(client: DuneClient, team: string): Promise<string> {
  const me = await client.whoami();
  if (!me.customer_id?.startsWith("team_") || me.handle !== team)
    throw new Error(
      `DUNE_API_KEY must be a key of the Dune team "${team}", but it belongs to ${me.customer_id ?? "?"} (${me.handle ?? "?"}). ` +
        "Resources are owned by the key's account, so deploying with this key would create them in the wrong place.",
    );
  return `${me.handle} (${me.customer_id})`;
}

// Reads a protected dashboard (e.g. the Beta dashboard) with its visualizations and queries.
export async function snapshotProtected(client: DuneClient, ref: string): Promise<ProtectedRecord | null> {
  const [owner, slug] = ref.split("/");
  const dashboard = await client.getDashboardBySlug(owner, slug);
  if (!dashboard) return null;
  const vizIds = (dashboard.visualization_widgets ?? []).map((w) => w.visualization_id).sort((a, b) => a - b);
  const visualizations = [];
  for (const id of vizIds) visualizations.push(await client.getVisualization(id));
  const queryIds = [
    ...new Set([
      ...visualizations.flatMap((v) => (v ? [v.query_id] : [])),
      ...(dashboard.param_widgets ?? []).map((w) => w.query_id),
    ]),
  ].sort((a, b) => a - b);
  const queries = [];
  for (const id of queryIds) {
    const q = await client.getQuery(id);
    queries.push(q && { ...remoteQuery(q), is_archived: q.is_archived, version: q.version });
  }
  return {
    dashboard_id: dashboard.dashboard_id,
    query_ids: queryIds,
    visualization_ids: vizIds,
    fingerprint: fingerprint({
      dashboard: sortedDashboard(remoteDashboard(dashboard)),
      visualizations: visualizations.map((v) => v && remoteVisualization(v)),
      queries,
    }),
    checked_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Plan

type Resolved = {
  queries: Map<string, number>;
  visualizations: Map<string, number>;
  // remote objects read while planning, reused when applying
  remoteQueries: Map<number, RemoteQuery>;
};

export async function plan(
  config: Config,
  state: State,
  client: DuneClient,
  options: { force?: boolean; guards?: Guard[] } = {},
): Promise<Plan & { resolved: Resolved }> {
  const force = options.force ?? false;
  const tag = config.project.managedTag;
  const steps: Step[] = [];
  const resolved: Resolved = { queries: new Map(), visualizations: new Map(), remoteQueries: new Map() };
  const guards = options.guards ?? [];
  const protectedIds = union(guards);

  // Decides the action for a tracked or looked-up resource from its Dune version.
  const decide = (
    tracked: { desired: string; remote: string } | undefined,
    desiredHash: string,
    remoteHash: string,
    matchesDesired: boolean,
  ): { action: Action; reason?: string } => {
    if (!tracked)
      return matchesDesired
        ? { action: "adopt", reason: "already in Dune with this configuration; recording its ID" }
        : force
          ? { action: "update", reason: "exists in Dune but not in state.json; overwriting (--force)" }
          : { action: "conflict", reason: "exists in Dune but is not recorded in state.json and differs from GitHub" };
    if (remoteHash !== tracked.remote) {
      if (matchesDesired) return { action: "adopt", reason: "edited in Dune to match GitHub; recording" };
      return force
        ? { action: "update", reason: "edited in Dune since the last deploy; overwriting (--force)" }
        : { action: "conflict", reason: "edited in Dune since the last deploy" };
    }
    return desiredHash !== tracked.desired ? { action: "update" } : { action: "noop" };
  };

  // Queries, in dependency order (config.queries is sorted so), so referenced IDs are known.
  let owned: { id: number; name: string; tags?: string[] | null }[] | undefined;
  for (const q of config.queries) {
    const tracked = state.queries[q.key];
    const desiredHash = fingerprint(desiredQuery(q, tag, resolved.queries));
    let remote: RemoteQuery | null = null;
    if (tracked) {
      remote = await client.getQuery(tracked.id);
      if (!remote || remote.is_archived) {
        steps.push(
          force
            ? { resource: "query", key: q.key, action: "create", reason: `query ${tracked.id} is missing or archived in Dune; creating a new one (--force)` }
            : { resource: "query", key: q.key, action: "conflict", id: tracked.id, reason: "missing or archived in Dune" },
        );
        continue;
      }
    } else {
      owned ??= await client.listQueries();
      for (const match of owned.filter((o) => o.name === q.name && (o.tags ?? []).includes(tag))) {
        const candidate = await client.getQuery(match.id);
        if (candidate && !candidate.is_archived) {
          remote = candidate;
          break;
        }
      }
    }
    if (!remote) {
      steps.push({ resource: "query", key: q.key, action: "create" });
      continue;
    }
    const decision = decide(tracked, desiredHash, fingerprint(remoteQuery(remote)), sameQuery(remote, q, tag, resolved.queries));
    // A referenced query that is created gets a new ID, so this query's SQL changes with it.
    const newDependency = q.dependencies.find((d) => !resolved.queries.has(d));
    if (newDependency && (decision.action === "noop" || decision.action === "adopt"))
      Object.assign(decision, { action: "update", reason: `references the new query ${newDependency}` });
    resolved.queries.set(q.key, remote.query_id);
    resolved.remoteQueries.set(remote.query_id, remote);
    steps.push({ resource: "query", key: q.key, id: remote.query_id, ...decision });
  }

  // Visualizations
  const vizSpecs = config.queries.flatMap((q) => q.visualizations);
  for (const v of vizSpecs) {
    const queryId = resolved.queries.get(v.query);
    const queryStep = steps.find((s) => s.resource === "query" && s.key === v.query);
    if (queryId === undefined || queryStep?.action === "conflict") {
      steps.push({
        resource: "visualization",
        key: v.key,
        action: queryStep?.action === "conflict" ? "conflict" : "create",
        reason: queryStep?.action === "conflict" ? `blocked by conflict on query ${v.query}` : undefined,
      });
      continue;
    }
    const tracked = state.visualizations[v.key];
    let remote: RemoteVisualization | null = null;
    if (tracked && tracked.query_id === queryId) {
      remote = await client.getVisualization(tracked.id);
      if (!remote || remote.query_id !== queryId) {
        steps.push(
          force
            ? { resource: "visualization", key: v.key, action: "create", reason: `visualization ${tracked.id} is missing in Dune; recreating (--force)` }
            : { resource: "visualization", key: v.key, action: "conflict", id: tracked.id, reason: "deleted in Dune" },
        );
        continue;
      }
    } else {
      const match = (await client.listVisualizations(queryId)).find((r) => r.name === v.name);
      if (match) remote = await client.getVisualization(match.id);
    }
    if (!remote) {
      steps.push({ resource: "visualization", key: v.key, action: "create" });
      continue;
    }
    resolved.visualizations.set(v.key, remote.id);
    const decision = decide(
      tracked?.query_id === queryId ? tracked : undefined,
      fingerprint(desiredVisualization(v)),
      fingerprint(remoteVisualization(remote)),
      sameVisualization(remote, v),
    );
    steps.push({ resource: "visualization", key: v.key, id: remote.id, ...decision });
  }

  // Dashboard
  const d = config.dashboard;
  const vizCreated = steps.some((s) => s.resource === "visualization" && s.action === "create");
  const desiredHash = dashboardFingerprint(desiredDashboard(d, resolved.visualizations));
  let remoteDash: RemoteDashboard | null = null;
  if (state.dashboard) {
    remoteDash = await client.getDashboard(state.dashboard.id);
    if (!remoteDash)
      steps.push(
        force
          ? { resource: "dashboard", key: d.slug, action: "create", reason: `dashboard ${state.dashboard.id} is missing; creating (--force)` }
          : { resource: "dashboard", key: d.slug, action: "conflict", id: state.dashboard.id, reason: "missing or archived in Dune" },
      );
  } else {
    remoteDash = await client.getDashboardBySlug(config.project.team, d.slug);
    if (!remoteDash) steps.push({ resource: "dashboard", key: d.slug, action: "create" });
  }
  if (remoteDash) {
    const decision = decide(
      state.dashboard ?? undefined,
      desiredHash,
      dashboardFingerprint(remoteDashboard(remoteDash)),
      sameDashboard(remoteDash, d, resolved.visualizations),
    );
    const action = decision.action === "noop" && vizCreated ? "update" : decision.action;
    steps.push({ resource: "dashboard", key: d.slug, id: remoteDash.dashboard_id, ...decision, action });
  }

  // Resources removed from the configuration. Visualizations are deleted (they are fully defined
  // in GitHub history); queries are archived, which Dune can undo.
  const vizKeys = new Set(vizSpecs.map((v) => v.key));
  const queryKeys = new Set(config.queries.map((q) => q.key));
  for (const [key, tracked] of Object.entries(state.visualizations)) {
    if (vizKeys.has(key)) continue;
    if (!queryKeys.has(key.split("/")[0])) continue; // goes with its archived query
    const remote = await client.getVisualization(tracked.id);
    if (!remote) {
      steps.push({ resource: "visualization", key, action: "delete", id: tracked.id, reason: "already gone in Dune" });
      continue;
    }
    const changed = fingerprint(remoteVisualization(remote)) !== tracked.remote;
    steps.push(
      changed && !force
        ? { resource: "visualization", key, action: "conflict", id: tracked.id, reason: "removed from GitHub but edited in Dune since the last deploy" }
        : { resource: "visualization", key, action: "delete", id: tracked.id },
    );
  }
  for (const [key, tracked] of Object.entries(state.queries)) {
    if (queryKeys.has(key)) continue;
    const remote = await client.getQuery(tracked.id);
    if (!remote || remote.is_archived) {
      steps.push({ resource: "query", key, action: "archive", id: tracked.id, reason: "already gone in Dune" });
      continue;
    }
    const changed = fingerprint(remoteQuery(remote)) !== tracked.remote;
    steps.push(
      changed && !force
        ? { resource: "query", key, action: "conflict", id: tracked.id, reason: "removed from GitHub but edited in Dune since the last deploy" }
        : { resource: "query", key, action: "archive", id: tracked.id },
    );
  }

  // Never manage anything that belongs to a protected dashboard (or, for previews, to production).
  for (const s of steps) {
    if (s.id === undefined) continue;
    const kind = s.resource === "query" ? "queries" : s.resource === "visualization" ? "visualizations" : "dashboards";
    const guard = guards.find((g) => g.ids[kind].has(s.id!));
    if (guard) throw new Error(`${s.resource} ${s.key} resolves to Dune ID ${s.id}, which belongs to ${guard.label}`);
  }
  // Nor read a guarded query through a hard-coded query_<id>.
  for (const q of config.queries) checkReferences(q.key, desiredQuery(q, tag, resolved.queries).query_sql, guards);

  return { steps, conflicts: steps.filter((s) => s.action === "conflict"), protectedIds, resolved };
}

function checkReferences(key: string, sql: string, guards: Guard[]) {
  for (const id of sqlQueryIds(sql)) {
    const guard = guards.find((g) => g.ids.queries.has(id));
    if (guard) throw new Error(`query ${key} reads query_${id}, which belongs to ${guard.label}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Apply. Updates `next` in place after every write, so a failed run still records what it did.

export type ApplyOptions = {
  log?: (line: string) => void;
  // Previews: every query and the dashboard must be private and owned by the team. A resource
  // Dune leaves public is archived (queries) or emptied (dashboard) and the deploy stops; it never
  // continues with public resources.
  requirePrivate?: boolean;
  guards?: Guard[];
};

export async function apply(
  config: Config,
  next: State,
  client: DuneClient,
  planned: Plan & { resolved: Resolved },
  options: ApplyOptions = {},
): Promise<State> {
  const log = options.log ?? console.log;
  if (planned.conflicts.length) throw new Error("refusing to apply a plan with conflicts");
  const tag = config.project.managedTag;
  const { protectedIds } = planned;
  const stepFor = (resource: Step["resource"], key: string) =>
    planned.steps.find((s) => s.resource === resource && s.key === key);
  const guard = (ids: Set<number>, id: number) => {
    if (ids.has(id)) throw new Error(`refusing to write to protected Dune resource ${id}`);
    return id;
  };

  // Queries: create or update, then record what Dune now holds.
  const queryIds = new Map(planned.resolved.queries);
  for (const q of config.queries) {
    const step = stepFor("query", q.key)!;
    const desired = desiredQuery(q, tag, queryIds);
    checkReferences(q.key, desired.query_sql, options.guards ?? []);
    let id = step.id;
    if (step.action === "create") {
      id = await client.createQuery(desired);
      log(`created query ${q.key} -> ${id}`);
    } else if (step.action === "update") {
      guard(protectedIds.queries, id!);
      const { is_private: _, ...fields } = desired;
      await client.updateQuery(id!, fields);
      log(`updated query ${q.key} (${id})`);
    }
    let remote = step.action === "noop" || step.action === "adopt" ? planned.resolved.remoteQueries.get(id!) : await client.getQuery(id!);
    if (!remote) throw new Error(`query ${id} not readable after ${step.action}`);
    if (remote.is_private !== q.isPrivate) {
      await client.setQueryPrivate(guard(protectedIds.queries, id!), q.isPrivate);
      remote = (await client.getQuery(id!))!;
    }
    if (options.requirePrivate && !remote.is_private) {
      if (step.action === "create") await client.archiveQuery(id!);
      throw new Error(
        `query ${q.key} (${id}) is public although previews must be private` +
          (step.action === "create" ? "; the new query was archived" : "") +
          ". Check the Dune plan's private query limit.",
      );
    }
    // Ownership follows the API key, which checkIdentity confirmed is the team's; this only reports.
    if (options.requirePrivate && remote.owner && remote.owner !== config.project.team)
      log(`warning: query ${q.key} (${id}) reports owner "${remote.owner}", expected "${config.project.team}"`);
    if (!sameQuery(remote, q, tag, queryIds) && step.action !== "noop")
      log(`note: Dune normalized query ${q.key}; stored as returned by Dune`);
    queryIds.set(q.key, id!);
    next.queries[q.key] = { id: id!, desired: fingerprint(desired), remote: fingerprint(remoteQuery(remote)) };
  }

  // Visualizations
  const vizIds = new Map(planned.resolved.visualizations);
  for (const v of config.queries.flatMap((q) => q.visualizations)) {
    const step = stepFor("visualization", v.key)!;
    const queryId = queryIds.get(v.query)!;
    const desired = desiredVisualization(v);
    let id = step.id;
    if (step.action === "create") {
      id = await client.createVisualization(queryId, desired);
      log(`created visualization ${v.key} -> ${id}`);
    } else if (step.action === "update") {
      await client.updateVisualization(guard(protectedIds.visualizations, id!), desired);
      log(`updated visualization ${v.key} (${id})`);
    }
    const remote = await client.getVisualization(id!);
    if (!remote) throw new Error(`visualization ${id} not readable after ${step.action}`);
    vizIds.set(v.key, id!);
    next.visualizations[v.key] = {
      id: id!,
      query_id: queryId,
      desired: fingerprint(desired),
      remote: fingerprint(remoteVisualization(remote)),
    };
  }

  // Dashboard: created with its name only, then given its slug, text and layout.
  const d = config.dashboard;
  const dStep = stepFor("dashboard", d.slug)!;
  const desired = desiredDashboard(d, vizIds);
  let dashboard: RemoteDashboard | null;
  let dashId = dStep.id;
  if (dStep.action === "create") {
    const created = await client.createDashboard({ name: d.name, is_private: d.isPrivate });
    dashId = created.dashboard_id;
    // Record it before configuring it, so a failure below does not lose the ID.
    next.dashboard = { id: dashId, url: created.dashboard_url, desired: "", remote: dashboardFingerprint(remoteDashboard(created)) };
    log(`created dashboard ${d.slug} -> ${dashId}`);
    // A new dashboard has no widgets yet; check privacy before adding any.
    if (options.requirePrivate) {
      const readBack = (await client.getDashboard(dashId)) ?? created;
      if (!readBack.is_private)
        throw new Error(
          `dashboard ${d.slug} (${dashId}) was created public although it was requested private; ` +
            "previews must be private. It has no widgets. Check the Dune plan's private dashboard limit.",
        );
    }
  }
  if (dStep.action === "create" || dStep.action === "update") {
    const body: DashboardWrite = { ...desired, visualization_widgets: desired.visualization_widgets as DashboardWrite["visualization_widgets"] };
    dashboard = await client.updateDashboard(guard(protectedIds.dashboards, dashId!), body);
    dashboard = (await client.getDashboard(dashId!)) ?? dashboard;
    log(`updated dashboard ${d.slug} (${dashId})`);
  } else dashboard = await client.getDashboard(dashId!);
  if (!dashboard) throw new Error(`dashboard ${dashId} not readable`);
  if (options.requirePrivate && !dashboard.is_private) {
    await client.updateDashboard(dashId!, { visualization_widgets: [], text_widgets: [] });
    throw new Error(`dashboard ${d.slug} (${dashId}) is public; previews must be private. Its widgets were removed.`);
  }
  if (dashboard.slug !== d.slug)
    log(`warning: Dune set the dashboard slug to "${dashboard.slug}" instead of "${d.slug}"`);
  next.dashboard = {
    id: dashboard.dashboard_id,
    url: dashboard.dashboard_url,
    desired: dashboardFingerprint(desired),
    remote: dashboardFingerprint(remoteDashboard(dashboard)),
  };

  // Removals, after the dashboard no longer references them.
  for (const s of planned.steps) {
    if (s.action === "delete") {
      if (s.reason !== "already gone in Dune") await client.deleteVisualization(guard(protectedIds.visualizations, s.id!));
      delete next.visualizations[s.key];
      log(`deleted visualization ${s.key} (${s.id})`);
    } else if (s.action === "archive") {
      if (s.reason !== "already gone in Dune") await client.archiveQuery(guard(protectedIds.queries, s.id!));
      delete next.queries[s.key];
      for (const k of Object.keys(next.visualizations)) if (k.startsWith(`${s.key}/`)) delete next.visualizations[k];
      log(`archived query ${s.key} (${s.id})`);
    }
  }
  return next;
}

export function formatPlan(p: Plan): string {
  const lines = p.steps.map(
    (s) =>
      `${s.action.padEnd(8)} ${s.resource.padEnd(13)} ${s.key}${s.id === undefined ? "" : ` (${s.id})`}${s.reason ? ` - ${s.reason}` : ""}`,
  );
  const counts = Object.entries(Object.groupBy(p.steps, (s) => s.action)).map(([a, s]) => `${s?.length} ${a}`);
  return [...lines, "", `Plan: ${counts.join(", ")}`].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Full deployment as run by `deploy` and CI.

export type DeployOptions = {
  dryRun?: boolean;
  force?: boolean;
  log?: (line: string) => void;
  // Persists state after apply, also when apply fails partway.
  save?: (state: State) => Promise<void>;
  // Previews: production resources (and anything else) that must never be written or referenced.
  guards?: Guard[];
  requirePrivate?: boolean;
};

export async function runDeploy(config: Config, state: State, client: DuneClient, options: DeployOptions = {}) {
  const log = options.log ?? console.log;
  log(`Dune account: ${await checkIdentity(client, config.project.team)}`);

  // Protected dashboards: collect their IDs so they are never managed, and fingerprint them to
  // check the deploy left them unchanged.
  const before = new Map<string, ProtectedRecord>();
  const guards: Guard[] = [...(options.guards ?? [])];
  for (const ref of config.project.protectedDashboards) {
    const snap = await snapshotProtected(client, ref);
    if (!snap)
      throw new Error(
        `protected dashboard ${ref} could not be read, so its resources cannot be protected; ` +
          "fix or remove it in dune/project.yaml",
      );
    before.set(ref, snap);
    guards.push({
      label: `the protected dashboard ${ref}`,
      ids: { dashboards: new Set([snap.dashboard_id]), queries: new Set(snap.query_ids), visualizations: new Set(snap.visualization_ids) },
    });
    log(`protected ${ref}: dashboard ${snap.dashboard_id}, ${snap.query_ids.length} queries, ${snap.visualization_ids.length} visualizations`);
  }

  const planned = await plan(config, state, client, { force: options.force, guards });
  log(`\n${formatPlan(planned)}\n`);
  if (planned.conflicts.length || options.dryRun) {
    if (client.writes.length) throw new Error(`planning made writes: ${client.writes.join(", ")}`);
    return { plan: planned, state, writes: [] as string[] };
  }

  const next: State = structuredClone(state);
  try {
    if (planned.steps.some((s) => s.action !== "noop"))
      await apply(config, next, client, planned, { log, requirePrivate: options.requirePrivate, guards });
    else log("Nothing to deploy.");
  } finally {
    // Record protected dashboard IDs; keep the old record (and timestamp) when nothing changed.
    for (const [ref, snap] of before) {
      const old = next.protected[ref];
      if (!old || old.fingerprint !== snap.fingerprint) next.protected[ref] = snap;
    }
    await options.save?.(next);
  }

  for (const [ref, snap] of before) {
    const after = await snapshotProtected(client, ref);
    if (after?.fingerprint !== snap.fingerprint)
      throw new Error(`protected dashboard ${ref} changed during this deploy (${snap.fingerprint} -> ${after?.fingerprint})`);
    log(`protected ${ref} unchanged`);
  }
  return { plan: planned, state: next, writes: [...client.writes] };
}
