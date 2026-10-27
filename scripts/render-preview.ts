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
import { validatorColor } from "../src/validators.ts";

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
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--text-secondary); margin-bottom: 8px; }
.legend > span { white-space: nowrap; }
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

// Daily series over a long range as areas, lines or (stacked) columns, with negative values below
// the zero line (staking: completed withdrawals). The table lists the latest days with data.
export type TimeSeries = Series & { kind: "area" | "line" | "column" };
export function timeSeriesHtml(title: string, rows: Row[], series: readonly TimeSeries[], footer: string, options: { unit?: string; tableDays?: number } = {}) {
  const days = [...rows].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const W = 900;
  const H = 300;
  const m = { top: 10, right: 10, bottom: 28, left: 96 };
  const cols = series.filter((s) => s.kind === "column");
  const has = (d: Row, s: Series) => d[s.column] !== null && d[s.column] !== undefined;
  const ups = (d: Row) => cols.reduce((t, s) => t + Math.max(0, num(d[s.column])), 0);
  const downs = (d: Row) => cols.reduce((t, s) => t + Math.min(0, num(d[s.column])), 0);
  const values = days.flatMap((d) => [ups(d), downs(d), ...series.filter((s) => s.kind !== "column" && has(d, s)).map((s) => num(d[s.column]))]);
  const hi = Math.max(0, ...values);
  const lo = Math.min(0, ...values);
  const step = 10 ** Math.floor(Math.log10(Math.max(1e-9, hi - lo)));
  const top = Math.ceil(hi / step) * step;
  const bottom = Math.floor(lo / step) * step;
  const y = (v: number) => m.top + ((H - m.top - m.bottom) * (top - v)) / Math.max(1e-9, top - bottom);
  const band = (W - m.left - m.right) / Math.max(1, days.length);
  const cx = (i: number) => m.left + i * band + band / 2;
  const marks: string[] = [];
  for (const s of series.filter((x) => x.kind !== "column")) {
    const pts = days.flatMap((d, i) => (has(d, s) ? [[cx(i), y(num(d[s.column]))] as const] : []));
    if (!pts.length) continue;
    const line = pts.map(([x, v], i) => `${i ? "L" : "M"}${x.toFixed(1)},${v.toFixed(1)}`).join(" ");
    if (s.kind === "area")
      marks.push(`<path d="${line} L${pts.at(-1)![0].toFixed(1)},${y(0)} L${pts[0][0].toFixed(1)},${y(0)} Z" fill="${s.color}" fill-opacity="0.35"/>`);
    marks.push(`<path d="${line}" fill="none" stroke="${s.color}" stroke-width="2"/>`);
  }
  const bar = Math.max(1, band - 1);
  days.forEach((d, i) => {
    let up = 0;
    let down = 0;
    for (const s of cols) {
      const v = num(d[s.column]);
      if (!v) continue;
      const from = v > 0 ? up : down;
      const to = from + v;
      v > 0 ? (up = to) : (down = to);
      marks.push(`<rect x="${(cx(i) - bar / 2).toFixed(1)}" y="${Math.min(y(from), y(to)).toFixed(1)}" width="${bar.toFixed(1)}" height="${Math.abs(y(to) - y(from)).toFixed(1)}" fill="${s.color}"><title>${esc(String(d.day).slice(0, 10))} ${esc(s.name)}: ${fmt(v)}</title></rect>`);
    }
  });
  const ticks = [...new Set([bottom, 0, top / 2, top])];
  const grid = ticks
    .map((t) => `<line x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)" stroke-width="1"/><text x="${m.left - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(Math.round(t))}</text>`)
    .join("");
  const every = Math.ceil(days.length / 10);
  const xLabels = days.map((d, i) => (i % every ? "" : `<text x="${cx(i)}" y="${H - 8}" text-anchor="middle">${esc(String(d.day).slice(0, 10))}</text>`)).join("");
  const shown = [...days].reverse().filter((d) => series.some((s) => num(d[s.column]))).slice(0, options.tableDays ?? 10);
  const cell = (v: unknown) => (v === null || v === undefined ? "" : num(v).toLocaleString("en-US", { maximumFractionDigits: 2 }));
  const table = `<table><thead><tr><th>Day (UTC)</th>${series.map((s) => `<th class="n">${esc(s.name)}</th>`).join("")}</tr></thead><tbody>
${shown.map((d) => `<tr><td>${esc(String(d.day).slice(0, 10))}</td>${series.map((s) => `<td class="n">${cell(d[s.column])}</td>`).join("")}</tr>`).join("\n")}
</tbody></table><div class="note">Latest ${shown.length} days with data.</div>`;
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

// Several counters side by side (staking headline).
export function countersHtml(title: string, items: { label: string; value: unknown }[], footer: string) {
  return page(
    title,
    1400,
    `<div style="display:flex;flex-wrap:wrap;gap:24px 48px">${items
      .map((i) => `<div><div class="hero" style="font-size:40px">${i.value === null || i.value === undefined ? "–" : fmt(Math.round(num(i.value)))}</div><div class="label">${esc(i.label)}</div></div>`)
      .join("")}</div>`,
    footer,
  );
}

// A results table as on the dashboard. Missing values (null) read "not available"; links show
// their text, marked with ↗.
export type Col = [string, string] | [string, string, "pct"];
export function tableHtml(title: string, rows: Row[], cols: Col[], footer: string, width = 1400) {
  const cell = (v: unknown, format?: "pct") => {
    if (v === null || v === undefined) return '<span class="label">not available</span>';
    if (format === "pct") return `${(num(v) * 100).toFixed(1)}%`;
    if (typeof v === "number") return Number.isInteger(v) ? fmt(v) : v.toLocaleString("en-US", { maximumFractionDigits: 6 });
    return linkText(v);
  };
  const numeric = (c: string) => rows.some((r) => typeof r[c] === "number");
  return page(
    title,
    width,
    rows.length
      ? `<table><thead><tr>${cols.map(([c, t]) => `<th${numeric(c) ? ' class="n"' : ""}>${esc(t)}</th>`).join("")}</tr></thead><tbody>
${rows.map((r) => `<tr>${cols.map(([c, , f]) => `<td${numeric(c) ? ' class="n"' : ""}>${cell(r[c], f)}</td>`).join("")}</tr>`).join("\n")}
</tbody></table>`
      : `<div class="label">No data.</div>`,
    footer,
  );
}

// Sentinel response kinds (docs/metrics/sentinels.md#verdicts). Stack order keeps green and red apart.
export const RESPONSE_SERIES: Series[] = [
  { column: "secure", name: "Secure", color: "#0ca30c" },
  { column: "missing", name: "Missing response (committed, not revealed)", color: "#6f6e69" },
  { column: "insecure", name: "Insecure", color: "#d03b3b" },
  { column: "reverted_commit", name: "Commit reverted (late or invalid)", color: "#eda100" },
  { column: "no_commit", name: "No commit (abstain or offline)", color: "#b5b3ab" },
];

// Categorical colours in fixed order (blue, orange, aqua, yellow, magenta, green), assigned to
// Sentinels by sorted name over every Sentinel (the overview), so each keeps one colour in every image.
const CATEGORICAL = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
export const sentinelSeries = (names: string[]): Series[] =>
  [...new Set(names)].sort().map((name, i) => ({ column: name, name, color: CATEGORICAL[i % CATEGORICAL.length] }));

// Long labels (unlabelled Sentinel addresses) are shortened in plots; tables show them in full.
const short = (v: unknown) => {
  const t = String(v ?? "");
  return /^0x[0-9a-f]{40}$/i.test(t) ? `${t.slice(0, 6)}…${t.slice(-4)}` : t;
};

// Horizontal stacked bars, one per row, with the numbers as a table below.
export function hbarHtml(title: string, rows: Row[], label: string, series: readonly Series[], footer: string, labelTitle = "") {
  const W = 900;
  const rowH = 28;
  const total = (r: Row) => series.reduce((s, x) => s + num(r[x.column]), 0);
  // Room for the longest label and total (about 7px per character at 12px).
  const left = Math.max(190, 7 * Math.max(0, ...rows.map((r) => short(r[label]).length)) + 16);
  const right = Math.max(50, 7 * Math.max(0, ...rows.map((r) => fmt(total(r)).length)) + 12);
  const max = Math.max(1e-9, ...rows.map(total));
  const x = (v: number) => ((W - left - right) * v) / max;
  const H = rows.length * rowH + 24;
  const marks = rows.flatMap((r, i) => {
    let base = 0;
    const nonzero = series.filter((s) => num(r[s.column]) > 0);
    const y = 4 + i * rowH;
    const bars = nonzero.map((s, j) => {
      const v = num(r[s.column]);
      // 2px surface gap between segments; the end of the last segment is rounded.
      const x0 = left + x(base) + (j > 0 ? 1 : 0);
      const w = Math.max(1, x(v) - (j > 0 ? 1 : 0) - (j < nonzero.length - 1 ? 1 : 0));
      base += v;
      const last = j === nonzero.length - 1;
      return `<rect x="${x0}" y="${y}" width="${w}" height="${rowH - 10}" rx="${last ? 4 : 0}" fill="${s.color}"><title>${esc(r[label])} ${esc(s.name)}: ${fmt(v)}</title></rect>`;
    });
    return [
      `<text x="${left - 8}" y="${y + rowH / 2}" text-anchor="end">${esc(short(r[label]))}</text>`,
      ...bars,
      `<text x="${left + x(total(r)) + 6}" y="${y + rowH / 2}">${fmt(total(r))}</text>`,
    ];
  });
  const table = `<table><thead><tr><th>${esc(labelTitle)}</th>${series.map((s) => `<th class="n">${esc(s.name)}</th>`).join("")}</tr></thead><tbody>
${rows.map((r) => `<tr><td>${esc(r[label])}</td>${series.map((s) => `<td class="n">${fmt(num(r[s.column]))}</td>`).join("")}</tr>`).join("\n")}
</tbody></table>`;
  return page(
    title,
    W + 48,
    rows.every((r) => total(r) === 0)
      ? `<div class="label">No data in range.</div>`
      : `${series.length > 1 ? `<div class="legend">${series.map((s) => `<span><span class="key" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("")}</div>` : ""}
<svg width="${W}" height="${H}" role="img" aria-label="${esc(title)}">${marks.join("")}</svg>
${table}`,
    footer,
  );
}

// Sequential blue ramp (light = low participation), for the heatmap.
const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const rampColor = (pct: number) => RAMP[Math.min(RAMP.length - 1, Math.floor((pct / 100) * RAMP.length))];

// Sentinel x day heatmap of participation_pct. Days without eligible requests stay blank.
// Labels default to the Sentinel heatmap; the Validators section passes its own.
export function heatmapHtml(
  rows: Row[],
  footer: string,
  labels = { title: "Participation per day, % of eligible requests (last 30 days)", entity: "Sentinel", unit: "eligible", empty: "No eligible requests in range." },
) {
  // Every calendar day in range, so days without requests show as blank columns.
  const seen = [...new Set(rows.map((r) => String(r.day).slice(0, 10)))].sort();
  const days: string[] = [];
  for (let t = Date.parse(`${seen[0]}T00:00:00Z`); seen.length && t <= Date.parse(`${seen.at(-1)}T00:00:00Z`); t += 86_400_000)
    days.push(new Date(t).toISOString().slice(0, 10));
  const sentinels = [...new Set(rows.map((r) => String(r.sentinel)))].sort();
  const at = new Map(rows.map((r) => [`${r.sentinel}|${String(r.day).slice(0, 10)}`, r]));
  const cell = (s: string, d: string) => {
    const r = at.get(`${s}|${d}`);
    if (!r) return `<td class="hm blank" title="${esc(s)} ${d}: not eligible"></td>`;
    const pct = num(r.participation_pct);
    const dark = pct >= 50;
    return `<td class="hm" style="background:${rampColor(pct)};color:${dark ? "#fcfcfb" : "#0b0b0b"}" title="${esc(s)} ${d}: ${pct}% of ${fmt(num(r.eligible_requests))} ${labels.unit}">${pct >= 99.5 && pct < 100 ? pct.toFixed(1) : Math.round(pct)}</td>`; // never round up to 100
  };
  const legend = `<div class="legend">${RAMP.map((c, i) => `<span><span class="key" style="background:${c}"></span>${Math.round((i * 100) / RAMP.length)}–${Math.round(((i + 1) * 100) / RAMP.length)}%</span>`).join("")}<span><span class="key" style="background:var(--surface-1);outline:1px solid var(--grid)"></span>not eligible</span></div>`;
  return page(
    labels.title,
    Math.max(760, 300 + 48 * days.length),
    rows.length
      ? `<style>td.hm { width: 34px; text-align: center; padding: 6px 0; border: 2px solid var(--surface-1); font-size: 12px; } td.blank { background: var(--surface-1); } th { white-space: nowrap; }</style>
${legend}
<table><thead><tr><th>${esc(labels.entity)}</th>${days.map((d) => `<th class="n">${esc(d.slice(5))}</th>`).join("")}</tr></thead><tbody>
${sentinels.map((s) => `<tr><td>${esc(short(s))}</td>${days.map((d) => cell(s, d)).join("")}</tr>`).join("\n")}
</tbody></table>`
      : `<div class="label">${esc(labels.empty)}</div>`,
    footer,
  );
}

// Rows of (day, sentinel, value) as one row per day with a column per Sentinel.
export function pivotByDay(rows: Row[], key: string, value: string): Row[] {
  const out = new Map<string, Row>();
  for (const r of rows) {
    const d = String(r.day).slice(0, 10);
    const row = out.get(d) ?? { day: d };
    row[String(r[key])] = num(row[String(r[key])]) + num(r[value]);
    out.set(d, row);
  }
  return [...out.values()];
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

const TABLES: Record<string, { title: string; cols: Col[] }> = {
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
  sentinel_overview: {
    title: "Sentinel overview (status now; counts all time)",
    cols: [
      ["name", "Sentinel"],
      ["current_status", "Status (now)"],
      ["eligible_requests", "Eligible"],
      ["commits", "Commits"],
      ["valid_reveals", "Valid reveals"],
      ["participation_rate", "Participation", "pct"],
      ["secure", "Secure"],
      ["insecure", "Insecure"],
      ["no_commit", "No commit"],
      ["reverted_commit", "Commit reverted"],
      ["missing_responses", "Missing"],
      ["pending", "Pending"],
      ["reverted_calls", "Reverted calls"],
      ["last_revert_reason", "Last revert reason"],
      ["last_activity", "Last activity (UTC)"],
    ],
  },
  sentinel_windows: {
    title: "Participation by time window",
    cols: [
      ["name", "Sentinel"],
      ["rate_24h", "Rate 24h", "pct"],
      ["eligible_24h", "Eligible 24h"],
      ["rate_7d", "Rate 7d", "pct"],
      ["eligible_7d", "Eligible 7d"],
      ["rate_30d", "Rate 30d", "pct"],
      ["eligible_30d", "Eligible 30d"],
      ["rate_all", "Rate all time", "pct"],
      ["eligible_all", "Eligible all time"],
    ],
  },
  sentinel_disputes: {
    title: "Disputes and arbitration",
    cols: [
      ["dispute_tx", "Disputed (UTC)"],
      ["safe_chain", "Safe chain"],
      ["safe_tx", "Safe transaction"],
      ["sentinel_votes", "Sentinel votes (recorded reason)"],
      ["oracle_result", "Oracle result"],
      ["arbitration_status", "Arbitration"],
      ["ruling", "Ruling"],
      ["arbitrator_context", "Arbitrator's recorded context"],
      ["slashed_usdc", "Slashed (USDC.e)"],
      ["attested", "Attested"],
    ],
  },
  sentinel_earnings: {
    title: "Sentinel earnings (USDC.e fees and SAFE subsidies, never added together)",
    cols: [
      ["name", "Sentinel"],
      ["fee_accrued_usdc", "Fees accrued (USDC.e)"],
      ["fee_claimed_usdc", "Fees claimed (USDC.e)"],
      ["fee_outstanding_usdc", "Fees outstanding (USDC.e)"],
      ["fee_accrued_30d_usdc", "Fees accrued 30d (USDC.e)"],
      ["safe_published", "SAFE published"],
      ["safe_claimed", "SAFE claimed"],
      ["safe_claimable", "SAFE claimable"],
    ],
  },
  sentinel_bonds: {
    title: "Sentinel bonds (USDC.e; available and locked now, movements all time)",
    cols: [
      ["name", "Sentinel"],
      ["current_status", "Status (now)"],
      ["available_usdc", "Available now"],
      ["locked_usdc", "Locked now"],
      ["unclaimed_commitments", "Unclaimed commitments"],
      ["posted_usdc", "Posted"],
      ["returned_usdc", "Returned"],
      ["slashed_confirmed_usdc", "Slashed (claimed)"],
      ["slashed_unclaimed_usdc", "Slashed (not yet claimed)"],
      ["slashed_missing_response_usdc", "of which missing response"],
      ["slashed_dispute_lost_usdc", "of which lost dispute"],
      ["slash_rule_mismatches", "Check (expected 0)"],
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

// Staking section (docs/metrics/staking.md). Names match the image list in .github/workflows/preview.yml.
const STAKING_QUERIES = ["staking_overview", "staking_daily", "staking_flow_summary", "staking_withdrawals_outstanding", "staking_by_validator"];
const BETA = "#b5b3ab";
export function stakingPages(results: Record<string, Row[]>, footer: string): [string, string, number, number][] {
  const pages: [string, string, number, number][] = [];
  const o = results.staking_overview?.[0];
  if (o)
    pages.push([
      "staking_overview",
      countersHtml(
        `Staking now (Ethereum data as of ${String(o.as_of_time ?? "").slice(0, 16)} UTC, block ${o.through_block})`,
        [
          { label: "Active stake now (SAFE)", value: o.active_stake },
          { label: "Stakers with active stake", value: o.active_stakers },
          { label: "Outstanding withdrawals (SAFE)", value: o.outstanding_withdrawals },
          { label: "of which claimable now (SAFE)", value: o.claimable_withdrawals },
          { label: "On deregistered validators (SAFE)", value: o.deregistered_stake },
        ],
        footer,
      ),
      1448,
      240,
    ]);
  if (results.staking_flow_summary)
    pages.push([
      "staking_flows",
      tableHtml("Staking flows (SAFE)", results.staking_flow_summary, [
        ["period", "Period"],
        ["deposits", "Deposits"],
        ["withdrawals_requested", "Withdrawal requests"],
        ["withdrawals_completed", "Completed withdrawals"],
        ["net_capital_flow", "Net capital flow"],
        ["active_stake_change", "Active stake change"],
        ["deposit_count", "Deposits (n)"],
        ["depositors", "Depositors"],
        ["request_count", "Requests (n)"],
        ["claim_count", "Claims (n)"],
      ], footer),
      1448,
      320,
    ]);
  const d = results.staking_daily;
  if (d) {
    const h = 440 + 30 * 10;
    pages.push([
      "staking_active",
      timeSeriesHtml("Active stake (SAFE, all time; Beta before 2026-10-07)", d, [
        { column: "active_stake_beta", name: "Active stake (Beta)", color: BETA, kind: "area" },
        { column: "active_stake_production", name: "Active stake (production)", color: "#2a78d6", kind: "area" },
      ], footer),
      996,
      h,
    ]);
    pages.push([
      "staking_daily_flows",
      timeSeriesHtml("Deposits and completed withdrawals per day (SAFE, all time)", d, [
        { column: "deposits", name: "Deposits", color: "#2a78d6", kind: "column" },
        { column: "withdrawals_completed_negative", name: "Completed withdrawals", color: "#eb6834", kind: "column" },
      ], footer),
      996,
      h,
    ]);
    pages.push([
      "staking_net_flow",
      timeSeriesHtml("Net capital flow, cumulative (SAFE)", d, [
        { column: "active_stake", name: "Active stake (gap = outstanding withdrawals)", color: BETA, kind: "line" },
        { column: "net_flow", name: "Net capital flow", color: "#2a78d6", kind: "line" },
      ], footer),
      996,
      h,
    ]);
    pages.push([
      "staking_requests",
      timeSeriesHtml("Withdrawal requests per day (SAFE, all time)", d, [
        { column: "withdrawals_requested_beta", name: "Requested (Beta)", color: BETA, kind: "column" },
        { column: "withdrawals_requested_production", name: "Requested (production)", color: "#eb6834", kind: "column" },
      ], footer),
      996,
      h,
    ]);
  }
  const w = results.staking_withdrawals_outstanding;
  if (w)
    pages.push([
      "staking_outstanding",
      tableHtml(
        "Outstanding withdrawals now (earliest withdrawal first)",
        w.map((r) => ({ ...r, requested_at: String(r.requested_at ?? "").slice(0, 16), earliest_withdrawal: String(r.earliest_withdrawal ?? "").slice(0, 16) })),
        [
          ["staker", "Staker"],
          ["validator", "Validator"],
          ["amount", "Amount (SAFE)"],
          ["requested_at", "Requested (UTC)"],
          ["earliest_withdrawal", "Earliest withdrawal (UTC)"],
          ["status", "Status now"],
          ["request_tx", "Request tx"],
          ["withdrawal_id", "ID"],
        ],
        `${footer} Links (↗) go to Etherscan.`,
      ),
      1448,
      160 + 30 * Math.max(1, w.length),
    ]);
  const v = results.staking_by_validator;
  if (v)
    pages.push([
      "staking_validators",
      hbarHtml("Active stake by validator now (SAFE, rounded)", v.map((r) => ({
        ...r,
        ...Object.fromEntries(["self_stake", "delegated_stake", "unattributed_stake", "deregistered_stake"].map((c) => [c, Math.round(num(r[c]))])),
      })), "validator_label", [
        { column: "self_stake", name: "Self-stake (registered staker)", color: "#184f95" },
        { column: "delegated_stake", name: "Delegated stake", color: "#6da7ec" },
        { column: "unattributed_stake", name: "No registered staker (split unknown)", color: "#eda100" },
        { column: "deregistered_stake", name: "On deregistered validator", color: BETA },
      ], footer, "Validator"),
      996,
      300 + 64 * v.length,
    ]);
  return pages;
}

// Validators section (docs/metrics/validators.md). Names match the image list in .github/workflows/preview.yml.
const VALIDATOR_QUERIES = [
  "validator_overview",
  "validator_stake_status",
  "validator_participation_daily",
  "validator_participation_windows",
  "validator_stake_daily",
  "validator_stake_split_daily",
  "validator_rewards_periods",
  "validator_rewards_by_staker",
  "validator_withdrawal_exposure",
];
const pct = (v: unknown) => (v === null || v === undefined ? null : Math.round(num(v) * 1000) / 10);
export function validatorPages(results: Record<string, Row[]>, footer: string): [string, string, number, number][] {
  const pages: [string, string, number, number][] = [];
  const rowsHeight = (n: number) => 160 + 30 * Math.max(1, n);
  const o = results.validator_overview;
  if (o)
    pages.push([
      "validator_overview",
      tableHtml(
        `Validators now (Gnosis Chain data as of ${String(o[0]?.as_of_time ?? "").slice(0, 16)} UTC)`,
        o.map((r) => ({
          ...r,
          self_stake: r.self_stake === null ? null : Math.round(num(r.self_stake)),
          delegated_stake: r.delegated_stake === null ? null : Math.round(num(r.delegated_stake)),
          total_stake: Math.round(num(r.total_stake)),
          last_signature_share: r.last_signature_share ? String(r.last_signature_share).slice(0, 16) : null,
        })),
        [
          ["name", "Validator"],
          ["attestation_set", "Attestation set now"],
          ["staking_registration", "Staking"],
          ["self_stake", "Self-stake"],
          ["delegated_stake", "Delegated"],
          ["total_stake", "Total (SAFE)"],
          ["share_of_contract_stake", "Share of contract", "pct"],
          ["share_of_live_set_stake", "Share of live set", "pct"],
          ["observed_signed_30d", "Signed / eligible (30d)"],
          ["reward_participation_period", "Used for rewards", "pct"],
          ["last_signature_share", "Last signature share"],
        ],
        `${footer} Blank or "not available": no eligible ceremony, no registered staker, or outside the live set.`,
        1600,
      ),
      1648,
      rowsHeight(o.length),
    ]);
  const st = results.validator_stake_status;
  if (st)
    pages.push([
      "validator_stake_status",
      tableHtml("Stake by validator status now (SAFE)", st.map((r) => ({ ...r, stake: Math.round(num(r.stake)) })), [
        ["status", "Status"],
        ["stake", "Active stake (SAFE)"],
        ["share_of_contract_stake", "Share of contract stake", "pct"],
        ["validators", "Validators"],
        ["names", "Names"],
      ], footer),
      1448,
      rowsHeight(st.length),
    ]);
  const win = results.validator_participation_windows;
  if (win)
    pages.push([
      "validator_participation_windows",
      tableHtml("Signing participation by window", win, [
        ["time_window", "Window"],
        ["validator", "Validator"],
        ["signed", "Signed"],
        ["eligible", "Eligible ceremonies"],
        ["observed_participation", "Observed", "pct"],
        ["signed_transactions", "Signed attested txs"],
        ["transactions", "All attested txs"],
        ["reward_basis_rate", "Reward basis", "pct"],
      ], footer),
      1448,
      rowsHeight(win.length),
    ]);
  const daily = results.validator_participation_daily;
  if (daily) {
    const n = new Set(daily.map((r) => r.validator)).size;
    pages.push([
      "validator_heatmap",
      heatmapHtml(
        daily.map((r) => ({ day: r.day, sentinel: r.validator, participation_pct: r.participation_pct, eligible_requests: r.eligible_ceremonies })),
        footer,
        { title: "Observed signing participation per day, % of eligible ceremonies (last 30 days)", entity: "Validator", unit: "eligible ceremonies", empty: "No eligible ceremonies in range." },
      ),
      1448,
      220 + 34 * n,
    ]);
  }
  const sd = results.validator_stake_daily;
  if (sd) {
    const names = [...new Set(sd.map((r) => String(r.validator)))].sort();
    pages.push([
      "validator_stake_daily",
      timeSeriesHtml(
        "Active stake by validator (SAFE, all time; production from 2026-10-07)",
        pivotByDay(sd, "validator", "active_stake"),
        names.map((name) => ({ column: name, name, color: validatorColor(name), kind: "line" as const })),
        footer,
      ),
      996,
      740,
    ]);
  }
  const split = results.validator_stake_split_daily;
  if (split)
    pages.push([
      "validator_stake_split",
      timeSeriesHtml("Self-stake and delegated stake (SAFE, all time)", split, [
        { column: "self_stake", name: "Self-stake (registered staker)", color: "#184f95", kind: "line" },
        { column: "delegated_stake", name: "Delegated stake", color: "#6da7ec", kind: "line" },
        { column: "unattributed_stake", name: "No registered staker (split unknown)", color: "#eda100", kind: "line" },
      ], footer),
      996,
      740,
    ]);
  const rp = results.validator_rewards_periods;
  if (rp) {
    pages.push([
      "validator_rewards_periods",
      tableHtml("Rewards by period (SAFE, as published)", rp.map((r) => ({ ...r, total_allocated: r.total_allocated === null ? null : Math.round(num(r.total_allocated)), validator_stakers_allocated: r.validator_stakers_allocated === null ? null : Math.round(num(r.validator_stakers_allocated)), delegators_allocated: r.delegators_allocated === null ? null : Math.round(num(r.delegators_allocated)) })), [
        ["period", "Period"],
        ["status", "Status"],
        ["total_allocated", "Allocated"],
        ["validator_stakers_allocated", "Validator stakers"],
        ["delegators_allocated", "Delegators"],
        ["sentinel_grants", "Sentinel grants"],
        ["commission_status", "Commission split"],
        ["root_on_chain", "Root on chain"],
      ], `${footer} "not available": the period is not published, which is not 0.`),
      1448,
      rowsHeight(rp.length),
    ]);
  }
  const rs = results.validator_rewards_by_staker;
  if (rs)
    pages.push([
      "validator_rewards_by_staker",
      tableHtml("Validator staker rewards (SAFE, latest published root)", rs, [
        ["staker", "Staker"],
        ["validators", "Staker for"],
        ["eras", "Era"],
        ["allocated", "Allocated"],
        ["withheld_kyc", "Withheld (KYC)"],
        ["claimed", "Claimed"],
        ["claimable", "Claimable"],
        ["note", "Note"],
      ], footer),
      1448,
      rowsHeight(rs.length),
    ]);
  const ex = results.validator_withdrawal_exposure;
  if (ex)
    pages.push([
      "validator_withdrawal_exposure",
      hbarHtml(
        "Outstanding withdrawals by validator now (SAFE, rounded)",
        ex.map((r) => ({ ...r, waiting: Math.round(num(r.waiting)), claimable: Math.round(num(r.claimable)) })),
        "validator_label",
        [
          { column: "waiting", name: "Waiting", color: "#6da7ec" },
          { column: "claimable", name: "Claimable now", color: "#eb6834" },
        ],
        footer,
        "Validator",
      ),
      996,
      300 + 64 * Math.max(1, ex.length),
    ]);
  return pages;
}

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
    for (const q of [
      "transaction_checks_daily",
      "latest_requests",
      "results_daily",
      "fee_revenue_daily",
      "sentinel_participation_daily",
      "sentinel_verdicts",
      "sentinel_coverage",
      "sentinel_earnings_daily",
      ...STAKING_QUERIES,
      ...VALIDATOR_QUERIES,
      ...Object.keys(TABLES),
    ]) {
      const id = state.queries[q]?.id;
      if (!id) continue;
      // Queries with the same SQL as production are not executed in a preview and have no results.
      const r = await dune.latestResults(id, ["staking_daily", "validator_stake_daily", "validator_stake_split_daily"].includes(q) ? 5000 : 200).catch(() => undefined);
      if (!r?.rows.length) continue;
      results[q] = r.rows;
      ended.push(String(r.execution_ended_at ?? "?").slice(0, 16));
    }
    if (!Object.keys(results).length) throw new Error("the preview has no query results");
    source = `the preview's query results (latest ${ended.sort().at(-1)} UTC)`;
  }
  const footer = `Rendered from ${esc(source)} for track ${esc(args.track)}, commit ${esc(args.sha!.slice(0, 7))}. Not a screenshot of Dune.`;
  await mkdir(args.out!, { recursive: true });
  const daily = results.transaction_checks_daily ?? [];
  const rowsHeight = (n: number) => 160 + 30 * Math.max(1, n);
  const pages: [string, string, number, number][] = daily.length
    ? [
        ["counter", counterHtml(daily, footer), 468, 260],
        ["daily", dailyHtml(daily, footer), 996, 420 + 30 * daily.length],
      ]
    : [];
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
  if (results.sentinel_participation_daily) {
    const n = new Set(results.sentinel_participation_daily.map((r) => r.sentinel)).size;
    pages.push(["sentinel_heatmap", heatmapHtml(results.sentinel_participation_daily, footer), 1448, 220 + 34 * n]);
  }
  if (results.sentinel_verdicts) {
    const rows = results.sentinel_verdicts.map((r) => ({
      sentinel: r.sentinel,
      secure: r.secure_30d,
      missing: r.missing_30d,
      insecure: r.insecure_30d,
      reverted_commit: r.reverted_commit_30d,
      no_commit: r.no_commit_30d,
    }));
    pages.push([
      "sentinel_verdicts",
      hbarHtml("Sentinel responses by kind (requests proposed in the last 30 days)", rows, "sentinel", RESPONSE_SERIES, footer, "Sentinel"),
      996,
      260 + 64 * rows.length,
    ]);
  }
  if (results.sentinel_coverage) {
    const rows = results.sentinel_coverage;
    pages.push([
      "sentinel_coverage",
      hbarHtml(
        `Requests by number of valid Sentinel responses (last 30 days; ${fmt(num(rows[0]?.pending_requests))} still in their response window)`,
        rows,
        "bucket",
        [{ column: "requests_30d", name: "Requests", color: "#2a78d6" }],
        footer,
        "Valid responses",
      ),
      996,
      220 + 64 * rows.length,
    ]);
  }
  if (results.sentinel_earnings_daily) {
    const shown = new Set(results.sentinel_earnings_daily.map((r) => String(r.sentinel)));
    const all = [...(results.sentinel_overview ?? []).map((r) => String(r.name)), ...shown];
    const series = sentinelSeries(all).filter((x) => shown.has(x.name));
    const rows = pivotByDay(results.sentinel_earnings_daily, "sentinel", "fee_reward_usdc");
    pages.push([
      "sentinel_earnings_daily",
      columnChartHtml("Fee rewards accrued per day by Sentinel (USDC.e, last 30 days)", rows, series, footer, { stacked: true, unit: "USDC.e", decimals: 2 }),
      996,
      440 + 30 * rows.length,
    ]);
  }
  pages.push(...stakingPages(results, footer));
  pages.push(...validatorPages(results, footer));
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
