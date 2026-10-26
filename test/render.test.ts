import assert from "node:assert/strict";
import { test } from "node:test";
import { columnChartHtml, hbarHtml, heatmapHtml, latestHtml, pivotByDay, RESPONSE_SERIES, sentinelSeries, tableHtml } from "../scripts/render-preview.ts";

const series = [
  { column: "secure_unanimous", name: "Secure (unanimous)", color: "#0ca30c" },
  { column: "pending", name: "Pending (not yet decided)", color: "#b5b3ab" },
];

test("stacked charts draw one segment per non-zero status and keep the numbers in a table", () => {
  const html = columnChartHtml("Results", [
    { day: "2026-10-24", secure_unanimous: 3, pending: 1 },
    { day: "2026-10-25", secure_unanimous: 0, pending: 0 },
  ], series, "footer", { stacked: true });
  assert.equal((html.match(/<path /g) ?? []).length, 2);
  assert.match(html, /2026-10-24 Secure \(unanimous\): 3/);
  assert.match(html, /<td>2026-10-24<\/td><td class="n">3<\/td><td class="n">1<\/td>/);
  assert.doesNotMatch(html, /<td>2026-10-25<\/td>/, "empty days are left out of the table");
});

test("charts without data say so instead of drawing an empty plot", () => {
  const html = columnChartHtml("Fees", [{ day: "2026-10-25", secure_unanimous: 0, pending: 0 }], series, "footer");
  assert.match(html, /No data in range/);
  assert.doesNotMatch(html, /<svg/);
});

test("tables mark missing values and show link text", () => {
  const html = tableHtml(
    "Guard",
    [{ network: "Ethereum", guard_enabled_safes: null, link: '<a href="https://etherscan.io/address/0x1" target="_blank">0x1</a>' }],
    [["network", "Network"], ["guard_enabled_safes", "Guard-enabled"], ["link", "Link"]],
    "footer",
  );
  assert.match(html, /not available/);
  assert.match(html, /0x1 ↗/);
  assert.match(tableHtml("Empty", [], [["a", "A"]], "f"), /No data/);
});

test("latest requests keep the explorer links visible as text", () => {
  const html = latestHtml([{ proposed_at: "2026-10-25 10:00:00.000 UTC", safe_tx: '<a href="https://safenet-explorer.eth.limo/#/safeTx?chainId=1&safeTxHash=0xab" target="_blank">0xab…</a>' }], "f");
  assert.match(html, /0xab… ↗/);
  assert.match(html, /2026-10-25 10:00:00</);
});

test("the participation heatmap leaves days without eligible requests blank, not 0", () => {
  const html = heatmapHtml(
    [
      { day: "2026-10-24", sentinel: "BlockSec", participation_pct: 100, eligible_requests: 3 },
      { day: "2026-10-26", sentinel: "BlockSec", participation_pct: 0, eligible_requests: 2 },
      { day: "2026-10-26", sentinel: "0x3bf9263cc7bb2312f69f5481c3337553469140a5", participation_pct: 50, eligible_requests: 2 },
    ],
    "f",
  );
  assert.match(html, />10-25</, "every calendar day in range is a column");
  assert.match(html, /BlockSec 2026-10-25: not eligible/);
  assert.match(html, /BlockSec 2026-10-26: 0% of 2 eligible/);
  assert.match(html, /0x3bf9…40a5/);
  assert.match(heatmapHtml([], "f"), /No eligible requests/);
});

test("horizontal stacked bars keep every kind in the legend and the numbers in a table", () => {
  const html = hbarHtml("Kinds", [{ sentinel: "BlockSec", secure: 2, missing: 0, insecure: 1, reverted_commit: 0, no_commit: 1 }], "sentinel", RESPONSE_SERIES, "f", "Sentinel");
  assert.equal((html.match(/<rect /g) ?? []).length, 3, "one segment per non-zero kind");
  for (const s of RESPONSE_SERIES) assert.ok(html.includes(s.name), s.name);
  assert.match(html, /<td>BlockSec<\/td><td class="n">2<\/td><td class="n">0<\/td><td class="n">1<\/td>/);
  assert.match(hbarHtml("Empty", [{ sentinel: "x", secure: 0 }], "sentinel", RESPONSE_SERIES, "f"), /No data in range/);
});

test("Sentinel colours follow the name, not the order of appearance; daily rows pivot per Sentinel", () => {
  const a = sentinelSeries(["OpenCover", "Candide", "BlockSec"]);
  const b = sentinelSeries(["BlockSec", "Candide", "Candide", "OpenCover"]);
  assert.deepEqual(a, b);
  const rows = pivotByDay([{ day: "2026-10-25", sentinel: "A", fee: 1 }, { day: "2026-10-25", sentinel: "B", fee: 2 }], "sentinel", "fee");
  assert.deepEqual(rows, [{ day: "2026-10-25", A: 1, B: 2 }]);
  assert.match(columnChartHtml("Fees", rows, sentinelSeries(["A", "B"]), "f", { stacked: true }), /2026-10-25 B: 2/);
});
