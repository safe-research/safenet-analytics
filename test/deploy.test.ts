import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { loadConfig, type Config } from "../src/config.ts";
import { runDeploy } from "../src/deploy.ts";
import { refresh, selectQueries } from "../src/refresh.ts";
import { emptyState, type State } from "../src/state.ts";
import { FakeDune } from "./fake-dune.ts";

const quiet = () => {};
const config = await loadConfig();

async function deploy(fake: FakeDune, cfg: Config, state: State, options: { dryRun?: boolean; force?: boolean } = {}) {
  return runDeploy(cfg, state, fake.client(), { ...options, log: quiet });
}

const actions = (r: Awaited<ReturnType<typeof deploy>>) =>
  Object.fromEntries(r.plan.steps.map((s) => [`${s.resource}:${s.key}`, s.action]));

// Every resource of the repository configuration, with the same action.
const all = (cfg: Config, action: string) =>
  Object.fromEntries([
    ...cfg.queries.map((q) => [`query:${q.key}`, action]),
    ...cfg.queries.flatMap((q) => q.visualizations.map((v) => [`visualization:${v.key}`, action])),
    [`dashboard:${cfg.dashboard.slug}`, action],
  ]);

const daily = (cfg: Config) => cfg.queries.find((q) => q.key === "transaction_checks_daily")!;
const DAILY_CHART = "transaction_checks_daily/daily_chart";

