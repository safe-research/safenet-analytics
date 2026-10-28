import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { loadConfig, productionDashboards, type Config, type Widget } from "../src/config.ts";
import { runDeploy } from "../src/deploy.ts";
import { refresh, selectQueries } from "../src/refresh.ts";
import { emptyState, migrateState, type State } from "../src/state.ts";
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
    ...productionDashboards(cfg).map((d) => [`dashboard:${d.slug}`, action]),
  ]);

const overview = (cfg: Config) => cfg.dashboards.find((d) => d.key === "overview")!;
const textCount = (cfg: Config) => overview(cfg).widgets.filter((w) => w.kind === "text").length;
const SECTIONS = ["network-revenue", "sentinels", "staking", "validators"];
const sectionSlug = (key: string) => (key === "staking" ? "safenet-staking-withdrawals" : `safenet-${key}`);

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

  test("first deploy creates the queries, visualizations and dashboards", async () => {
    const r = await deploy(fake, config, emptyState());
    assert.deepEqual(actions(r), all(config, "create"));
    const dash = fake.dashboards.get(r.state.dashboards.overview.id)!;
    assert.equal(dash.slug, "safenet");
    assert.equal(r.state.dashboards.overview.url, "https://dune.com/safe/safenet");
    for (const key of SECTIONS) assert.equal(r.state.dashboards[key].url, `https://dune.com/safe/${sectionSlug(key)}`);
    const shown = [...fake.dashboards.values()]
      .filter((d) => d.slug !== "safenet-beta")
      .flatMap((d) => d.visualization_widgets.map((w) => w.visualization_id));
    assert.deepEqual([...new Set(shown)].sort(), Object.values(r.state.visualizations).map((v) => v.id).sort());
    assert.equal(dash.text_widgets.length, textCount(config));
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
    assert.deepEqual(second.state.dashboards, first.state.dashboards);
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
    overview(changed).widgets[0] = { ...overview(changed).widgets[0], text: "# New intro" } as Widget;
    const chartWidget = overview(changed).widgets.find((w) => w.kind === "visualization" && w.ref === DAILY_CHART)!;
    chartWidget.position = { ...chartWidget.position, size_x: 3 };
    const r = await deploy(fake, changed, first.state);
    assert.equal(actions(r)[`visualization:${DAILY_CHART}`], "update");
    assert.equal(actions(r)["dashboard:safenet"], "update");
    const vizId = first.state.visualizations[DAILY_CHART].id;
    const viz = fake.visualizations.get(vizId)!;
    assert.equal(viz.options.globalSeriesType, "line");
    assert.equal(actions(r)["dashboard:safenet-staking-withdrawals"], "noop");
    const dash = fake.dashboards.get(first.state.dashboards.overview.id)!;
    assert.ok(dash.text_widgets.some((w) => w.text === "# New intro"));
    assert.equal(dash.visualization_widgets.find((w) => w.visualization_id === vizId)!.position.size_x, 3);
    assert.equal(fake.dashboards.size, 6); // Beta + the overview and four sections
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
    const dashId = first.state.dashboards.overview.id;
    fake.dashboards.get(dashId)!.text_widgets = [];
    const r = await deploy(fake, config, first.state, { force: true });
    assert.equal(actions(r)["dashboard:safenet"], "update");
    assert.equal(fake.dashboards.get(dashId)!.text_widgets.length, textCount(config));
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
    overview(changed).slug = "safenet-beta";
    const state = (await deploy(fake, config, emptyState())).state;
    state.dashboards = {};
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
    for (const d of without.dashboards) d.widgets = d.widgets.filter((w) => !(w.kind === "visualization" && w.ref === DAILY_CHART));
    const r = await deploy(fake, without, first.state);
    assert.equal(actions(r)["query:extra"], "archive");
    assert.equal(actions(r)[`visualization:${DAILY_CHART}`], "delete");
    assert.equal(fake.queries.get(extraId)!.is_archived, true);
    assert.equal(fake.visualizations.has(vizId), false);
    for (const d of Object.values(r.state.dashboards))
      assert.ok(!fake.dashboards.get(d.id)!.visualization_widgets.some((w) => w.visualization_id === vizId));
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

describe("several dashboards", () => {
  let fake: FakeDune;
  let staking: number;
  beforeEach(() => {
    fake = new FakeDune();
    fake.seedDashboard({ name: "Safenet Beta", slug: "safenet-beta", vizIds: [] });
    // Separately maintained, not managed here (docs/metrics/staking.md); it must stay untouched.
    staking = fake.seedDashboard({ name: "Safenet Staking", slug: "safenet-staking", vizIds: [] }).dashboard_id;
  });

  test("leaves the separately maintained safe/safenet-staking alone", async () => {
    const before = JSON.stringify(fake.dashboards.get(staking));
    const r = await deploy(fake, config, emptyState());
    assert.equal(r.plan.conflicts.length, 0);
    assert.ok(!Object.values(r.state.dashboards).some((t) => t.id === staking));
    assert.ok(!fake.writes().some((w) => w.includes(`/dashboards/${staking}`)));
    assert.equal(JSON.stringify(fake.dashboards.get(staking)), before);
  });

  test("links render to each dashboard's production URL and resolve to it", async () => {
    const r = await deploy(fake, config, emptyState());
    const text = fake.dashboards.get(r.state.dashboards.overview.id)!.text_widgets.map((w) => w.text).join("\n");
    assert.match(text, /\*\*\[View staking & withdrawals →\]\(https:\/\/dune\.com\/safe\/safenet-staking-withdrawals\)\*\*/);
    assert.doesNotMatch(text, /\{\{dashboard:/);
    const staking = fake.dashboards.get(r.state.dashboards.staking.id)!.text_widgets.map((w) => w.text).join("\n");
    assert.match(staking, /\[← Safenet overview\]\(https:\/\/dune\.com\/safe\/safenet\)/);
    // The overview links to 4 sections; each section to the overview and the 3 others.
    assert.equal(r.links.length, 4 + 4 * 4);
    assert.ok(r.links.every((l) => l.ok), JSON.stringify(r.links.filter((l) => !l.ok)));
  });

  test("a dashboard exists at its URL before any link to it is written", async () => {
    const client = fake.client();
    const create = client.createDashboard.bind(client);
    const update = client.updateDashboard.bind(client);
    // Dune derives another slug from the name and keeps it, e.g. because the slug is taken.
    client.createDashboard = async (body) => {
      const created = await create(body);
      if (body.name === "Safenet — Staking") fake.dashboards.get(created.dashboard_id)!.slug = "safenet-staking-1";
      return created;
    };
    client.updateDashboard = async (id, body) => update(id, body.slug === "safenet-staking-withdrawals" ? { ...body, slug: undefined } : body);
    await assert.rejects(
      runDeploy(config, emptyState(), client, { log: quiet }),
      /https:\/\/dune\.com\/safe\/safenet-staking-withdrawals does not exist, not dashboard \d+; no links to it were written/,
    );
    for (const d of fake.dashboards.values()) if (d.slug !== "safenet-beta") assert.deepEqual(d.text_widgets, [], d.slug);
  });

  test("an untracked dashboard at a section's slug is a conflict, not taken over", async () => {
    const other = fake.seedDashboard({ name: "Someone's staking", slug: "safenet-staking-withdrawals", vizIds: [] });
    const r = await deploy(fake, config, emptyState());
    assert.equal(actions(r)["dashboard:safenet-staking-withdrawals"], "conflict");
    assert.deepEqual(fake.writes(), []);
    assert.equal(fake.dashboards.get(other.dashboard_id)!.name, "Someone's staking");
  });

  test("the single dashboard of an old state file is the overview and keeps its ID", async () => {
    const first = await deploy(fake, config, emptyState());
    const { overview: old, ...sections } = first.state.dashboards;
    for (const t of Object.values(sections)) fake.dashboards.delete(t.id);
    const { dashboards: _, ...rest } = first.state;
    const legacy = migrateState({ ...rest, dashboard: old });
    assert.deepEqual(Object.keys(legacy.dashboards), ["overview"]);
    const r = await deploy(fake, config, legacy);
    assert.equal(actions(r)["dashboard:safenet"], "noop"); // same content, so not rewritten
    for (const s of SECTIONS) assert.equal(actions(r)[`dashboard:${sectionSlug(s)}`], "create");
    assert.equal(r.state.dashboards.overview.id, old.id);
  });

  test("preview-only dashboards are never deployed to production", async () => {
    const withDiagnostic = structuredClone(config);
    withDiagnostic.dashboards.push({ ...structuredClone(overview(config)), key: "diagnostic", slug: "safenet-diagnostic", previewOnly: true });
    const r = await deploy(fake, withDiagnostic, emptyState());
    assert.ok(![...fake.dashboards.values()].some((d) => d.slug === "safenet-diagnostic"));
    assert.equal(r.state.dashboards.diagnostic, undefined);
  });

  test("a new visualization updates only the dashboards that show it", async () => {
    const first = await deploy(fake, config, emptyState());
    const changed = structuredClone(config);
    const q = changed.queries.find((x) => x.key === "sentinel_disputes")!;
    q.visualizations.push({ ...structuredClone(q.visualizations[0]), key: "sentinel_disputes/extra", name: "Extra" });
    changed.dashboards.find((d) => d.key === "sentinels")!.widgets.push({
      kind: "visualization",
      ref: "sentinel_disputes/extra",
      position: { row: 500, col: 0, size_x: 6, size_y: 4 },
    });
    const r = await deploy(fake, changed, first.state);
    assert.equal(actions(r)["visualization:sentinel_disputes/extra"], "create");
    assert.equal(actions(r)["dashboard:safenet-sentinels"], "update");
    for (const slug of ["safenet", "safenet-network-revenue", "safenet-staking-withdrawals", "safenet-validators"])
      assert.equal(actions(r)[`dashboard:${slug}`], "noop", slug);
    const shown = fake.dashboards.get(r.state.dashboards.sentinels.id)!.visualization_widgets.map((w) => w.visualization_id);
    assert.ok(shown.includes(r.state.visualizations["sentinel_disputes/extra"].id));
  });

  test("a visualization on several dashboards is one Dune visualization, its query refreshed once", async () => {
    const r = await deploy(fake, config, emptyState());
    const vizId = r.state.visualizations[DAILY_CHART].id;
    const showing = Object.entries(r.state.dashboards)
      .filter(([, t]) => fake.dashboards.get(t.id)!.visualization_widgets.some((w) => w.visualization_id === vizId))
      .map(([k]) => k);
    assert.deepEqual(showing.sort(), ["network-revenue", "overview"]);
    await refresh(selectQueries(config, { schedule: "daily" }), r.state, fake.client(), { pollMs: 0, log: quiet });
    const executes = fake.requests.filter((x) => x.endsWith("/execute"));
    assert.equal(executes.length, new Set(executes).size, "every query executes once");
  });
});

describe("deploy failure paths", () => {
  test("keeps the dashboard ID when configuring a new dashboard fails", async () => {
    const fake = new FakeDune();
    fake.seedDashboard({ name: "Safenet Beta", slug: "safenet-beta", vizIds: [] });
    const renamed = structuredClone(config);
    overview(renamed).name = "Safenet Analytics"; // Dune would derive a different slug from this name
    let saved: State | undefined;
    const client = fake.client();
    client.updateDashboard = async () => {
      throw new Error("rejected layout");
    };
    await assert.rejects(
      runDeploy(renamed, emptyState(), client, { log: quiet, save: async (s) => void (saved = s) }),
      /rejected layout/,
    );
    assert.ok(saved?.dashboards.overview?.id);
    const r = await deploy(fake, renamed, saved!);
    assert.equal(actions(r)["dashboard:safenet"], "update");
    assert.equal(fake.dashboards.size, 6); // Beta + one overview and four sections, no duplicates
    assert.equal(fake.dashboards.get(saved!.dashboards.overview.id)!.slug, "safenet");
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
