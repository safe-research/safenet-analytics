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
  { column: "completed_checks", name: "Completed checks", color: "#eb6834" },
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

export function dailyHtml(rows: Row[], footer: string) {
  const days = [...rows].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const W = 900;
  const H = 300;
  const m = { top: 10, right: 10, bottom: 28, left: 40 };
  const max = Math.max(1, ...days.flatMap((d) => SERIES.map((s) => num(d[s.column]))));
  const step = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / step) * step;
  const ticks = [0, top / 2, top];
  const band = (W - m.left - m.right) / Math.max(1, days.length);
  const bar = Math.min(24, (band - 12) / SERIES.length - 2);
  const y = (v: number) => m.top + (H - m.top - m.bottom) * (1 - v / top);
  const r = Math.min(4, bar / 2);
  const marks = days.flatMap((d, i) => {
    const groupWidth = SERIES.length * bar + (SERIES.length - 1) * 2;
    const x0 = m.left + i * band + (band - groupWidth) / 2;
    return SERIES.map((s, j) => {
      const v = num(d[s.column]);
      if (!v) return "";
      const x = x0 + j * (bar + 2);
      const yt = y(v);
      const yb = y(0);
      // Rounded data end, square at the baseline.
      return `<path d="M${x},${yb} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + bar - r} Q${x + bar},${yt} ${x + bar},${yt + r} V${yb} Z" fill="${s.color}"><title>${esc(String(d.day).slice(0, 10))} ${s.name}: ${v}</title></path>`;
    });
  });
  const xLabels = days
    .map((d, i) => `<text x="${m.left + i * band + band / 2}" y="${H - 8}" text-anchor="middle">${esc(String(d.day).slice(5, 10))}</text>`)
    .join("");
  const grid = ticks
    .map((t) => `<line x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)" stroke-width="1"/><text x="${m.left - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`)
    .join("");
  const table = `<table><thead><tr><th>Day (UTC)</th>${SERIES.map((s) => `<th class="n">${s.name}</th>`).join("")}<th class="n">Not covered (likely test)</th><th class="n">Unmatched</th></tr></thead><tbody>
${[...days]
  .reverse()
  .map(
    (d) =>
      `<tr><td>${esc(String(d.day).slice(0, 10))}</td>${SERIES.map((s) => `<td class="n">${fmt(num(d[s.column]))}</td>`).join("")}<td class="n">${fmt(num(d.uncovered_chain_requests))}</td><td class="n">${fmt(num(d.unmatched_events))}</td></tr>`,
  )
  .join("\n")}
</tbody></table>`;
  return page(
    "Requests, completed checks and attestations per day",
    W + 48,
    `<div class="legend">${SERIES.map((s) => `<span><span class="key" style="background:${s.color}"></span>${s.name}</span>`).join("")}</div>
<svg width="${W}" height="${H}" role="img" aria-label="Daily requests, completed checks and attestations">${grid}${marks.join("")}${xLabels}</svg>
${table}`,
    footer,
  );
}

export function latestHtml(rows: Row[], footer: string) {
  const cols = [
    ["proposed_at", "Proposed (UTC)"],
    ["safe_chain", "Safe chain"],
    ["safe", "Safe"],
    ["safe_tx", "Safe transaction"],
    ["proposal_tx", "Request tx"],
    ["outcome", "Outcome"],
    ["outcome_tx", "Outcome tx"],
    ["attestation_tx", "Attestation tx"],
  ];
  return page(
    "Latest requests",
    1400,
    `<table><thead><tr>${cols.map(([, t]) => `<th>${t}</th>`).join("")}</tr></thead><tbody>
${rows.map((r) => `<tr>${cols.map(([c]) => `<td>${c === "proposed_at" ? esc(String(r[c]).slice(0, 19)) : linkText(r[c])}</td>`).join("")}</tr>`).join("\n")}
</tbody></table>`,
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

async function main() {
  let daily: Row[];
  let latest: Row[] = [];
  let source: string;
  if (args["daily-json"]) {
    const raw = JSON.parse(await readFile(args["daily-json"], "utf8")) as { daily?: Row[] } | Row[];
    daily = Array.isArray(raw) ? raw : (raw.daily ?? []);
    let cumulative = 0;
    for (const r of [...daily].sort((a, b) => String(a.day).localeCompare(String(b.day))))
      r.requests_cumulative = cumulative += num(r.requests);
    source = `offline rows from ${args["daily-json"]}`;
  } else {
    const key = process.env.DUNE_API_KEY;
    if (!key) throw new Error("DUNE_API_KEY is not set");
    const state = await loadState(args.state);
    const dune = new DuneClient(key);
    const dailyId = state.queries.transaction_checks_daily?.id;
    const latestId = state.queries.latest_requests?.id;
    if (!dailyId || !latestId) throw new Error("preview queries are not deployed");
    const d = await dune.latestResults(dailyId);
    daily = d.rows;
    latest = (await dune.latestResults(latestId, 25)).rows;
    source = `preview queries ${dailyId} and ${latestId}, results of ${String(d.execution_ended_at ?? "?").slice(0, 19)} UTC`;
  }
  const footer = `Rendered from ${esc(source)} for track ${esc(args.track)}, commit ${esc(args.sha!.slice(0, 7))}. Not a screenshot of Dune.`;
  await mkdir(args.out!, { recursive: true });
  const pages = [
    ["counter", counterHtml(daily, footer), 468, 260],
    ["daily", dailyHtml(daily, footer), 996, 420 + 30 * daily.length],
    ["latest", latestHtml(latest, footer), 1448, 140 + 30 * Math.max(1, latest.length)],
  ] as const;
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
