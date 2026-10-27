// Removes a preview track's Dune resources after its work has been merged and verified
// (docs/preview.md#cleanup). Nothing runs automatically; `cleanup-preview` is started by hand.
//
// A resource is removed only if it is recorded in the track's preview state, carries the track's
// tag (queries) or belongs to such a query (visualizations), is private, and is neither a
// production resource nor part of a protected dashboard. Before any write, every other query the
// team owns is checked for query_<id> references to the candidates; any such dependency, or a
// candidate that fails one of the conditions, stops the cleanup with nothing changed.

import { snapshotProtected, sqlQueryIds, type Guard } from "./deploy.ts";
import { DuneApiError, type DuneClient, type RemoteQuery } from "./dune.ts";
import { assertDisjoint, isPreviewSlug, previewTrackTag, productionGuard } from "./preview.ts";
import { emptyState, type State } from "./state.ts";

export type CleanupItem = {
  resource: "query" | "visualization" | "dashboard";
  key: string;
  id: number;
  action: "archive" | "delete" | "remove" | "forget" | "keep";
  reason: string;
};

export type CleanupPlan = { track: string; items: CleanupItem[]; blockers: string[]; notes: string[] };

export async function planCleanup(
  track: string,
  preview: State,
  production: State,
  client: DuneClient,
  options: { team: string; protectedDashboards: string[] },
): Promise<CleanupPlan> {
  assertDisjoint(preview, production);
  const tag = previewTrackTag(track);
  const items: CleanupItem[] = [];
  const blockers: string[] = [];
  const notes: string[] = [];

  const guards: Guard[] = [productionGuard(production)];
  for (const ref of options.protectedDashboards) {
    const snap = await snapshotProtected(client, ref);
    if (!snap) {
      blockers.push(`protected dashboard ${ref} could not be read, so its resources cannot be excluded`);
      continue;
    }
    guards.push({
      label: `the protected dashboard ${ref}`,
      ids: { dashboards: new Set([snap.dashboard_id]), queries: new Set(snap.query_ids), visualizations: new Set(snap.visualization_ids) },
    });
  }
  const guarded = (kind: "queries" | "visualizations" | "dashboards", id: number) => guards.find((g) => g.ids[kind].has(id));

  // Queries
  const candidates = new Set<number>();
  for (const [key, t] of Object.entries(preview.queries)) {
    const g = guarded("queries", t.id);
    if (g) {
      blockers.push(`query ${key} (${t.id}) belongs to ${g.label}`);
      continue;
    }
    const q = await client.getQuery(t.id);
    if (!q || q.is_archived) {
      items.push({ resource: "query", key, id: t.id, action: "forget", reason: "already archived or gone in Dune" });
      continue;
    }
    if (!(q.tags ?? []).includes(tag) || !q.is_private) {
      blockers.push(`query ${key} (${t.id}) is not a private query tagged ${tag}; not a preview resource of this track`);
      continue;
    }
    for (const field of ["schedule", "refresh_schedule", "schedules"])
      if ((q as Record<string, unknown>)[field])
        notes.push(`query ${key} (${t.id}) has a Dune-side ${field}; it stops with archiving, check it is gone in the Dune UI`);
    candidates.add(t.id);
    items.push({ resource: "query", key, id: t.id, action: "archive", reason: `private, tagged ${tag}` });
  }

  // Visualizations
  const vizCandidates = new Set<number>();
  for (const [key, t] of Object.entries(preview.visualizations)) {
    const g = guarded("visualizations", t.id);
    if (g) {
      blockers.push(`visualization ${key} (${t.id}) belongs to ${g.label}`);
      continue;
    }
    const v = await client.getVisualization(t.id);
    if (!v) {
      items.push({ resource: "visualization", key, id: t.id, action: "forget", reason: "already gone in Dune" });
      continue;
    }
    if (!candidates.has(v.query_id)) {
      if (items.some((i) => i.resource === "query" && i.id === v.query_id && i.action === "forget")) {
        items.push({ resource: "visualization", key, id: t.id, action: "forget", reason: "its query is archived" });
        continue;
      }
      blockers.push(`visualization ${key} (${t.id}) belongs to query ${v.query_id}, which is not a cleanup candidate`);
      continue;
    }
    vizCandidates.add(t.id);
    items.push({ resource: "visualization", key, id: t.id, action: "delete", reason: `on preview query ${v.query_id}` });
  }

  // Dashboards
  for (const [key, t] of Object.entries(preview.dashboards)) {
    const id = t.id;
    const g = guarded("dashboards", id);
    const d = g ? null : await client.getDashboard(id);
    if (g) blockers.push(`dashboard ${key} (${id}) belongs to ${g.label}`);
    else if (!d) items.push({ resource: "dashboard", key: t.url, id, action: "forget", reason: "already gone in Dune" });
    else if (d.name.startsWith(ARCHIVED) && !d.visualization_widgets?.length && !d.text_widgets?.length && d.is_private)
      items.push({ resource: "dashboard", key: d.slug, id, action: "forget", reason: "already emptied and archived by an earlier cleanup" });
    else {
      const foreign = (d.visualization_widgets ?? []).map((w) => w.visualization_id).filter((v) => !vizCandidates.has(v));
      if (!d.is_private) blockers.push(`dashboard ${d.slug} (${id}) is public; previews are private, check it is the right dashboard`);
      if (foreign.length) blockers.push(`dashboard ${d.slug} (${id}) shows visualizations that are not preview resources: ${foreign.join(", ")}`);
      if (!isPreviewSlug(d.slug)) blockers.push(`dashboard ${id} has slug ${d.slug}, not a preview slug`);
      items.push({ resource: "dashboard", key: d.slug, id, action: "remove", reason: "preview dashboard of this track" });
    }
  }

  // Dependencies: nothing outside the candidates may read them.
  if (candidates.size) {
    for (const o of await client.listQueries()) {
      if (candidates.has(o.id)) continue;
      const q: RemoteQuery | null = await client.getQuery(o.id);
      if (!q || q.is_archived) continue;
      const refs = sqlQueryIds(q.query_sql ?? "").filter((id) => candidates.has(id));
      if (refs.length) blockers.push(`query ${o.id} ("${q.name}") reads ${refs.map((r) => `query_${r}`).join(", ")}`);
    }
  }
  for (const [kind, label] of [
    ["queries", "production queries"],
    ["visualizations", "production and protected visualizations"],
  ] as const)
    notes.push(`kept: all ${label} (${guards.reduce((n, g) => n + g.ids[kind].size, 0)} IDs)`);
  notes.push("Dashboards cannot be listed through the API: a preview visualization added by hand to another dashboard is not detected.");
  return { track, items, blockers, notes };
}

