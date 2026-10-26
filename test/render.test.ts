import assert from "node:assert/strict";
import { test } from "node:test";
import { columnChartHtml, latestHtml, tableHtml } from "../scripts/render-preview.ts";

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
