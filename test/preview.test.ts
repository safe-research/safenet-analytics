import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { loadConfig, type Config } from "../src/config.ts";
import { runDeploy, sqlQueryIds } from "../src/deploy.ts";
import { loadPreviewSettings, previewSlug, productionGuard, toPreview, type PreviewSettings } from "../src/preview.ts";
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
    dashboard: fake.dashboards.get(production.dashboard!.id),
  });
}

describe("preview configuration", () => {
  test("uses preview names, tags, privacy and slug, and no schedules", () => {
    const p = previewOf();
    assert.equal(p.dashboard.name, "Safenet — Preview");
    assert.equal(p.dashboard.slug, "safenet-preview");
    assert.equal(p.dashboard.isPrivate, true);
    assert.equal(p.project.managedTag, "safenet-preview-default");
    for (const q of p.queries) {
      assert.match(q.name, /^\[Preview\] Safenet: /);
      assert.equal(q.isPrivate, true);
      assert.equal(q.refresh, "none");
      assert.deepEqual(q.tags, ["safenet-preview"]);
    }
    assert.equal(previewOf("staking").dashboard.slug, "safenet-preview-staking");
    assert.match(previewOf("staking").queries[0].name, /^\[Preview staking\] /);
  });

  test("puts a banner with PR and commit above the production layout", () => {
    const p = previewOf();
    const banner = p.dashboard.widgets[0];
    assert.equal(banner.kind, "text");
    assert.match(banner.kind === "text" ? banner.text : "", /PR #7.*0123456/);
    assert.equal(p.dashboard.widgets.length, config.dashboard.widgets.length + 1);
    for (const [i, w] of config.dashboard.widgets.entries())
      assert.equal(p.dashboard.widgets[i + 1].position.row, w.position.row + 2);
  });

  test("production configuration is unchanged by building a preview", () => {
    const before = JSON.stringify(config);
    previewOf();
    assert.equal(JSON.stringify(config), before);
  });

  test("previews must be private", async () => {
    assert.equal(settings.track, "default");
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
      /previews must be private/,
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

  test("creates private preview resources and leaves production unchanged", async () => {
    const before = productionSnapshot(fake, production);
    const r = await deployPreview(fake, production, emptyState());
    assert.equal(productionSnapshot(fake, production), before);

    const prodIds = productionGuard(production).ids;
    for (const [key, t] of Object.entries(r.state.queries)) {
      assert.ok(!prodIds.queries.has(t.id), key);
      const q = fake.queries.get(t.id)!;
      assert.equal(q.is_private, true, key);
      assert.ok(q.tags.includes("safenet-preview-default"));
      assert.ok(!q.tags.includes("safenet-analytics"));
      // References resolve to preview queries only.
      for (const id of sqlQueryIds(q.query_sql)) {
        assert.ok(!prodIds.queries.has(id), `${key} reads production query_${id}`);
        assert.ok(Object.values(r.state.queries).some((p) => p.id === id), `${key} reads non-preview query_${id}`);
      }
    }
    for (const t of Object.values(r.state.visualizations)) assert.ok(!prodIds.visualizations.has(t.id));
    const dash = fake.dashboards.get(r.state.dashboard!.id)!;
    assert.equal(dash.slug, previewSlug("default"));
    assert.equal(dash.is_private, true);
    assert.notEqual(r.state.dashboard!.id, production.dashboard!.id);
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
    // Only the banner (new commit) changed.
    assert.deepEqual(
      second.plan.steps.filter((s) => s.action !== "noop").map((s) => `${s.resource}:${s.action}`),
      ["dashboard:update"],
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
    assert.notEqual(a.state.dashboard!.id, b.state.dashboard!.id);
    assert.equal(fake.dashboards.get(b.state.dashboard!.id)!.slug, "safenet-preview-staking");
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

  test("never falls back to public when Dune rejects private resources", async () => {
    fake.privacy = "reject";
    const before = productionSnapshot(fake, production);
    await assert.rejects(deployPreview(fake, production, emptyState()), /402.*private queries limit/);
    assert.ok(![...fake.queries.values()].some((q) => q.name.startsWith("[Preview")));
    assert.equal(productionSnapshot(fake, production), before);
  });

  test("archives a query Dune created public and stops", async () => {
    fake.privacy = "ignore";
    await assert.rejects(deployPreview(fake, production, emptyState()), /is public although previews must be private/);
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

  test("runs only dashboard queries, and only when their SQL changed", async () => {
    const first = await run();
    assert.deepEqual(
      first.map((r) => [r.key, r.action]),
      [
        ["latest_requests", "executed"],
        ["transaction_checks_daily", "executed"],
      ],
    );
    const second = await run();
    assert.ok(second.every((r) => r.action === "unchanged"));
    // A change in a referenced query reruns the queries that read it.
    const changed = structuredClone(cfg);
    changed.queries.find((q) => q.key === "safenet_events")!.sql += "-- changed\n";
    const third = await runPreviewQueries(changed, preview, fake.client(), settings, { pollMs: 0, log: quiet });
    assert.ok(third.every((r) => r.action === "executed"));
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
