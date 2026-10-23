// Command line entry point. Run `node src/cli.ts help` for usage.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { DEFAULT_ROOT, loadConfig, referencedColumns, type Config } from "./config.ts";
import { checkIdentity, desiredQuery, formatPlan, runDeploy, snapshotProtected } from "./deploy.ts";
import { DuneClient } from "./dune.ts";
import { fingerprint } from "./hash.ts";
import { refresh, selectQueries, succeeded } from "./refresh.ts";
import { loadState, saveState, type State } from "./state.ts";

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
  pull                     Write the current Dune versions of managed resources to dune/.remote/
  protected                Show protected dashboards (e.g. Beta) and the IDs they use
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
  const queries = values.all
    ? config.queries
    : config.queries.filter((q) => {
        const tracked = state.queries[q.key];
        return !tracked || tracked.desired !== fingerprint(desiredQuery(q, config.project.managedTag));
      });
  if (!queries.length) {
    console.log("No changed queries to check.");
    return;
  }
  let failed = false;
  const lines = [];
  for (const q of queries) {
    const status = await dune.waitForExecution(await dune.executeSql(q.sql, q.performance), 20 * 60_000);
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
      return deploy(config, state);
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
