import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { loadConfig, type Config } from "../src/config.ts";
import { runDeploy, sqlQueryIds } from "../src/deploy.ts";
import { isPreviewSlug, loadPreviewSettings, previewSlug, productionGuard, toPreview, type PreviewSettings } from "../src/preview.ts";
import { runPreviewQueries } from "../src/preview-run.ts";
import { emptyState, type State } from "../src/state.ts";
import { FakeDune } from "./fake-dune.ts";

const quiet = () => {};
const config = await loadConfig();
const settings = await loadPreviewSettings();
const SHA = "0123456789abcdef0123456789abcdef01234567";

const previewOf = (track = "default", sha = SHA) =>
  toPreview(config, { ...settings, track }, { sha, pr: 7, repository: "safe-research/safenet-analytics" });

async function deployProduction(fake: FakeDune) {
  return (await runDeploy(config, emptyState(), fake.client(), { log: quiet })).state;
}

async function deployPreview(fake: FakeDune, production: State, preview: State, cfg: Config = previewOf()) {
  return runDeploy(cfg, preview, fake.client(), {
    log: quiet,
    force: true,
    guards: [productionGuard(production)],
    requirePrivate: true,
  });
}

// Everything Dune holds for the production resources, to show a preview leaves them unchanged.
function productionSnapshot(fake: FakeDune, production: State) {
  return JSON.stringify({
    queries: Object.values(production.queries).map((t) => fake.queries.get(t.id)),
    visualizations: Object.values(production.visualizations).map((t) => fake.visualizations.get(t.id)),
    dashboards: Object.values(production.dashboards).map((t) => fake.dashboards.get(t.id)),
  });
}

const overviewOf = (cfg: Config) => cfg.dashboards.find((d) => d.key === "overview")!;

