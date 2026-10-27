// Preview environments for pull requests. A preview is a copy of the configuration in dune/ with
// its own private Dune resources under the same team:
//
//   - queries named "[Preview <track>] <name>" and tagged safenet-preview, safenet-preview-<track>
//     (the managed tag, so lookups never match production queries, which carry safenet-analytics);
//   - the overview "Safenet — Preview" (slug safenet-preview), or "Safenet — Preview (<track>)"
//     (slug safenet-preview-<track>) for other tracks, and each other dashboard as
//     "Safenet — Preview (<track>): <section>" (slug safenet-<key>-preview[-<track>], which cannot
//     collide with another track's overview), all with a banner naming the deployed commit and
//     links between the preview dashboards;
//   - no refresh schedule: preview queries run only after a preview deploy (`run-preview`).
//
// Preview IDs are recorded in previews/<track>.json on the dune-preview-state branch, not in
// dune/state.json. Every production ID is a guard: a preview deploy that would write to or read
// a production resource stops.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { ConfigError, DEFAULT_ROOT, OVERVIEW, type Config, type DashboardSpec, type Widget } from "./config.ts";
import type { Guard } from "./deploy.ts";
import type { Performance } from "./dune.ts";
import type { State } from "./state.ts";

export const PREVIEW_TAG = "safenet-preview";

export type PreviewSettings = {
  track: string;
  execution: {
    performance: Performance;
    timeoutMinutes: number;
    maxCreditsPerExecution: number;
    maxCreditsPerRun: number;
  };
};

export type PreviewMeta = {
  sha: string; // deployed commit
  pr?: number;
  repository?: string; // owner/name, for links in the banner
};

export async function loadPreviewSettings(root = DEFAULT_ROOT, track?: string): Promise<PreviewSettings> {
  const raw = (parse(await readFile(join(root, "preview.yaml"), "utf8")) ?? {}) as Record<string, unknown>;
  const exec = (raw.execution ?? {}) as Record<string, unknown>;
  const settings: PreviewSettings = {
    track: track ?? String(raw.track ?? "default"),
    execution: {
      performance: (exec.performance as Performance) ?? "medium",
      timeoutMinutes: Number(exec.timeout_minutes ?? 10),
      maxCreditsPerExecution: Number(exec.max_credits_per_execution ?? 25),
      maxCreditsPerRun: Number(exec.max_credits_per_run ?? 50),
    },
  };
  const problems: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(settings.track)) problems.push("preview.yaml: track must match [a-z0-9-]+ (max 31 chars)");
  if (raw.private !== true) problems.push("preview.yaml: previews must be private (private: true)");
  if (!["medium", "large"].includes(settings.execution.performance)) problems.push("preview.yaml: performance must be medium or large");
  for (const [k, v] of Object.entries(settings.execution))
    if (typeof v === "number" && !(v > 0)) problems.push(`preview.yaml: execution ${k} must be positive`);
  if (problems.length) throw new ConfigError(problems);
  return settings;
}

export const previewSlug = (track: string) => (track === "default" ? "safenet-preview" : `safenet-preview-${track}`);
export const previewTrackTag = (track: string) => `${PREVIEW_TAG}-${track}`;
export const previewName = (track: string) => (track === "default" ? "Safenet — Preview" : `Safenet — Preview (${track})`);
export const previewDashboardSlug = (track: string, key: string) =>
  key === OVERVIEW ? previewSlug(track) : `safenet-${key}-preview${track === "default" ? "" : `-${track}`}`;
// Every preview dashboard slug; production slugs never contain "preview" (src/config.ts).
export const isPreviewSlug = (slug: string) => /^safenet-(?:[a-z0-9-]+-)?preview(?:-[a-z0-9-]+)?$/.test(slug);
export const previewDashboardName = (track: string, d: DashboardSpec) =>
  d.key === OVERVIEW ? previewName(track) : `${previewName(track)}: ${d.name.replace(/^Safenet — /, "")}`;
export const previewQueryName = (track: string, name: string) =>
  `[Preview${track === "default" ? "" : ` ${track}`}] ${name}`;

const BANNER_ROWS = 2;

export function previewBanner(track: string, meta: PreviewMeta, previewOnly = false): string {
  const commit = meta.repository
    ? `[\`${meta.sha.slice(0, 7)}\`](https://github.com/${meta.repository}/commit/${meta.sha})`
    : `\`${meta.sha.slice(0, 7)}\``;
  const pr = meta.pr
    ? meta.repository
      ? ` of [PR #${meta.pr}](https://github.com/${meta.repository}/pull/${meta.pr})`
      : ` of PR #${meta.pr}`
    : "";
  return [
    `**Preview, not production.** Track \`${track}\`${pr}, commit ${commit}.`,
    previewOnly
      ? "Private to the safe team. This dashboard exists only in previews and is never deployed to production."
      : "Private to the safe team. Production: [dune.com/safe/safenet](https://dune.com/safe/safenet).",
  ].join(" ");
}

// The preview counterpart of the production configuration: same SQL, charts, text and layout,
// with preview names, tags, privacy and slug, and a banner on top.
export function toPreview(config: Config, settings: PreviewSettings, meta: PreviewMeta): Config {
  const { track } = settings;
  const preview = structuredClone(config);
  preview.project = {
    ...preview.project,
    managedTag: previewTrackTag(track),
  };
  preview.queries = preview.queries.map((q) => ({
    ...q,
    name: previewQueryName(track, q.name),
    description: `Preview (track ${track}) of a Safenet production query; not production. ${q.description}`,
    isPrivate: true,
    tags: [PREVIEW_TAG],
    refresh: "none",
  }));
  preview.dashboards = preview.dashboards.map((d) => {
    const shifted: Widget[] = d.widgets.map((w) => ({
      ...w,
      position: { ...w.position, row: w.position.row + BANNER_ROWS },
    }));
    const banner = previewBanner(track, meta, d.previewOnly);
    return {
      key: d.key,
      name: previewDashboardName(track, d),
      slug: previewDashboardSlug(track, d.key),
      isPrivate: true,
      tags: [PREVIEW_TAG],
      previewOnly: false, // deployed in the preview
      widgets: [{ kind: "text", text: banner, position: { row: 0, col: 0, size_x: 6, size_y: BANNER_ROWS } }, ...shifted],
    };
  });
  return preview;
}

// Every resource recorded in the production state. Preview deploys must not write to or read them.
export function productionGuard(production: State): Guard {
  return {
    label: "production (dune/state.json on main)",
    ids: {
      dashboards: new Set(Object.values(production.dashboards).map((d) => d.id)),
      queries: new Set(Object.values(production.queries).map((q) => q.id)),
      visualizations: new Set(Object.values(production.visualizations).map((v) => v.id)),
    },
  };
}

// Also the other way round: a preview state must not contain production IDs (for example after
// copying a state file by mistake).
export function assertDisjoint(preview: State, production: State) {
  const guard = productionGuard(production);
  const clash = [
    ...Object.entries(preview.queries).filter(([, t]) => guard.ids.queries.has(t.id)).map(([k, t]) => `query ${k} (${t.id})`),
    ...Object.entries(preview.visualizations)
      .filter(([, t]) => guard.ids.visualizations.has(t.id))
      .map(([k, t]) => `visualization ${k} (${t.id})`),
    ...Object.entries(preview.dashboards)
      .filter(([, t]) => guard.ids.dashboards.has(t.id))
      .map(([k, t]) => `dashboard ${k} (${t.id})`),
  ];
  if (clash.length) throw new Error(`the preview state contains production resources: ${clash.join(", ")}`);
}
