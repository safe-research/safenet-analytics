// Command line entry point. Run `node src/cli.ts help` for usage.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { applyCleanup, formatCleanup, planCleanup } from "./cleanup.ts";
import { DEFAULT_ROOT, inlineSql, loadConfig, referencedColumns, type Config } from "./config.ts";
import { checkIdentity, desiredQuery, formatPlan, runDeploy, snapshotProtected } from "./deploy.ts";
import { DuneClient } from "./dune.ts";
import { fingerprint } from "./hash.ts";
import { assertDisjoint, loadPreviewSettings, productionGuard, toPreview, type PreviewSettings } from "./preview.ts";
import { runPreviewQueries } from "./preview-run.ts";
import { refresh, selectQueries, succeeded } from "./refresh.ts";
import { DECODING_CANDIDATES } from "./safenet.ts";
import { loadState, saveState, STATE_PATH, type State } from "./state.ts";

const USAGE = `Usage: node src/cli.ts <command> [options]

Commands:
  validate                 Check dune/ offline (no API key needed)
  whoami                   Show the account behind DUNE_API_KEY
  deploy [--dry-run] [--force]
                           Create or update queries, visualizations and the dashboard.
                           --dry-run reads Dune and prints the plan without writing.
                           --force overwrites resources edited directly in Dune.
  refresh [--schedule daily] [--query KEY ...]
                           Execute deployed queries (daily schedule by default)
  check-sql [--all]
                           Run changed (or all) queries' SQL on Dune without saving it and
                           check that visualized columns exist in the result
  check-decoded            Look up the production contracts in Dune's decoded contract tables
  pull                     Write the current Dune versions of managed resources to dune/.remote/
  protected                Show protected dashboards (e.g. Beta) and the IDs they use

Previews (docs/preview.md). They use --state (default dune/.preview/<track>.json) for the preview
IDs and --production-state (default dune/state.json) for the production IDs they must not touch:
  deploy --preview --sha SHA [--pr N] [--repository OWNER/NAME] [--track T] [--dry-run] [--out FILE]
                           Deploy the private preview of dune/ (always overwrites Dune edits)
  run-preview [--track T] [--force] [--baseline DIR]
                           Execute changed preview queries within the cost caps in dune/preview.yaml;
                           with --baseline (main's dune/ directory), skip queries whose SQL equals it
  cleanup-preview [--track T] [--dry-run]
                           Archive or delete a track's preview resources after checking dependencies
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    schedule: { type: "string", default: "daily" },
    query: { type: "string", multiple: true },
    all: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
    preview: { type: "boolean", default: false },
    track: { type: "string" },
    state: { type: "string" },
    "production-state": { type: "string" },
    sha: { type: "string" },
    pr: { type: "string" },
    repository: { type: "string" },
    out: { type: "string" },
    baseline: { type: "string" },
  },
});

const summary = async (markdown: string) => {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
};

const client = () => new DuneClient(process.env.DUNE_API_KEY ?? "");

async function deploy(config: Config, state: State) {
  const dryRun = values["dry-run"];
  const result = await runDeploy(config, state, client(), { dryRun, force: values.force, save: saveState });
  await summary(`### Dune ${dryRun ? "plan (dry run)" : "deploy"}\n\n\`\`\`\n${formatPlan(result.plan)}\n\`\`\`\n`);
  if (result.plan.conflicts.length) {
    console.error(
      "Conflicts: these resources were changed directly in Dune since the last deploy.\n" +
        "Run `npm run dune -- pull` to inspect the Dune versions, copy wanted changes into dune/,\n" +
        "or rerun with --force to overwrite them. See docs/deployment.md.",
    );
    process.exitCode = 1;
    return;
  }
  if (!dryRun) {
    console.log(`\nDashboard: ${result.state.dashboard?.url}`);
    await summary(`Dashboard: ${result.state.dashboard?.url}\n`);
  }
}

async function checkSql(config: Config, state: State) {
  const dune = client();
  const ids = new Map(Object.entries(state.queries).map(([k, t]) => [k, t.id]));
  const queries = values.all
    ? config.queries
    : config.queries.filter((q) => {
        const tracked = state.queries[q.key];
        return !tracked || tracked.desired !== fingerprint(desiredQuery(q, config.project.managedTag, ids));
      });
  if (!queries.length) {
    console.log("No changed queries to check.");
    return;
  }
  let failed = false;
  const lines = [];
  for (const q of queries) {
    // References are inlined, so changed SQL of a referenced query is checked too.
    const status = await dune.waitForExecution(await dune.executeSql(inlineSql(q, config.queries), q.performance), 20 * 60_000);
    if (status.state !== "QUERY_STATE_COMPLETED") {
      failed = true;
      lines.push(`- ${q.key}: ${status.state} ${status.error?.message ?? ""}`);
      continue;
    }
    const result = await dune.executionResults(status.execution_id, 5);
    const missing = q.visualizations.flatMap((v) => referencedColumns(v).filter((c) => !result.columns.includes(c)));
    if (missing.length) failed = true;
    lines.push(
      `- ${q.key}: ok, columns ${result.columns.join(", ")}` +
        (missing.length ? `; visualized columns missing from result: ${missing.join(", ")}` : ""),
    );
  }
  console.log(lines.join("\n"));
  await summary(`### SQL check\n\n${lines.join("\n")}\n`);
  if (failed) process.exitCode = 1;
}

