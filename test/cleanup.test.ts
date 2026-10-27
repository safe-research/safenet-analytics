import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { applyCleanup, planCleanup } from "../src/cleanup.ts";
import { loadConfig } from "../src/config.ts";
import { runDeploy } from "../src/deploy.ts";
import { loadPreviewSettings, productionGuard, toPreview } from "../src/preview.ts";
import { emptyState, type State } from "../src/state.ts";
import { FakeDune } from "./fake-dune.ts";

const quiet = () => {};
const config = await loadConfig();
const settings = await loadPreviewSettings();
const options = { team: "safe", protectedDashboards: config.project.protectedDashboards };

describe("preview cleanup", () => {
  let fake: FakeDune;
  let production: State;
  let preview: State;
  let beta: { queryId: number; vizId: number; dashboardId: number };

  const snapshot = () =>
    JSON.stringify({
      production: [
        ...Object.values(production.queries).map((t) => fake.queries.get(t.id)),
        ...Object.values(production.visualizations).map((t) => fake.visualizations.get(t.id)),
        ...Object.values(production.dashboards).map((t) => fake.dashboards.get(t.id)),
      ],
      beta: [fake.queries.get(beta.queryId), fake.visualizations.get(beta.vizId), fake.dashboards.get(beta.dashboardId)],
    });

  beforeEach(async () => {
    fake = new FakeDune();
    const q = fake.seedQuery({ name: "Safenet Beta: staking", tags: [] });
    const v = fake.seedVisualization({ query_id: q.query_id, name: "Beta chart", description: "", type: "chart", options: {} });
    const d = fake.seedDashboard({ name: "Safenet Beta", slug: "safenet-beta", vizIds: [v.id] });
    beta = { queryId: q.query_id, vizId: v.id, dashboardId: d.dashboard_id };
    production = (await runDeploy(config, emptyState(), fake.client(), { log: quiet })).state;
    preview = (
      await runDeploy(toPreview(config, settings, { sha: "a".repeat(40) }), emptyState(), fake.client(), {
        log: quiet,
        force: true,
        guards: [productionGuard(production)],
        requirePrivate: true,
      })
    ).state;
  });

  test("plans removal of exactly the track's preview resources, without writing", async () => {
    const writes = fake.writes().length;
    const p = await planCleanup(settings.track, preview, production, fake.client(), options);
    assert.deepEqual(p.blockers, []);
    assert.equal(fake.writes().length, writes);
    const ids = (r: string) => p.items.filter((i) => i.resource === r).map((i) => i.id).sort();
    assert.deepEqual(ids("query"), Object.values(preview.queries).map((t) => t.id).sort());
    assert.deepEqual(ids("visualization"), Object.values(preview.visualizations).map((t) => t.id).sort());
    assert.deepEqual(ids("dashboard"), Object.values(preview.dashboards).map((t) => t.id).sort());
  });

  test("archives queries, deletes visualizations, empties the dashboard and clears the mapping", async () => {
    const before = snapshot();
    const p = await planCleanup(settings.track, preview, production, fake.client(), options);
    const { state, manual } = await applyCleanup(p, fake.client(), quiet);
    for (const t of Object.values(preview.queries)) assert.equal(fake.queries.get(t.id)!.is_archived, true);
    for (const t of Object.values(preview.visualizations)) assert.equal(fake.visualizations.has(t.id), false);
    for (const t of Object.values(preview.dashboards)) {
      const dash = fake.dashboards.get(t.id)!;
      assert.equal(dash.visualization_widgets.length + dash.text_widgets.length, 0);
      assert.equal(dash.is_private, true);
    }
    // The API cannot archive dashboards in this fake: one manual step per dashboard.
    assert.equal(manual.length, Object.keys(preview.dashboards).length);
    assert.deepEqual(state, emptyState());
    assert.equal(snapshot(), before, "production and Beta are unchanged");
  });

  test("archives the dashboard where the API supports it", async () => {
    fake.dashboardArchive = true;
    const p = await planCleanup(settings.track, preview, production, fake.client(), options);
    const { manual } = await applyCleanup(p, fake.client(), quiet);
    for (const t of Object.values(preview.dashboards)) assert.equal(fake.dashboards.has(t.id), false);
    assert.deepEqual(manual, []);
  });

  test("refuses while another query reads a preview query", async () => {
    const id = preview.queries.safenet_events.id;
    fake.seedQuery({ name: "Someone's analysis", query_sql: `select * from query_${id}` });
    const p = await planCleanup(settings.track, preview, production, fake.client(), options);
    assert.ok(p.blockers.some((b) => b.includes(`reads query_${id}`)), p.blockers.join("\n"));
    await assert.rejects(applyCleanup(p, fake.client(), quiet), /blockers/);
    assert.equal(fake.queries.get(id)!.is_archived, false);
  });

  test("refuses resources that are not preview resources of the track", async () => {
    const tampered = structuredClone(preview);
    tampered.queries.extra = { id: beta.queryId, desired: "", remote: "" };
    const p = await planCleanup(settings.track, tampered, production, fake.client(), options);
    assert.ok(p.blockers.some((b) => b.includes("protected dashboard safe/safenet-beta")), p.blockers.join("\n"));
    const otherTrack = await planCleanup("other", preview, production, fake.client(), options);
    assert.ok(otherTrack.blockers.some((b) => b.includes("not a private query tagged safenet-preview-other")));
  });

  test("refuses a preview state that contains production IDs", async () => {
    const tampered = structuredClone(preview);
    tampered.queries.extra = { id: production.queries.transaction_checks_daily.id, desired: "", remote: "" };
    await assert.rejects(planCleanup(settings.track, tampered, production, fake.client(), options), /contains production resources/);
  });

  test("forgets resources already gone in Dune", async () => {
    const first = await applyCleanup(await planCleanup(settings.track, preview, production, fake.client(), options), fake.client(), quiet);
    assert.deepEqual(first.state, emptyState());
    const again = await planCleanup(settings.track, preview, production, fake.client(), options);
    assert.deepEqual(again.blockers.filter((b) => !b.includes("dashboard")), []);
    assert.ok(again.items.filter((i) => i.resource !== "dashboard").every((i) => i.action === "forget"));
  });
});