describe("preview configuration", () => {
  test("uses preview names, tags, privacy and slug, and no schedules", () => {
    const p = previewOf();
    assert.equal(overviewOf(p).name, "Safenet — Preview");
    assert.equal(overviewOf(p).slug, "safenet-preview");
    for (const d of p.dashboards) {
      assert.equal(d.isPrivate, true, d.key);
      assert.equal(d.previewOnly, false, d.key); // all deployed in the preview
      assert.ok(isPreviewSlug(d.slug), d.slug);
    }
    assert.equal(p.dashboards.find((d) => d.key === "staking")!.slug, "safenet-staking-preview");
    assert.equal(p.dashboards.find((d) => d.key === "staking")!.name, "Safenet — Preview: Staking");
    assert.equal(p.project.managedTag, "safenet-preview-default");
    for (const q of p.queries) {
      assert.match(q.name, /^\[Preview\] Safenet: /);
      assert.equal(q.isPrivate, false); // preview.yaml: private_queries: false
      assert.equal(q.refresh, "none");
      assert.deepEqual(q.tags, ["safenet-preview"]);
    }
    const privateQueries = toPreview(config, { ...settings, privateQueries: true }, { sha: SHA });
    assert.ok(privateQueries.queries.every((q) => q.isPrivate));
    assert.equal(overviewOf(previewOf("staking")).slug, "safenet-preview-staking");
    assert.equal(previewOf("staking").dashboards.find((d) => d.key === "staking")!.slug, "safenet-staking-preview-staking");
    // No preview slug of one track equals one of another track, or a production slug.
    const slugs = ["default", "staking", "navigation"].flatMap((t) => previewOf(t).dashboards.map((d) => d.slug));
    assert.equal(new Set(slugs).size, slugs.length);
    for (const d of config.dashboards) assert.ok(!isPreviewSlug(d.slug), d.slug);
    assert.match(previewOf("staking").queries[0].name, /^\[Preview staking\] /);
  });

  test("puts a banner with PR and commit above the production layout of every dashboard", () => {
    const p = previewOf();
    for (const d of config.dashboards) {
      const pd = p.dashboards.find((x) => x.key === d.key)!;
      const banner = pd.widgets[0];
      assert.equal(banner.kind, "text");
      assert.match(banner.kind === "text" ? banner.text : "", /PR #7.*0123456/);
      assert.equal(pd.widgets.length, d.widgets.length + 1);
      for (const [i, w] of d.widgets.entries()) assert.equal(pd.widgets[i + 1].position.row, w.position.row + 2);
    }
  });

  test("production configuration is unchanged by building a preview", () => {
    const before = JSON.stringify(config);
    previewOf();
    assert.equal(JSON.stringify(config), before);
  });

  test("preview dashboards must be private", async () => {
    await assert.rejects(
      (async () => {
        const { mkdtemp, cp, writeFile } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { DEFAULT_ROOT } = await import("../src/config.ts");
        const root = await mkdtemp(join(tmpdir(), "preview-"));
        await cp(DEFAULT_ROOT, root, { recursive: true });
        await writeFile(join(root, "preview.yaml"), "track: default\nprivate: false\n");
        await loadPreviewSettings(root);
      })(),
      /preview dashboards must be private/,
    );
  });
});

describe("preview deploy", () => {
  let fake: FakeDune;
  let production: State;

  beforeEach(async () => {
    fake = new FakeDune();
    fake.seedDashboard({ name: "Safenet Beta", slug: "safenet-beta", vizIds: [] });
    production = await deployProduction(fake);
  });

  test("creates preview resources (private dashboards, public queries) and leaves production unchanged", async () => {
    const before = productionSnapshot(fake, production);
    const r = await deployPreview(fake, production, emptyState());
    assert.equal(productionSnapshot(fake, production), before);

    const prodIds = productionGuard(production).ids;
    for (const [key, t] of Object.entries(r.state.queries)) {
      assert.ok(!prodIds.queries.has(t.id), key);
      const q = fake.queries.get(t.id)!;
      assert.equal(q.is_private, false, key);
      assert.match(q.name, /^\[Preview\] /);
      assert.ok(q.tags.includes("safenet-preview-default"));
      assert.ok(!q.tags.includes("safenet-analytics"));
      // References resolve to preview queries only.
      for (const id of sqlQueryIds(q.query_sql)) {
        assert.ok(!prodIds.queries.has(id), `${key} reads production query_${id}`);
        assert.ok(Object.values(r.state.queries).some((p) => p.id === id), `${key} reads non-preview query_${id}`);
      }
    }
    for (const t of Object.values(r.state.visualizations)) assert.ok(!prodIds.visualizations.has(t.id));
    const dash = fake.dashboards.get(r.state.dashboards.overview.id)!;
    assert.equal(dash.slug, previewSlug("default"));
    const prodDashboards = new Set(Object.values(production.dashboards).map((t) => t.id));
    assert.deepEqual(Object.keys(r.state.dashboards).sort(), previewOf().dashboards.map((d) => d.key).sort());
    for (const t of Object.values(r.state.dashboards)) {
      assert.equal(fake.dashboards.get(t.id)!.is_private, true);
      assert.ok(!prodDashboards.has(t.id));
    }
  });

  test("links between preview dashboards stay in the preview", async () => {
    const r = await deployPreview(fake, production, emptyState());
    const text = Object.values(r.state.dashboards).flatMap((t) => fake.dashboards.get(t.id)!.text_widgets.map((w) => w.text)).join("\n");
    assert.match(text, /\[View staking & withdrawals →\]\(https:\/\/dune\.com\/safe\/safenet-staking-preview\)/);
    assert.match(text, /\[← Safenet overview\]\(https:\/\/dune\.com\/safe\/safenet-preview\)/);
    // Production dashboards are linked only from the banner.
    const linked = [...text.matchAll(/https:\/\/dune\.com\/safe\/(safenet[a-z-]*)\)/g)].map((m) => m[1]).filter((s) => !isPreviewSlug(s));
    assert.deepEqual([...new Set(linked)].sort(), ["safenet", "safenet-beta"]);
    assert.ok(r.links.length > 0 && r.links.every((l) => l.ok && isPreviewSlug(l.url.split("/").pop()!)));
  });

  test("deploys the preview-only crash dashboards", async () => {
    const r = await deployPreview(fake, production, emptyState());
    assert.equal(fake.dashboards.get(r.state.dashboards["crash-repro"].id)!.slug, "safenet-crash-repro-preview");
  });

  test("production queries read production queries", () => {
    const daily = fake.queries.get(production.queries.transaction_checks_daily.id)!;
    assert.deepEqual(sqlQueryIds(daily.query_sql), [production.queries.safenet_events.id]);
    assert.ok(!daily.query_sql.includes("{{query:"));
  });

  test("repeat deploys reuse the preview resources", async () => {
    const first = await deployPreview(fake, production, emptyState());
    const counts = [fake.queries.size, fake.visualizations.size, fake.dashboards.size];
    const second = await deployPreview(fake, production, first.state, previewOf("default", "f".repeat(40)));
    assert.equal(second.plan.steps.filter((s) => s.action === "create").length, 0);
    assert.deepEqual([fake.queries.size, fake.visualizations.size, fake.dashboards.size], counts);
    assert.deepEqual(second.state.queries, first.state.queries);
    // Only the banners (new commit) changed.
    assert.deepEqual(
      second.plan.steps.filter((s) => s.action !== "noop").map((s) => `${s.resource}:${s.action}`),
      previewOf().dashboards.map(() => "dashboard:update"),
    );
    // A lost preview state is recovered by lookup, without duplicates.
    const lost = await deployPreview(fake, production, emptyState());
    assert.equal(lost.plan.steps.filter((s) => s.action === "create").length, 0);
    assert.deepEqual([fake.queries.size, fake.visualizations.size, fake.dashboards.size], counts);
  });

  test("tracks get separate resources", async () => {
    const a = await deployPreview(fake, production, emptyState(), previewOf("default"));
    const b = await deployPreview(fake, production, emptyState(), previewOf("staking"));
    const ids = (s: State) => new Set([...Object.values(s.queries), ...Object.values(s.visualizations)].map((t) => t.id));
    assert.equal([...ids(a.state)].filter((id) => ids(b.state).has(id)).length, 0);
    assert.notEqual(a.state.dashboards.overview.id, b.state.dashboards.overview.id);
    assert.equal(fake.dashboards.get(b.state.dashboards.overview.id)!.slug, "safenet-preview-staking");
    assert.equal(fake.dashboards.get(b.state.dashboards.staking.id)!.slug, "safenet-staking-preview-staking");
  });

  test("stops if a lookup resolves to a production resource", async () => {
    // Someone gives a production query the preview name and tag.
    const prodQuery = fake.queries.get(production.queries.safenet_events.id)!;
    const previewQuery = previewOf().queries.find((q) => q.key === "safenet_events")!;
    prodQuery.name = previewQuery.name;
    prodQuery.tags = [...prodQuery.tags, "safenet-preview-default"];
    const writes = fake.writes().length;
    await assert.rejects(deployPreview(fake, production, emptyState()), /belongs to production/);
    assert.equal(fake.writes().length, writes);
  });

  test("stops if a preview query would read a production query", async () => {
    const cfg = previewOf();
    const q = cfg.queries.find((x) => x.key === "latest_requests")!;
    q.sql = `${q.sql}\n-- union all select * from query_${production.queries.safenet_events.id}\n`;
    await assert.rejects(deployPreview(fake, production, emptyState(), cfg), /reads query_\d+, which belongs to production/);
  });

  test("never falls back to a public dashboard when Dune rejects private ones", async () => {
    fake.privacy = "reject";
    const before = productionSnapshot(fake, production);
    await assert.rejects(deployPreview(fake, production, emptyState()), /402.*private dashboards limit/);
    assert.ok(![...fake.dashboards.values()].some((d) => d.name.startsWith("Safenet — Preview")));
    assert.equal(productionSnapshot(fake, production), before);
  });

  test("with private_queries, never falls back to public queries", async () => {
    fake.privacy = "reject";
    const cfg = toPreview(config, { ...settings, track: "default", privateQueries: true }, { sha: SHA });
    await assert.rejects(deployPreview(fake, production, emptyState(), cfg), /402.*private queries limit/);
    assert.ok(![...fake.queries.values()].some((q) => q.name.startsWith("[Preview")));
  });

  test("preview queries created private earlier are made public", async () => {
    const cfg = toPreview(config, { ...settings, track: "default", privateQueries: true }, { sha: SHA });
    const first = await deployPreview(fake, production, emptyState(), cfg);
    assert.ok(Object.values(first.state.queries).every((t) => fake.queries.get(t.id)!.is_private));
    const second = await deployPreview(fake, production, first.state);
    assert.ok(Object.values(second.state.queries).every((t) => !fake.queries.get(t.id)!.is_private));
    assert.deepEqual(Object.values(second.state.queries).map((t) => t.id), Object.values(first.state.queries).map((t) => t.id));
  });

  test("with private_queries, archives a query Dune created public and stops", async () => {
    fake.privacy = "ignore";
    const cfg = toPreview(config, { ...settings, track: "default", privateQueries: true }, { sha: SHA });
    await assert.rejects(deployPreview(fake, production, emptyState(), cfg), /is public although previews must be private/);
    const previews = [...fake.queries.values()].filter((q) => q.name.startsWith("[Preview"));
    assert.ok(previews.length > 0 && previews.every((q) => q.is_archived));
  });
});