async function pull(config: Config, state: State) {
  const dune = client();
  const dir = join(DEFAULT_ROOT, ".remote");
  await mkdir(dir, { recursive: true });
  for (const q of config.queries) {
    const id = state.queries[q.key]?.id;
    const remote = id && (await dune.getQuery(id));
    if (!remote) continue;
    await mkdir(join(dir, q.key), { recursive: true });
    await writeFile(join(dir, q.key, "query.sql"), remote.query_sql);
    const visualizations: Record<string, unknown> = {};
    for (const v of q.visualizations) {
      const vid = state.visualizations[v.key]?.id;
      const rv = vid && (await dune.getVisualization(vid));
      if (rv) visualizations[v.key.split("/")[1]] = { name: rv.name, type: rv.type, description: rv.description, options: rv.options };
    }
    await writeFile(
      join(dir, q.key, "query.yaml"),
      stringify({ name: remote.name, description: remote.description, private: remote.is_private, tags: remote.tags, parameters: remote.parameters, visualizations }),
    );
  }
  if (state.dashboard) {
    const d = await dune.getDashboard(state.dashboard.id);
    if (d) await writeFile(join(dir, "dashboard.json"), `${JSON.stringify(d, null, 2)}\n`);
  }
  console.log(`Wrote Dune versions to ${dir}. Compare with: diff -ru dune/.remote dune/queries`);
}

// ---------------------------------------------------------------------------------------------
// Previews

type PreviewContext = { settings: PreviewSettings; statePath: string; preview: State; production: State };

async function previewContext(): Promise<PreviewContext> {
  const settings = await loadPreviewSettings(DEFAULT_ROOT, values.track);
  const statePath = values.state ?? join(DEFAULT_ROOT, ".preview", `${settings.track}.json`);
  const preview = await loadState(statePath);
  const production = await loadState(values["production-state"] ?? STATE_PATH);
  assertDisjoint(preview, production);
  return { settings, statePath, preview, production };
}

const savePreview = (path: string) => async (s: State) => {
  await mkdir(dirname(path), { recursive: true });
  await saveState(s, path);
};

async function deployPreview(config: Config) {
  const ctx = await previewContext();
  const sha = values.sha ?? process.env.GITHUB_SHA;
  if (!sha) throw new Error("--sha is required for preview deploys");
  const previewConfig = toPreview(config, ctx.settings, {
    sha,
    pr: values.pr ? Number(values.pr) : undefined,
    repository: values.repository ?? process.env.GITHUB_REPOSITORY,
  });
  const dryRun = values["dry-run"];
  const result = await runDeploy(previewConfig, ctx.preview, client(), {
    dryRun,
    force: true, // previews are disposable; Dune edits to them are overwritten
    save: savePreview(ctx.statePath),
    guards: [productionGuard(ctx.production)],
    requirePrivate: true,
  });
  const plan = formatPlan(result.plan);
  await summary(`### Preview ${dryRun ? "plan (dry run)" : "deploy"}: track ${ctx.settings.track}, commit ${sha.slice(0, 7)}\n\n\`\`\`\n${plan}\n\`\`\`\n`);
  if (values.out)
    await writeFile(
      values.out,
      `${JSON.stringify(
        {
          track: ctx.settings.track,
          sha,
          dry_run: dryRun,
          url: result.state.dashboard?.url ?? null,
          dashboard_id: result.state.dashboard?.id ?? null,
          queries: Object.fromEntries(Object.entries(result.state.queries).map(([k, t]) => [k, t.id])),
          visualizations: Object.fromEntries(Object.entries(result.state.visualizations).map(([k, t]) => [k, t.id])),
          creates: result.plan.steps.filter((s) => s.action === "create").length,
          plan,
        },
        null,
        2,
      )}\n`,
    );
  if (!dryRun) console.log(`\nPreview dashboard (private): ${result.state.dashboard?.url}`);
}

