import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, DEFAULT_ROOT, loadConfig } from "../src/config.ts";

async function withConfig(edit: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dune-config-"));
  await cp(DEFAULT_ROOT, root, { recursive: true });
  await edit(root);
  return loadConfig(root);
}

async function problems(edit: (root: string) => Promise<void>): Promise<string[]> {
  try {
    await withConfig(edit);
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
}

const replaceIn = (root: string, file: string, from: string | RegExp, to: string) => async () => {
  const path = join(root, file);
  await writeFile(path, (await readFile(path, "utf8")).replace(from, to));
};

test("the repository configuration is valid", async () => {
  const config = await loadConfig();
  assert.equal(config.project.team, "safe");
  assert.deepEqual(config.project.protectedDashboards, ["safe/safenet-beta"]);
  assert.deepEqual(
    config.dashboards.map((d) => [d.key, d.slug]).filter(([k]) => !k.startsWith("crash-")),
    [
      ["overview", "safenet"],
      ["network-revenue", "safenet-network-revenue"],
      ["sentinels", "safenet-sentinels"],
      ["staking", "safenet-staking-withdrawals"],
      ["validators", "safenet-validators"],
    ],
  );
  assert.equal(config.queries.find((q) => q.key === "transaction_checks_daily")!.refresh, "daily");
  assert.equal(config.queries.find((q) => q.key === "safenet_events")!.refresh, "none");
});

test("rejects overlapping widgets", async () => {
  const p = await problems((root) =>
    replaceIn(root, "dashboards/overview.yaml", "{ row: 16, col: 3, size_x: 3, size_y: 8 }", "{ row: 16, col: 2, size_x: 3, size_y: 8 }")(),
  );
  assert.ok(p.some((x) => x.includes("overlaps")), p.join("\n"));
});

test("rejects widgets outside the grid", async () => {
  const p = await problems((root) =>
    replaceIn(root, "dashboards/overview.yaml", "{ row: 16, col: 3, size_x: 3, size_y: 8 }", "{ row: 16, col: 3, size_x: 4, size_y: 8 }")(),
  );
  assert.ok(p.some((x) => x.includes("outside the 6-column grid")), p.join("\n"));
});

test("rejects unknown visualizations on the dashboard", async () => {
  const p = await problems((root) => replaceIn(root, "dashboards/overview.yaml", "transaction_checks_daily/daily_chart", "nope/chart")());
  assert.ok(p.some((x) => x.includes("unknown visualization nope/chart")), p.join("\n"));
});

test("every production dashboard links to all the others", async () => {
  const config = await loadConfig();
  const production = config.dashboards.filter((d) => !d.previewOnly);
  for (const d of production) {
    const text = d.widgets.flatMap((w) => (w.kind === "text" ? [w.text] : [])).join("\n");
    for (const other of production.filter((x) => x.key !== d.key)) assert.ok(text.includes(`{{dashboard:${other.key}}}`), `${d.key} -> ${other.key}`);
  }
});

test("rejects a section dashboard without a link back to the overview", async () => {
  const p = await problems((root) =>
    replaceIn(root, "dashboards/staking.yaml", /\*\*\[← Safenet overview\]\(\{\{dashboard:overview\}\}\)\*\* · /g, "")(),
  );
  assert.ok(p.some((x) => x.includes("dashboards/staking.yaml: no link to overview")), p.join("\n"));
});

test("rejects links to unknown dashboards and hard-coded links to managed dashboards", async () => {
  const p = await problems(async (root) => {
    await replaceIn(root, "dashboards/overview.yaml", "{{dashboard:validators}})\n", "{{dashboard:validator}})\n")();
    await replaceIn(root, "text/overview_footer.md", "Definitions", "[Staking](https://dune.com/safe/safenet-staking-withdrawals). Definitions")();
  });
  assert.ok(p.some((x) => x.includes("{{dashboard:validator}} refers to an unknown dashboard")), p.join("\n"));
  assert.ok(p.some((x) => x.includes("links to dune.com/safe/safenet-staking-withdrawals directly; use {{dashboard:staking}}")), p.join("\n"));
});

test("rejects a visualization that is on no production dashboard", async () => {
  const p = await problems((root) =>
    replaceIn(root, "dashboards/sentinels.yaml", /  - visualization: sentinel_bonds\/table\n.*\n/, "")(),
  );
  assert.ok(p.some((x) => x.includes("visualization sentinel_bonds/table is not placed on any production dashboard")), p.join("\n"));
});

test("rejects duplicate slugs", async () => {
  const p = await problems((root) => replaceIn(root, "dashboards/staking.yaml", "slug: safenet-staking-withdrawals", "slug: safenet-validators")());
  assert.ok(p.some((x) => x.includes("slug safenet-validators is used twice")), p.join("\n"));
});

test("rejects chart columns that the SQL does not produce", async () => {
  const p = await problems((root) =>
    replaceIn(root, "queries/transaction_checks_daily/query.yaml", "completed_checks: y", "completed_chekcs: y")(),
  );
  assert.ok(p.some((x) => x.includes('column "completed_chekcs"')), p.join("\n"));
});

test("rejects undeclared parameters and scheduled refreshes of parameterized queries", async () => {
  const p = await problems((root) =>
    replaceIn(root, "queries/transaction_checks_daily/query.sql", "order by day desc", "order by day desc limit {{limit}}")(),
  );
  assert.ok(p.some((x) => x.includes("undeclared parameter {{limit}}")), p.join("\n"));
});

test("rejects the protected Beta slug", async () => {
  const p = await problems((root) => replaceIn(root, "dashboards/overview.yaml", "slug: safenet", "slug: safenet-beta")());
  assert.ok(p.some((x) => x.includes("protected dashboard")), p.join("\n"));
});

test("rejects an unknown refresh schedule", async () => {
  const p = await problems((root) =>
    replaceIn(root, "queries/transaction_checks_daily/query.yaml", "refresh: daily", "refresh: hourly")(),
  );
  assert.ok(p.some((x) => x.includes("refresh must be one of")), p.join("\n"));
});

test("orders queries so referenced queries come first", async () => {
  const config = await loadConfig();
  const keys = config.queries.map((q) => q.key);
  for (const q of config.queries)
    for (const dep of q.dependencies) assert.ok(keys.indexOf(dep) < keys.indexOf(q.key), `${dep} before ${q.key}`);
  assert.deepEqual(config.queries.find((q) => q.key === "transaction_checks_daily")!.dependencies, ["safenet_events"]);
});

test("query references are not parameters", async () => {
  const p = await problems(async () => {});
  assert.deepEqual(p, []);
});

test("rejects references to unknown queries", async () => {
  const p = await problems((root) =>
    replaceIn(root, "queries/transaction_checks_daily/query.sql", "{{query:safenet_events}}", "{{query:nope}}")(),
  );
  assert.ok(p.some((x) => x.includes("{{query:nope}} refers to an unknown query")), p.join("\n"));
});

test("rejects circular references", async () => {
  const p = await problems((root) =>
    replaceIn(root, "queries/safenet_events/query.sql", "from decoded", "from decoded, {{query:transaction_checks_daily}}")(),
  );
  assert.ok(p.some((x) => x.includes("circular")), p.join("\n"));
});