export function formatCleanup(p: CleanupPlan): string {
  return [
    `Preview cleanup, track ${p.track}`,
    ...p.items.map((i) => `${i.action.padEnd(8)} ${i.resource.padEnd(13)} ${i.key} (${i.id}) - ${i.reason}`),
    ...(p.blockers.length ? ["", "Blocked, nothing will be changed:", ...p.blockers.map((b) => `  - ${b}`)] : []),
    "",
    ...p.notes.map((n) => `note: ${n}`),
  ].join("\n");
}

const ARCHIVED = "[Archived] ";

// Applies a plan without blockers: dashboards first (so they no longer show the visualizations),
// then visualizations, then queries. Returns the emptied preview state.
//
// Dune sometimes refuses to delete a visualization (HTTP 5xx). Such a visualization is left in
// place: it belongs to a private preview query that is archived next, so nothing shows it, and the
// run lists it. The queries are archived regardless, so a refused delete never leaves a track
// half cleaned up.
export async function applyCleanup(
  p: CleanupPlan,
  client: DuneClient,
  log: (line: string) => void = console.log,
): Promise<{ state: State; manual: string[] }> {
  if (p.blockers.length) throw new Error("refusing to clean up: the plan has blockers");
  const manual: string[] = [];
  for (const i of p.items.filter((x) => x.resource === "dashboard" && x.action === "remove")) {
    await client.updateDashboard(i.id, {
      name: `${ARCHIVED}Safenet preview ${p.track}`,
      is_private: true,
      visualization_widgets: [],
      text_widgets: [],
    });
    if (await client.archiveDashboard(i.id)) log(`archived dashboard ${i.key} (${i.id})`);
    else {
      log(`emptied dashboard ${i.key} (${i.id}); the API cannot archive it`);
      manual.push(
        `Delete the emptied dashboard ${i.id} in Dune: open dune.com/safe/${i.key}, then dashboard settings, Delete (or Archive). ` +
          "It is private and has no widgets.",
      );
    }
  }
  const kept: CleanupItem[] = [];
  for (const i of p.items.filter((x) => x.resource === "visualization" && x.action === "delete")) {
    try {
      await client.deleteVisualization(i.id);
      log(`deleted visualization ${i.key} (${i.id})`);
    } catch (e) {
      if (!(e instanceof DuneApiError && e.status >= 500)) throw e;
      kept.push(i);
      log(`Dune refused to delete visualization ${i.key} (${i.id}): ${e.message}; it stays on its archived query`);
    }
  }
  for (const i of p.items.filter((x) => x.resource === "query" && x.action === "archive")) {
    await client.archiveQuery(i.id);
    log(`archived query ${i.key} (${i.id})`);
  }
  if (kept.length)
    manual.push(
      `Dune refused to delete ${kept.length} visualizations (${kept.map((i) => i.id).join(", ")}). They remain on their archived, ` +
        "private preview queries and are shown nowhere; nothing needs to be done unless you want them gone (delete them in the Dune UI).",
    );
  return { state: emptyState(), manual };
}