describe("deploy", () => {
  let fake: FakeDune;
  let beta: { queryId: number; vizId: number; dashboardId: number };

  beforeEach(() => {
    fake = new FakeDune();
    const q = fake.seedQuery({ name: "Safenet Beta: staking", tags: [] });
    const v = fake.seedVisualization({ query_id: q.query_id, name: "Beta chart", description: "", type: "chart", options: {} });
    const d = fake.seedDashboard({ name: "Safenet Beta", slug: "safenet-beta", vizIds: [v.id] });
    beta = { queryId: q.query_id, vizId: v.id, dashboardId: d.dashboard_id };
  });

  test("first deploy creates the query, visualization and dashboard", async () => {
    const r = await deploy(fake, config, emptyState());
    assert.deepEqual(actions(r), all(config, "create"));
    const dash = fake.dashboards.get(r.state.dashboard!.id)!;
    assert.equal(dash.slug, "safenet");
    assert.equal(r.state.dashboard!.url, "https://dune.com/safe/safenet");
    assert.deepEqual(
      dash.visualization_widgets.map((w) => w.visualization_id).sort(),
      Object.values(r.state.visualizations).map((v) => v.id).sort(),
    );
    assert.equal(dash.text_widgets.length, 3);
    const q = fake.queries.get(r.state.queries.transaction_checks_daily.id)!;
    assert.ok(q.tags.includes("safenet-analytics"));
    assert.equal(r.state.protected["safe/safenet-beta"].dashboard_id, beta.dashboardId);
    assert.deepEqual(r.state.protected["safe/safenet-beta"].query_ids, [beta.queryId]);
  });

  test("redeploying unchanged configuration writes nothing and creates no duplicates", async () => {
    const first = await deploy(fake, config, emptyState());
    const counts = [fake.queries.size, fake.visualizations.size, fake.dashboards.size];
    const writesBefore = fake.writes().length;
    const second = await deploy(fake, config, first.state);
    assert.ok(second.plan.steps.every((s) => s.action === "noop"), JSON.stringify(second.plan.steps));
    assert.equal(fake.writes().length, writesBefore);
    assert.deepEqual([fake.queries.size, fake.visualizations.size, fake.dashboards.size], counts);
    assert.deepEqual(second.state.queries, first.state.queries);
    assert.deepEqual(second.state.dashboard, first.state.dashboard);
  });

  test("a lost state file adopts existing resources instead of duplicating them", async () => {
    await deploy(fake, config, emptyState());
    const counts = [fake.queries.size, fake.visualizations.size, fake.dashboards.size];
    const r = await deploy(fake, config, emptyState());
    assert.deepEqual(actions(r), all(config, "adopt"));
    assert.deepEqual([fake.queries.size, fake.visualizations.size, fake.dashboards.size], counts);
    assert.ok(fake.writes().every((w) => !w.startsWith("POST /api/v1/query ")));
  });

  test("changed SQL updates only the query, in place", async () => {
    const first = await deploy(fake, config, emptyState());
    const changed = structuredClone(config);
    daily(changed).sql = `${daily(changed).sql}-- changed\n`;
    const r = await deploy(fake, changed, first.state);
    assert.deepEqual(actions(r), { ...all(config, "noop"), "query:transaction_checks_daily": "update" });
    const id = first.state.queries.transaction_checks_daily.id;
    assert.equal(r.state.queries.transaction_checks_daily.id, id);
    assert.match(fake.queries.get(id)!.query_sql, /-- changed/);
  });

  test("changed chart, text and layout update in place", async () => {
    const first = await deploy(fake, config, emptyState());
    const changed = structuredClone(config);
    daily(changed).visualizations.find((v) => v.key === DAILY_CHART)!.options.globalSeriesType = "line";
    changed.dashboard.widgets[0] = { ...changed.dashboard.widgets[0], text: "# New intro" } as Config["dashboard"]["widgets"][0];
    const chartWidget = changed.dashboard.widgets.find((w) => w.kind === "visualization" && w.ref === DAILY_CHART)!;
    chartWidget.position = { ...chartWidget.position, size_x: 3 };
    const r = await deploy(fake, changed, first.state);
    assert.equal(actions(r)[`visualization:${DAILY_CHART}`], "update");
    assert.equal(actions(r)["dashboard:safenet"], "update");
    const vizId = first.state.visualizations[DAILY_CHART].id;
    const viz = fake.visualizations.get(vizId)!;
    assert.equal(viz.options.globalSeriesType, "line");
    const dash = fake.dashboards.get(first.state.dashboard!.id)!;
    assert.ok(dash.text_widgets.some((w) => w.text === "# New intro"));
    assert.equal(dash.visualization_widgets.find((w) => w.visualization_id === vizId)!.position.size_x, 3);
    assert.equal(fake.dashboards.size, 2); // Beta + Safenet
  });

  test("edits made directly in Dune are reported as conflicts and not overwritten", async () => {
    const first = await deploy(fake, config, emptyState());
    const id = first.state.queries.transaction_checks_daily.id;
    fake.queries.get(id)!.query_sql = "select 42 -- edited in Dune";
    const changed = structuredClone(config);
    daily(changed).description = "new description";
    const writesBefore = fake.writes().length;
    const r = await deploy(fake, changed, first.state);
    assert.deepEqual(
      r.plan.conflicts.map((c) => c.key),
      ["transaction_checks_daily", DAILY_CHART, "transaction_checks_daily/total_requests"],
    );
    assert.equal(fake.writes().length, writesBefore);
    assert.equal(fake.queries.get(id)!.query_sql, "select 42 -- edited in Dune");
  });

  test("--force overwrites edits made in Dune", async () => {
    const first = await deploy(fake, config, emptyState());
    const dashId = first.state.dashboard!.id;
    fake.dashboards.get(dashId)!.text_widgets = [];
    const r = await deploy(fake, config, first.state, { force: true });
    assert.equal(actions(r)["dashboard:safenet"], "update");
    assert.equal(fake.dashboards.get(dashId)!.text_widgets.length, 3);
    const again = await deploy(fake, config, r.state);
    assert.ok(again.plan.steps.every((s) => s.action === "noop"));
  });

  test("dry run reads Dune but writes nothing", async () => {
    const first = await deploy(fake, config, emptyState());
    const changed = structuredClone(config);
    daily(changed).sql = "select 1\n";
    const writesBefore = fake.writes().length;
    const r = await deploy(fake, changed, first.state, { dryRun: true });
    assert.equal(actions(r)["query:transaction_checks_daily"], "update");
    assert.equal(fake.writes().length, writesBefore);
    assert.deepEqual(r.state, first.state);
  });

  test("dry run of the first deploy plans creates without writing", async () => {
    const r = await deploy(fake, config, emptyState(), { dryRun: true });
    assert.deepEqual(actions(r), all(config, "create"));
    assert.deepEqual(fake.writes(), []);
  });

  test("refuses keys that do not belong to the team", async () => {
    fake.whoami = { customer_id: "user_7", handle: "someone", api_key_id: 1, created_by: 7 };
    await assert.rejects(deploy(fake, config, emptyState()), /must be a key of the Dune team "safe"/);
    assert.deepEqual(fake.writes(), []);
  });

  test("never manages resources of the protected Beta dashboard", async () => {
    const state = emptyState();
    state.queries.transaction_checks_daily = { id: beta.queryId, desired: "x", remote: "y" };
    await assert.rejects(deploy(fake, config, state, { force: true }), /belongs to the protected dashboard safe\/safenet-beta/);
    assert.deepEqual(fake.writes(), []);
    assert.equal(fake.queries.get(beta.queryId)!.query_sql, "select 1");
  });

  test("refuses a slug that belongs to a protected dashboard", async () => {
    const changed = structuredClone(config);
    changed.dashboard.slug = "safenet-beta";
    const state = (await deploy(fake, config, emptyState())).state;
    state.dashboard = null;
    await assert.rejects(deploy(fake, changed, state, { force: true }), /protected dashboard/);
  });

  test("removed visualizations are deleted and removed queries archived", async () => {
    const extra = structuredClone(config);
    extra.queries.push({
      ...structuredClone(daily(config)),
      key: "extra",
      name: "Extra",
      visualizations: [],
    });
    const first = await deploy(fake, extra, emptyState());
    const extraId = first.state.queries.extra.id;
    const vizId = first.state.visualizations[DAILY_CHART].id;

    const without = structuredClone(config);
    daily(without).visualizations = daily(without).visualizations.filter((v) => v.key !== DAILY_CHART);
    without.dashboard.widgets = without.dashboard.widgets.filter((w) => !(w.kind === "visualization" && w.ref === DAILY_CHART));
    const r = await deploy(fake, without, first.state);
    assert.equal(actions(r)["query:extra"], "archive");
    assert.equal(actions(r)[`visualization:${DAILY_CHART}`], "delete");
    assert.equal(fake.queries.get(extraId)!.is_archived, true);
    assert.equal(fake.visualizations.has(vizId), false);
    assert.ok(!fake.dashboards.get(r.state.dashboard!.id)!.visualization_widgets.some((w) => w.visualization_id === vizId));
    assert.equal(r.state.queries.extra, undefined);
    const del = fake.requests.findIndex((x) => x === `DELETE /api/v1/visualizations/${vizId}`);
    const patch = fake.requests.findLastIndex((x) => x.startsWith("PATCH /api/v1/dashboards/"));
    assert.ok(patch < del, "the dashboard drops the widget before the visualization is deleted");
  });

  test("state is saved even when a deploy fails partway", async () => {
    let saved: State | undefined;
    const client = fake.client();
    const original = client.createDashboard.bind(client);
    client.createDashboard = async () => {
      throw new Error("boom");
    };
    await assert.rejects(
      runDeploy(config, emptyState(), client, { log: quiet, save: async (s) => void (saved = s) }),
      /boom/,
    );
    assert.ok(saved?.queries.transaction_checks_daily.id);
    client.createDashboard = original;
    const r = await deploy(fake, config, saved!);
    assert.equal(actions(r)["query:transaction_checks_daily"], "noop");
    assert.equal(actions(r)["dashboard:safenet"], "create");
    assert.equal([...fake.queries.values()].filter((q) => q.name === daily(config).name).length, 1);
  });
});