describe("preview executions", () => {
  let fake: FakeDune;
  let preview: State;
  const cfg = previewOf();
  const run = (s: PreviewSettings = settings, options = {}) =>
    runPreviewQueries(cfg, preview, fake.client(), s, { pollMs: 0, log: quiet, ...options });

  beforeEach(async () => {
    fake = new FakeDune();
    fake.seedDashboard({ name: "Safenet Beta", slug: "safenet-beta", vizIds: [] });
    const production = await deployProduction(fake);
    preview = (await deployPreview(fake, production, emptyState())).state;
  });

  test("runs only dashboard queries, each once, and only when their SQL changed", async () => {
    const first = await run();
    const shown = new Set(
      cfg.dashboards.flatMap((d) => d.widgets.flatMap((w) => (w.kind === "visualization" ? [w.ref.split("/")[0]] : []))),
    );
    // transaction_checks_daily is on the overview and on Network & revenue, and runs once.
    assert.equal(first.filter((r) => r.key === "transaction_checks_daily").length, 1);
    const executes = fake.requests.filter((x) => x.endsWith("/execute"));
    assert.equal(executes.length, new Set(executes).size);
    assert.deepEqual(
      first.map((r) => [r.key, r.action]),
      cfg.queries.filter((q) => shown.has(q.key)).map((q) => [q.key, "executed"]),
    );
    assert.ok(!first.some((r) => r.key === "safenet_events"), "models run only as part of the queries that read them");
    const second = await run();
    assert.ok(second.every((r) => r.action === "unchanged"));
    // A change in a referenced query reruns the queries that read it.
    const changed = structuredClone(cfg);
    changed.queries.find((q) => q.key === "safenet_events")!.sql += "-- changed\n";
    const third = await runPreviewQueries(changed, preview, fake.client(), settings, { pollMs: 0, log: quiet });
    const reads = (key: string): boolean =>
      key === "safenet_events" || cfg.queries.find((q) => q.key === key)!.dependencies.some(reads);
    for (const r of third) assert.equal(r.action, reads(r.key) ? "executed" : "unchanged", r.key);
    assert.ok(third.some((r) => r.action === "unchanged"), "queries not reading safenet_events are not rerun");
  });

  test("with a production baseline, runs only the queries whose SQL differs from production", async () => {
    const baseline = structuredClone(config);
    // As if main had an older staking model: every query that reads it differs from production.
    baseline.queries.find((q) => q.key === "staking_events")!.sql += "-- older\n";
    const runs = await run(settings, { baseline });
    const reads = (key: string): boolean =>
      key === "staking_events" || cfg.queries.find((q) => q.key === key)!.dependencies.some(reads);
    for (const r of runs) assert.equal(r.action, reads(r.key) ? "executed" : "same as production", r.key);
    assert.ok(runs.some((r) => r.action === "executed") && runs.some((r) => r.action === "same as production"));
    // --force runs them all.
    const forced = await run(settings, { baseline, force: true });
    assert.ok(forced.every((r) => r.action === "executed"));
  });

  test("stops at the per-execution credit cap", async () => {
    fake.executionCredits = 30;
    await assert.rejects(run(), /cost 30 credits, above the cap of 25/);
  });

  test("stops at the per-run credit budget", async () => {
    fake.executionCredits = 20;
    const tight = { ...settings, execution: { ...settings.execution, maxCreditsPerRun: 15 } };
    await assert.rejects(run(tight), /budget of 15 per run used up/);
  });

  test("cancels executions that exceed the timeout", async () => {
    fake.executionsNeverFinish = true;
    const quick = { ...settings, execution: { ...settings.execution, timeoutMinutes: 0.0001 } };
    await assert.rejects(run(quick), /cancelled after/);
    assert.ok(fake.requests.some((r) => /^POST \/api\/v1\/execution\/[^/]+\/cancel$/.test(r)));
  });
});
