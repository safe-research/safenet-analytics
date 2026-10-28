import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { runDeploy } from "../src/deploy.ts";
import { diagnoseDashboard, formatDiagnosis, formatStoredOptions, hasErrors, storedOptions } from "../src/diagnose.ts";
import type { State } from "../src/state.ts";
import { emptyState } from "../src/state.ts";
import { FakeDune } from "./fake-dune.ts";

const config = await loadConfig();
const specs = config.queries.flatMap((q) => q.visualizations);
const HEATMAP = "sentinel_participation_daily/heatmap";
const LATEST = "latest_requests/table";

describe("diagnose", () => {
  let fake: FakeDune;
  let state: State;
  const managed = () =>
    new Map(Object.entries(state.visualizations).map(([key, t]) => [t.id, specs.find((v) => v.key === key)!] as const));
  const widget = async (dashboard: string, key: string) => {
    const d = await diagnoseDashboard(fake.client(), state.dashboards[dashboard].id, managed());
    return { d, w: d.widgets.find((w) => w.key === key)! };
  };

  beforeEach(async () => {
    fake = new FakeDune();
    fake.seedDashboard({ name: "Safenet Beta", slug: "safenet-beta", vizIds: [] });
    state = (await runDeploy(config, emptyState(), fake.client(), { log: () => {} })).state;
  });

  test("reports a query that was never executed", async () => {
    const { w } = await widget("sentinels", HEATMAP);
    assert.ok(w.findings.some((f) => f.level === "error" && f.message.startsWith("no stored result")), JSON.stringify(w));
    assert.equal(w.link, `https://dune.com/queries/${state.queries.sentinel_participation_daily.id}/${state.visualizations[HEATMAP].id}`);
  });

  test("reports pivot columns missing from the result, and nulls", async () => {
    fake.results.set(state.queries.sentinel_participation_daily.id, {
      columns: ["day", "sentinel_name", "participation_pct"],
      rows: [{ day: "2026-10-20", sentinel_name: "A", participation_pct: null }],
    });
    const { w } = await widget("sentinels", HEATMAP);
    assert.ok(w.findings.some((f) => f.level === "error" && f.message.includes("missing from the result: sentinel")), JSON.stringify(w.findings));
    assert.ok(w.findings.some((f) => f.level === "note" && f.message === "participation_pct is null in 1 of 1 rows"));
  });

  test("a result that fits the options has no errors; extra table columns are noted", async () => {
    const table = specs.find((v) => v.key === LATEST)!;
    const columns = (table.options.columns as { name: string }[]).map((c) => c.name);
    fake.results.set(state.queries.latest_requests.id, {
      columns: [...columns, "unlisted"],
      rows: [Object.fromEntries([...columns, "unlisted"].map((c) => [c, "x"]))],
    });
    const { w } = await widget("network-revenue", LATEST);
    assert.deepEqual(w.findings, [{ level: "note", message: "result columns without column settings: unlisted" }]);
    assert.deepEqual(w.result, { state: "QUERY_STATE_COMPLETED", rows: 1, columns: [...columns, "unlisted"], ended_at: undefined });
  });

  test("reports options edited in Dune, failed executions and empty results, without writing", async () => {
    fake.visualizations.get(state.visualizations[HEATMAP].id)!.options = { rendererName: "Table Heatmap" };
    fake.results.set(state.queries.sentinel_participation_daily.id, { state: "QUERY_STATE_FAILED", columns: ["day"], rows: [] });
    const writes = fake.writes().length;
    const { d, w } = await widget("sentinels", HEATMAP);
    const messages = w.findings.map((f) => f.message);
    assert.ok(messages.includes("options in Dune differ from GitHub"));
    assert.ok(messages.includes("latest execution is QUERY_STATE_FAILED"));
    assert.ok(messages.includes("pivot options.rows is missing or not a list"));
    assert.ok(messages.includes("empty result (0 rows)"));
    assert.ok(hasErrors(d.widgets));
    assert.equal(fake.writes().length, writes);
    assert.match(formatDiagnosis(d), /\| sentinel_participation_daily\/heatmap \(\d+\) \| pivot \| failed, 0 rows \| \*\*error\*\*/);
  });

  test("lists stored options of pivot widgets and of visualizations made in the Dune UI", async () => {
    const queryId = state.queries.sentinel_participation_daily.id;
    const ui = fake.seedVisualization({ query_id: queryId, name: "UI pivot", description: "", type: "pivot", options: { rendererName: "Table Heatmap", inclusions: {} } });
    const { d } = await widget("sentinels", HEATMAP);
    const writes = fake.writes().length;
    const list = await storedOptions(fake.client(), d.widgets, new Set(managed().keys()));
    assert.deepEqual(
      list.map((v) => [v.visualization_id, v.managed, v.type]),
      [
        [state.visualizations[HEATMAP].id, true, "pivot"],
        [ui.id, false, "pivot"],
      ],
    );
    assert.equal(fake.writes().length, writes);
    assert.match(formatStoredOptions(list), /\*\*not managed\*\* pivot "UI pivot"[\s\S]*"inclusions": \{\}/);
  });
});