describe("deploy failure paths", () => {
  test("keeps the dashboard ID when configuring a new dashboard fails", async () => {
    const fake = new FakeDune();
    fake.seedDashboard({ name: "Safenet Beta", slug: "safenet-beta", vizIds: [] });
    const renamed = structuredClone(config);
    renamed.dashboard.name = "Safenet Analytics"; // Dune would derive a different slug from this name
    let saved: State | undefined;
    const client = fake.client();
    client.updateDashboard = async () => {
      throw new Error("rejected layout");
    };
    await assert.rejects(
      runDeploy(renamed, emptyState(), client, { log: quiet, save: async (s) => void (saved = s) }),
      /rejected layout/,
    );
    assert.ok(saved?.dashboard?.id);
    const r = await deploy(fake, renamed, saved!);
    assert.equal(actions(r)["dashboard:safenet"], "update");
    assert.equal(fake.dashboards.size, 2); // Beta + one Safenet dashboard
    assert.equal(fake.dashboards.get(saved!.dashboard!.id)!.slug, "safenet");
  });

  test("a removed query that is already gone in Dune is dropped from state", async () => {
    const fake = new FakeDune();
    fake.seedDashboard({ name: "Safenet Beta", slug: "safenet-beta", vizIds: [] });
    const extra = structuredClone(config);
    extra.queries.push({ ...structuredClone(daily(config)), key: "extra", name: "Extra", visualizations: [] });
    const first = await deploy(fake, extra, emptyState());
    fake.queries.delete(first.state.queries.extra.id);
    const r = await deploy(fake, config, first.state);
    assert.equal(actions(r)["query:extra"], "archive");
    assert.equal(r.state.queries.extra, undefined);
  });

  test("refuses to deploy when a protected dashboard cannot be read", async () => {
    const fake = new FakeDune();
    await assert.rejects(deploy(fake, config, emptyState()), /protected dashboard safe\/safenet-beta could not be read/);
    assert.deepEqual(fake.writes(), []);
  });
});

describe("refresh", () => {
  const withBeta = () => {
    const fake = new FakeDune();
    fake.seedDashboard({ name: "Safenet Beta", slug: "safenet-beta", vizIds: [] });
    return fake;
  };

  test("executes daily queries by their deployed IDs and waits for completion", async () => {
    const fake = withBeta();
    const { state } = await deploy(fake, config, emptyState());
    const results = await refresh(selectQueries(config, { schedule: "daily" }), state, fake.client(), {
      pollMs: 0,
      log: quiet,
    });
    const daily = selectQueries(config, { schedule: "daily" }).map((q) => q.key);
    assert.ok(daily.includes("transaction_checks_daily") && !daily.includes("safenet_events"));
    assert.deepEqual(
      results.map((r) => [r.key, r.status.state]),
      daily.map((k) => [k, "QUERY_STATE_COMPLETED"]),
    );
    assert.ok(fake.requests.includes(`POST /api/v1/query/${state.queries.transaction_checks_daily.id}/execute`));
  });

  test("deploys never execute queries", async () => {
    const fake = withBeta();
    await deploy(fake, config, emptyState());
    assert.ok(fake.requests.every((r) => !r.includes("/execute")));
  });

  test("refuses to refresh undeployed queries", async () => {
    await assert.rejects(refresh(config.queries, emptyState(), new FakeDune().client(), { log: quiet }), /deploy it first/);
  });
});
