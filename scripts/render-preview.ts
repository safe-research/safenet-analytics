// Renders images of a preview's results for the pull request: the request counter, the daily chart
// and the latest-requests table. The preview dashboard is private, so a browser in CI cannot open
// it; these images are drawn from the same query results the dashboard shows, through the API,
// and say so. Reviewers open the private preview URL for the Dune rendering.
//
//   node scripts/render-preview.ts --state dune/.preview/default.json --sha SHA --out preview-out
//   node scripts/render-preview.ts --daily-json rows.json --sha SHA --out preview-out   (offline)
//
// Writes <out>/{counter,daily,latest}.html and, if Chrome is available (CHROME_PATH, google-chrome
// or chromium), the matching .png files.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DuneClient } from "../src/dune.ts";
import { loadState } from "../src/state.ts";

const { values: args } = parseArgs({
  options: {
    state: { type: "string" },
    sha: { type: "string", default: "unknown" },
    track: { type: "string", default: "default" },
    out: { type: "string", default: "preview-out" },
    "daily-json": { type: "string" },
  },
});

type Row = Record<string, unknown>;

const SERIES = [
  { column: "requests", name: "Requests", color: "#2a78d6" },
  { column: "completed_checks", name: "Completed results", color: "#eb6834" },
  { column: "attestations", name: "Attestations", color: "#1baf7a" },
] as const;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
// Table cells from Dune hold <a href> links; images show the link text, marked as a link.
const linkText = (s: unknown) => {
  const v = String(s ?? "");
  const m = v.match(/^<a [^>]*>(.*)<\/a>$/);
  return m ? `<span class="link">${esc(m[1])} ↗</span>` : esc(v);
};
const num = (v: unknown) => Number(v ?? 0);
const fmt = (n: number) => n.toLocaleString("en-US");