async function runPreview(config: Config) {
  const ctx = await previewContext();
  const previewConfig = toPreview(config, ctx.settings, { sha: values.sha ?? "unknown" });
  try {
    const baseline = values.baseline ? await loadConfig(values.baseline) : undefined;
    const runs = await runPreviewQueries(previewConfig, ctx.preview, client(), ctx.settings, { force: values.force, baseline });
    await summary(
      `### Preview executions\n\n${runs.map((r) => `- ${r.key} (${r.query_id}): ${r.action}${r.credits === undefined ? "" : `, ${r.credits} credits`}`).join("\n")}\n`,
    );
    // Queries with preview results (executed now or before), for the workflow's verification steps.
    const previewed = runs.filter((r) => r.action !== "same as production").map((r) => r.key);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `previewed= ${previewed.join(" ")} \n`);
  } finally {
    await savePreview(ctx.statePath)(ctx.preview);
  }
}

async function cleanupPreview(config: Config) {
  const ctx = await previewContext();
  const dune = client();
  console.log(`Dune account: ${await checkIdentity(dune, config.project.team)}`);
  const p = await planCleanup(ctx.settings.track, ctx.preview, ctx.production, dune, {
    team: config.project.team,
    protectedDashboards: config.project.protectedDashboards,
  });
  const text = formatCleanup(p);
  console.log(text);
  await summary(`### Preview cleanup${values["dry-run"] ? " (dry run)" : ""}\n\n\`\`\`\n${text}\n\`\`\`\n`);
  if (p.blockers.length) {
    process.exitCode = 1;
    return;
  }
  if (values["dry-run"]) {
    if (dune.writes.length) throw new Error(`cleanup dry run made writes: ${dune.writes.join(", ")}`);
    return;
  }
  const { state, manual } = await applyCleanup(p, dune);
  await savePreview(ctx.statePath)(state);
  if (manual.length) {
    console.log(`\nManual steps:\n${manual.map((m) => `- ${m}`).join("\n")}`);
    await summary(`Manual steps:\n\n${manual.map((m) => `- ${m}`).join("\n")}\n`);
  }
}

async function checkDecoded() {
  const dune = client();
  const byChain = Object.groupBy(DECODING_CANDIDATES, (c) => c.chain);
  const sql = Object.entries(byChain)
    .map(
      ([chain, cs]) =>
        `select '${chain}' as chain, namespace, name, address from ${chain}.contracts where address in (${cs!.map((c) => c.address).join(", ")})`,
    )
    .join("\nunion all\n");
  const status = await dune.waitForExecution(await dune.executeSql(sql, "medium"), 10 * 60_000);
  if (status.state !== "QUERY_STATE_COMPLETED") throw new Error(`check-decoded: ${status.state} ${status.error?.message ?? ""}`);
  const rows = (await dune.executionResults(status.execution_id, 100)).rows;
  const lines = DECODING_CANDIDATES.map((c) => {
    const found = rows.filter((r) => String(r.address).toLowerCase() === c.address && r.chain === c.chain);
    return found.length
      ? `- ${c.name} (${c.chain} ${c.address}): decoded as ${found.map((r) => `${r.namespace}_${c.chain}.${r.name}_evt_*`).join(", ")}`
      : `- ${c.name} (${c.chain} ${c.address}): not decoded`;
  });
  const text = `Checked ${new Date().toISOString()} (${status.execution_cost_credits ?? "?"} credits):\n${lines.join("\n")}`;
  console.log(text);
  await summary(`### Decoded contracts\n\n${text}\n`);
}

async function main() {
  const command = positionals[0] ?? "help";
  if (values.help || command === "help") {
    console.log(USAGE);
    return;
  }
  const config = await loadConfig();
  const state = await loadState();
  switch (command) {
    case "validate": {
      const vizCount = config.queries.reduce((n, q) => n + q.visualizations.length, 0);
      console.log(`OK: ${config.queries.length} queries, ${vizCount} visualizations, dashboard ${config.project.team}/${config.dashboard.slug}`);
      const untracked = config.queries.filter((q) => !state.queries[q.key]).map((q) => q.key);
      if (untracked.length) console.log(`Not deployed yet: ${untracked.join(", ")}`);
      return;
    }
    case "whoami":
      console.log(await checkIdentity(client(), config.project.team));
      return;
    case "deploy":
      return values.preview ? deployPreview(config) : deploy(config, state);
    case "run-preview":
      return runPreview(config);
    case "cleanup-preview":
      return cleanupPreview(config);
    case "check-decoded":
      return checkDecoded();
    case "refresh": {
      const queries = selectQueries(config, { schedule: values.schedule, keys: values.query });
      const results = await refresh(queries, state, client());
      await summary(`### Refresh\n\n${results.map((r) => `- ${r.key} (${r.id}): ${r.status.state}`).join("\n")}\n`);
      if (!results.every(succeeded)) process.exitCode = 1;
      return;
    }
    case "check-sql":
      return checkSql(config, state);
    case "pull":
      return pull(config, state);
    case "protected": {
      const dune = client();
      for (const ref of config.project.protectedDashboards) console.log(ref, await snapshotProtected(dune, ref));
      return;
    }
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