const page = (title: string, width: number, body: string, footer: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
.viz-root { color-scheme: light; --surface-1: #fcfcfb; --text-primary: #0b0b0b; --text-secondary: #52514e;
  --text-muted: #6f6e69; --grid: #e6e5e0; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface-1); }
.viz-root { width: ${width}px; padding: 20px 24px; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text-primary); background: var(--surface-1); }
h1 { font-size: 16px; font-weight: 600; margin: 0 0 12px; }
.note { color: var(--text-muted); font-size: 12px; margin-top: 12px; }
.hero { font-size: 56px; font-weight: 600; line-height: 1.1; }
.label { color: var(--text-secondary); }
.legend { display: flex; gap: 16px; color: var(--text-secondary); margin-bottom: 8px; }
.key { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th { text-align: left; font-weight: 600; color: var(--text-secondary); border-bottom: 1px solid var(--grid); padding: 4px 8px; }
td { padding: 4px 8px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
td.n, th.n { text-align: right; }
.link { color: #1f5fae; }
svg text { fill: var(--text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
</style></head><body><div class="viz-root">
<h1>${esc(title)}</h1>
${body}
<div class="note">${footer}</div>
</div></body></html>
`;

export function counterHtml(rows: Row[], footer: string) {
  const newest = [...rows].sort((a, b) => String(b.day).localeCompare(String(a.day)))[0];
  const total = num(newest?.requests_cumulative);
  const sum = rows.reduce((n, r) => n + num(r.requests), 0);
  return page(
    "Requests (all time)",
    420,
    `<div class="hero">${fmt(total)}</div>
<div class="label">Requests for Safes on Charter chains since 2026-10-14</div>
<div class="note">Sum of daily requests in the same result: ${fmt(sum)}${sum === total ? " (matches)" : " (MISMATCH)"}</div>`,
    footer,
  );
}

type Series = { column: string; name: string; color: string };

// Lifecycle colours of the result breakdown (docs/metrics/network-and-revenue.md#colours).
const STATUS_SERIES: Series[] = [
  { column: "secure_unanimous", name: "Secure (unanimous)", color: "#0ca30c" },
  { column: "disputed", name: "Disputed (incl. ruled)", color: "#eda100" },
  { column: "insecure_unanimous", name: "Insecure (unanimous)", color: "#d03b3b" },
  { column: "timed_out", name: "Timed out, no verdict (final)", color: "#6f6e69" },
  { column: "pending", name: "Pending (not yet decided)", color: "#b5b3ab" },
];

// Grouped or stacked columns per day, with the values as a table below (the table is the
// accessible view and carries the exact numbers).
export function columnChartHtml(
  title: string,
  rows: Row[],
  series: readonly Series[],
  footer: string,
  options: { stacked?: boolean; unit?: string; decimals?: number } = {},
) {
  const days = [...rows].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const W = 900;
  const H = 300;
  const m = { top: 10, right: 10, bottom: 28, left: 48 };
  const value = (d: Row) => (options.stacked ? series.reduce((s, x) => s + num(d[x.column]), 0) : Math.max(...series.map((x) => num(d[x.column]))));
  const max = Math.max(1e-9, ...days.map(value));
  const step = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / step) * step;
  const ticks = [0, top / 2, top];
  const band = (W - m.left - m.right) / Math.max(1, days.length);
  const groups = options.stacked ? 1 : series.length;
  const bar = Math.max(2, Math.min(24, (band - 6) / groups - 2));
  const y = (v: number) => m.top + (H - m.top - m.bottom) * (1 - v / top);
  const r = Math.min(4, bar / 2);
  const rounded = (x: number, yt: number, yb: number) =>
    `M${x},${yb} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + bar - r} Q${x + bar},${yt} ${x + bar},${yt + r} V${yb} Z`;
  const square = (x: number, yt: number, yb: number) => `M${x},${yb} V${yt} H${x + bar} V${yb} Z`;
  const tip = (d: Row, s: Series, v: number) => `<title>${esc(String(d.day).slice(0, 10))} ${esc(s.name)}: ${v}</title>`;
  const marks = days.flatMap((d, i) => {
    const groupWidth = groups * bar + (groups - 1) * 2;
    const x0 = m.left + i * band + (band - groupWidth) / 2;
    if (options.stacked) {
      let base = 0;
      const nonzero = series.filter((s) => num(d[s.column]) > 0);
      return nonzero.map((s, j) => {
        const v = num(d[s.column]);
        // 2px surface gap between stacked segments; only the top segment gets the rounded end.
        const yb = y(base) - (j > 0 ? 1 : 0);
        const yt = y(base + v) + (j < nonzero.length - 1 ? 1 : 0);
        base += v;
        return `<path d="${j === nonzero.length - 1 ? rounded(x0, yt, yb) : square(x0, yt, yb)}" fill="${s.color}">${tip(d, s, v)}</path>`;
      });
    }
    return series.map((s, j) => {
      const v = num(d[s.column]);
      return v ? `<path d="${rounded(x0 + j * (bar + 2), y(v), y(0))}" fill="${s.color}">${tip(d, s, v)}</path>` : "";
    });
  });
  const every = Math.ceil(days.length / 15);
  const xLabels = days
    .map((d, i) => (i % every ? "" : `<text x="${m.left + i * band + band / 2}" y="${H - 8}" text-anchor="middle">${esc(String(d.day).slice(5, 10))}</text>`))
    .join("");
  const grid = ticks
    .map((t) => `<line x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)" stroke-width="1"/><text x="${m.left - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`)
    .join("");
  const cell = (v: unknown) => (options.decimals ? num(v).toFixed(options.decimals) : fmt(num(v)));
  const table = `<table><thead><tr><th>Day (UTC)</th>${series.map((s) => `<th class="n">${esc(s.name)}</th>`).join("")}</tr></thead><tbody>
${[...days]
  .reverse()
  .filter((d) => series.some((s) => num(d[s.column])))
  .map((d) => `<tr><td>${esc(String(d.day).slice(0, 10))}</td>${series.map((s) => `<td class="n">${cell(d[s.column])}</td>`).join("")}</tr>`)
  .join("\n")}
</tbody></table>`;
  const empty = days.every((d) => series.every((s) => !num(d[s.column])));
  return page(
    title,
    W + 48,
    empty
      ? `<div class="label">No data in range.</div>`
      : `<div class="legend">${series.map((s) => `<span><span class="key" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("")}</div>
<svg width="${W}" height="${H}" role="img" aria-label="${esc(title)}">${grid}${marks.join("")}${xLabels}</svg>
${options.unit ? `<div class="note">${esc(options.unit)}</div>` : ""}
${table}`,
    footer,
  );
}

// A results table as on the dashboard. Missing values (null) read "not available"; links show
// their text, marked with ↗.
export function tableHtml(title: string, rows: Row[], cols: [string, string][], footer: string, width = 1400) {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '<span class="label">not available</span>';
    if (typeof v === "number") return Number.isInteger(v) ? fmt(v) : v.toLocaleString("en-US", { maximumFractionDigits: 6 });
    return linkText(v);
  };
  const numeric = (c: string) => rows.some((r) => typeof r[c] === "number");
  return page(
    title,
    width,
    rows.length
      ? `<table><thead><tr>${cols.map(([c, t]) => `<th${numeric(c) ? ' class="n"' : ""}>${esc(t)}</th>`).join("")}</tr></thead><tbody>
${rows.map((r) => `<tr>${cols.map(([c]) => `<td${numeric(c) ? ' class="n"' : ""}>${cell(r[c])}</td>`).join("")}</tr>`).join("\n")}
</tbody></table>`
      : `<div class="label">No data.</div>`,
    footer,
  );
}

export const dailyHtml = (rows: Row[], footer: string) =>
  columnChartHtml("Requests and completed results per day (last 30 days)", rows, SERIES.slice(0, 2), footer);

export function latestHtml(rows: Row[], footer: string) {
  return tableHtml(
    "Latest requests",
    rows.map((r) => ({ ...r, proposed_at: String(r.proposed_at).slice(0, 19) })),
    [
      ["proposed_at", "Proposed (UTC)"],
      ["safe_chain", "Safe chain"],
      ["safe", "Safe"],
      ["safe_tx", "Safe transaction"],
      ["proposal_tx", "Request tx"],
      ["outcome", "Status"],
      ["outcome_tx", "Outcome tx"],
      ["attestation_tx", "Attestation tx"],
      ["fee_usdc", "Fee (USDC.e)"],
    ],
    `${footer} Links (↗) go to the chain's block explorer, Safe transactions to the Safenet explorer.`,
  );
}

function chrome(): string | undefined {
  for (const c of [process.env.CHROME_PATH, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    if (!c) continue;
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {}
  }
}

function screenshot(bin: string, html: string, png: string, width: number, height: number) {
  execFileSync(
    bin,
    ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--window-size=${width},${height}`, `--screenshot=${png}`, `file://${resolve(html)}`],
    { stdio: "ignore", timeout: 60_000 },
  );
}

const TABLES: Record<string, { title: string; cols: [string, string][] }> = {
  network_summary: {
    title: "Activity and fees by time window",
    cols: [
      ["time_window", "Window"],
      ["requests", "Requests"],
      ["unique_safe_transactions", "Unique Safe txs"],
      ["sentinel_responses", "Sentinel responses"],
      ["completed_results", "Completed results"],
      ["attestations", "Attestations"],
      ["safes_with_requests", "Safes with requests"],
      ["safes_with_completed_checks", "Safes with completed checks"],
      ["operational_requests", "of which operational"],
      ["test_requests", "Test requests"],
      ["gross_fees_usdc", "Gross fees (USDC.e)"],
      ["refunds_usdc", "Refunds (USDC.e)"],
      ["gnosis_data_as_of", "Data as of (UTC)"],
    ],
  },
  network_breakdown: {
    title: "Activity by Safe network (all time)",
    cols: [
      ["network", "Safe network"],
      ["requests", "Requests"],
      ["completed_results", "Completed results"],
      ["attestations", "Attestations"],
      ["safes_with_requests", "Safes with requests"],
      ["safes_with_completed_checks", "Safes with completed checks"],
      ["unique_safe_transactions", "Unique Safe txs"],
    ],
  },
  guard_adoption: {
    title: "Guard-enabled Safes by network (now)",
    cols: [
      ["network", "Safe network"],
      ["guard_enabled_safes", "Guard-enabled Safes"],
      ["verified_production_guards", "Production guard deployments"],
      ["note", "Note"],
    ],
  },
  fee_allocation: {
    title: "Fee allocation (USDC.e, all time)",
    cols: [
      ["section", "Section"],
      ["item", "Item"],
      ["recipient", "Recipient"],
      ["accrued_usdc", "Accrued"],
      ["paid_usdc", "Paid"],
      ["outstanding_usdc", "Outstanding"],
      ["note", "Note"],
    ],
  },
  fee_config: {
    title: "Fee terms and changes",
    cols: [
      ["kind", "Kind"],
      ["fee_usdc", "Fee (USDC.e)"],
      ["bond_per_vote_usdc", "Bond per vote"],
      ["dao_fee_share_percent", "DAO share (%)"],
      ["slash_usdc", "Slash"],
      ["requests", "Requests"],
      ["first_seen", "First (UTC)"],
      ["last_seen", "Last (UTC)"],
      ["change", "Change"],
    ],
  },
};

async function main() {
  const results: Record<string, Row[]> = {};
  let source: string;
  if (args["daily-json"]) {
    const raw = JSON.parse(await readFile(args["daily-json"], "utf8")) as { daily?: Row[] } | Row[];
    const daily = Array.isArray(raw) ? raw : (raw.daily ?? []);
    let cumulative = 0;
    for (const r of [...daily].sort((a, b) => String(a.day).localeCompare(String(b.day))))
      r.requests_cumulative = cumulative += num(r.requests);
    results.transaction_checks_daily = daily;
    source = `offline rows from ${args["daily-json"]}`;
  } else {
    const key = process.env.DUNE_API_KEY;
    if (!key) throw new Error("DUNE_API_KEY is not set");
    const state = await loadState(args.state);
    const dune = new DuneClient(key);
    const ended: string[] = [];
    for (const q of ["transaction_checks_daily", "latest_requests", "results_daily", "fee_revenue_daily", ...Object.keys(TABLES)]) {
      const id = state.queries[q]?.id;
      if (!id) continue;
      const r = await dune.latestResults(id, 200);
      results[q] = r.rows;
      ended.push(String(r.execution_ended_at ?? "?").slice(0, 16));
    }
    if (!results.transaction_checks_daily) throw new Error("preview queries are not deployed");
    source = `the preview's query results (latest ${ended.sort().at(-1)} UTC)`;
  }
  const footer = `Rendered from ${esc(source)} for track ${esc(args.track)}, commit ${esc(args.sha!.slice(0, 7))}. Not a screenshot of Dune.`;
  await mkdir(args.out!, { recursive: true });
  const daily = results.transaction_checks_daily ?? [];
  const rowsHeight = (n: number) => 160 + 30 * Math.max(1, n);
  const pages: [string, string, number, number][] = [
    ["counter", counterHtml(daily, footer), 468, 260],
    ["daily", dailyHtml(daily, footer), 996, 420 + 30 * daily.length],
  ];
  if (results.results_daily)
    pages.push(["results", columnChartHtml("Requests by proposal day and current status (last 30 days)", results.results_daily, STATUS_SERIES, footer, { stacked: true }), 996, 440 + 30 * results.results_daily.length]);
  if (results.fee_revenue_daily)
    pages.push([
      "fees",
      columnChartHtml(
        "Gross fees collected and refunds per day (USDC.e, last 30 days)",
        results.fee_revenue_daily,
        [
          { column: "gross_fees_usdc", name: "Gross fees collected", color: "#2a78d6" },
          { column: "refunds_usdc", name: "Refunded to sponsors", color: "#eb6834" },
        ],
        footer,
        { unit: "USDC.e", decimals: 2 },
      ),
      996,
      440 + 30 * results.fee_revenue_daily.length,
    ]);
  for (const [q, t] of Object.entries(TABLES))
    if (results[q]) pages.push([q, tableHtml(t.title, results[q], t.cols, footer), 1448, rowsHeight(results[q].length)]);
  if (results.latest_requests) pages.push(["latest", latestHtml(results.latest_requests, footer), 1448, rowsHeight(results.latest_requests.length)]);
  const bin = chrome();
  for (const [name, html, width, height] of pages) {
    const file = join(args.out!, `${name}.html`);
    await writeFile(file, html);
    if (bin) screenshot(bin, file, join(args.out!, `${name}.png`), width, height);
  }
  console.log(bin ? `Rendered ${pages.length} images to ${args.out}` : `Wrote HTML to ${args.out}; no Chrome found for PNGs`);
  if (!bin && process.env.CI) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
