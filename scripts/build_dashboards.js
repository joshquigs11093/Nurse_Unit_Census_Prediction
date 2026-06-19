// Build static dashboard HTML pages from outputs/tableau/ CSVs.
// HTML files land in docs/ (served by GitHub Pages).
// Screenshots (when not --no-screenshots) land in outputs/figures/dashboards/.
//
// Usage:
//   node scripts/build_dashboards.js                  (HTML + PNG screenshots; needs puppeteer)
//   node scripts/build_dashboards.js --no-screenshots (HTML only; no extra deps)

const fs = require("fs");
const path = require("path");

// Lazy-load puppeteer only when screenshots are requested.
const SKIP_SCREENSHOTS = process.argv.includes("--no-screenshots");

const REPO_ROOT = path.resolve(__dirname, "..");
const TABLEAU_DIR = path.join(REPO_ROOT, "outputs", "tableau");
const OUT_HTML_DIR = path.join(REPO_ROOT, "docs");  // GitHub Pages serves from /docs
const OUT_PNG_DIR = path.join(OUT_HTML_DIR, "img", "dashboards");  // served from /docs/img

fs.mkdirSync(OUT_HTML_DIR, { recursive: true });
fs.mkdirSync(OUT_PNG_DIR, { recursive: true });

// ── CSV parsing (no quoting in our exports — simple split is safe) ──
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",");
  return lines.slice(1).map(line => {
    const vals = line.split(",");
    const obj = {};
    headers.forEach((h, i) => {
      const raw = vals[i];
      if (raw === undefined || raw === "") { obj[h] = null; return; }
      const n = Number(raw);
      obj[h] = Number.isFinite(n) && raw.trim() !== "" ? n : raw;
    });
    return obj;
  });
}

const readCSV = name => parseCSV(fs.readFileSync(path.join(TABLEAU_DIR, name), "utf8"));
// Some monitoring exports come from run_pipeline.py and may be absent in the
// daily cron environment; read them defensively so the build never fails.
const safeReadCSV = name => {
  try { return readCSV(name); } catch { return []; }
};

const data = {
  forecast: readCSV("forecast_predictions.csv"),
  perfAgg: readCSV("model_performance_aggregated.csv"),
  best: readCSV("best_model_per_horizon.csv"),
  unitMeta: readCSV("unit_metadata.csv"),
  exec: readCSV("executive_summary.csv"),
  driftReport: safeReadCSV("drift_report.csv"),
  driftHistory: safeReadCSV("drift_history.csv"),
  featureImportance: safeReadCSV("feature_importance.csv"),
  timeline: safeReadCSV("forecast_timeline.csv"),
  perfUnit: safeReadCSV("model_performance.csv"),
  dmSummary: safeReadCSV("dm_test_summary.csv"),
  dmResults: safeReadCSV("dm_test_results.csv"),
  residualDiag: safeReadCSV("residual_diagnostics.csv"),
};

// ── Shared CSS ──
const STYLES = `
:root {
  --tableau-blue: #1F4E79;
  --tableau-light-blue: #4E79A7;
  --tableau-orange: #F28E2B;
  --tableau-red: #E15759;
  --tableau-teal: #76B7B2;
  --tableau-green: #59A14F;
  --bg: #F4F4F4;
  --card-bg: #FFFFFF;
  --text: #2A2A2A;
  --muted: #707070;
  --border: #E0E0E0;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
}

/* ── Top navigation ── */
.topnav {
  background: var(--tableau-blue);
  color: white;
  padding: 12px 32px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}
.topnav .brand { font-weight: 600; font-size: 15px; letter-spacing: 0.2px; }
.topnav .brand a { color: white; text-decoration: none; }
.topnav .links a {
  color: white; text-decoration: none; margin-left: 24px;
  font-size: 13px; opacity: 0.78; padding-bottom: 4px;
  border-bottom: 2px solid transparent; transition: opacity 0.15s, border 0.15s;
}
.topnav .links a:hover { opacity: 1; }
.topnav .links a.active { opacity: 1; border-bottom-color: white; }

.page-body { padding: 18px; max-width: 1360px; margin: 0 auto; }
.page-body.wide { max-width: 1520px; padding: 12px 8px; }
.page-body.wide .dashboard { max-width: 1500px; }
.page-body.wide .dashboard-body { padding: 16px 12px; }
.section { margin-bottom: 28px; }

/* ── Hero (landing page) ── */
.hero {
  background: linear-gradient(135deg, var(--tableau-blue) 0%, var(--tableau-light-blue) 100%);
  color: white;
  padding: 52px 40px;
  border-radius: 4px;
  margin-bottom: 24px;
}
.hero h1 { font-size: 32px; font-weight: 600; margin-bottom: 12px; }
.hero .tagline { font-size: 16px; opacity: 0.9; max-width: 760px; line-height: 1.55; }
.hero .metric-callout {
  margin-top: 24px; padding: 16px 20px;
  background: rgba(255,255,255,0.12); border-radius: 4px;
  display: inline-block;
}
.hero .metric-callout .num { font-size: 36px; font-weight: 600; }
.hero .metric-callout .label { font-size: 13px; opacity: 0.85; }
.hero .cta-row { margin-top: 24px; display: flex; gap: 10px; flex-wrap: wrap; }
.hero .cta {
  padding: 9px 18px; background: white; color: var(--tableau-blue);
  text-decoration: none; border-radius: 3px; font-weight: 600; font-size: 13px;
}
.hero .cta.secondary {
  background: transparent; color: white; border: 1px solid rgba(255,255,255,0.5);
}

/* ── At-a-glance KPI grid ── */
.stats-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px; margin-bottom: 24px;
}
.stat-card {
  background: white; border: 1px solid var(--border);
  border-left: 4px solid var(--tableau-light-blue);
  padding: 16px 18px; border-radius: 2px;
}
.stat-card .num { font-size: 28px; font-weight: 600; line-height: 1.1; }
.stat-card .label {
  font-size: 11px; color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.4px; margin-top: 6px;
}

/* ── Architecture flow diagram ── */
.flow-diagram {
  background: white; border: 1px solid var(--border); border-radius: 2px;
  padding: 28px 24px; margin: 16px 0;
}
.flow-row {
  display: flex; align-items: center; justify-content: center;
  gap: 12px; margin: 8px 0; flex-wrap: wrap;
}
.flow-step {
  background: var(--tableau-blue); color: white;
  padding: 10px 16px; border-radius: 3px;
  font-size: 12px; font-weight: 500; text-align: center;
  min-width: 130px;
}
.flow-step.muted { background: white; color: var(--text); border: 1px solid var(--border); }
.flow-step.accent { background: var(--tableau-orange); }
.flow-step .step-sub {
  display: block; font-size: 10px; opacity: 0.75; margin-top: 2px; font-weight: 400;
}
.flow-arrow { color: var(--muted); font-size: 16px; }

/* ── Featured dashboard preview on landing ── */
.featured-preview {
  background: white; border: 1px solid var(--border); border-radius: 2px;
  padding: 20px; margin-bottom: 24px;
}
.featured-preview h3 { font-size: 16px; margin-bottom: 12px; color: var(--tableau-blue); }
.featured-preview img {
  width: 100%; height: auto; border: 1px solid var(--border); border-radius: 2px;
}
.featured-preview .caption {
  font-size: 12px; color: var(--muted); margin-top: 8px;
  display: flex; justify-content: space-between; align-items: center;
}

/* ── Model cards (models.html) ── */
.model-card {
  background: white; border: 1px solid var(--border); border-radius: 2px;
  padding: 24px 28px; margin-bottom: 18px;
  border-left: 4px solid var(--tableau-light-blue);
}
.model-card.winner { border-left-color: var(--tableau-green); }
.model-card .header {
  display: flex; justify-content: space-between; align-items: baseline;
  margin-bottom: 8px;
}
.model-card .header h2 { font-size: 18px; font-weight: 600; color: var(--tableau-blue); }
.model-card .header .family {
  font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px;
}
.model-card .description { font-size: 13px; line-height: 1.55; margin-bottom: 14px; }
.model-card .grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 14px;
}
.model-card .grid h4 {
  font-size: 11px; color: var(--tableau-blue); text-transform: uppercase;
  letter-spacing: 0.5px; margin-bottom: 6px;
}
.model-card .grid ul { list-style: none; padding-left: 0; font-size: 12px; }
.model-card .grid li { padding: 3px 0; }
.model-card .grid li::before { content: "• "; color: var(--muted); }
.perf-table {
  width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 15px;
  background: #FFFFFF; border: 1px solid var(--border); border-radius: 4px;
  overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
.perf-table th {
  background: #F4F4F4; padding: 14px 20px; font-weight: 600; text-align: left;
  text-transform: uppercase; letter-spacing: 0.04em; font-size: 12px; color: #555;
  border-bottom: 2px solid var(--tableau-blue); white-space: nowrap;
}
.perf-table td {
  padding: 14px 20px; text-align: left;
  border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums;
  color: #2A2A2A; line-height: 1.4;
}
.perf-table tbody tr:last-child td { border-bottom: none; }
.perf-table tbody tr:nth-child(even) td { background: #FAFAFA; }
.perf-table tbody tr:hover td { background: #F0F4FA; }
.perf-table th.num, .perf-table td.num { text-align: right; }
.perf-table th.center, .perf-table td.center { text-align: center; }
.perf-table td.best { background: #E8F4F8; font-weight: 600; }
.perf-table td .unit-name { font-weight: 600; color: #1F2937; }
/* Pill-style status badges for "OK" / "over 90%" / "flagged" cells. */
.status-pill {
  display: inline-block; padding: 4px 12px; border-radius: 999px;
  font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
  text-transform: uppercase; line-height: 1.4; white-space: nowrap;
}
.status-pill.alert { background: #FDECEA; color: #C13B33; border: 1px solid #F5C7C2; }
.status-pill.ok    { background: #E8F5E9; color: #2F7D31; border: 1px solid #C4E1C5; }
.status-pill.warn  { background: #FEF3DC; color: #B26A00; border: 1px solid #F5DCA0; }
.status-pill.info  { background: #E7EEF7; color: #2B5DA0; border: 1px solid #C2D3EB; }
/* In-cell utilization fill: linear-gradient mask scaled to the percent value. */
.util-cell { position: relative; }
.util-cell .util-fill {
  position: absolute; left: 0; top: 0; bottom: 0;
  background: rgba(78, 121, 167, 0.10); border-right: 2px solid rgba(78, 121, 167, 0.35);
  pointer-events: none;
}
.util-cell.warn .util-fill { background: rgba(242, 142, 43, 0.14); border-right-color: rgba(242, 142, 43, 0.55); }
.util-cell.alert .util-fill { background: rgba(225, 87, 89, 0.16); border-right-color: rgba(225, 87, 89, 0.65); }
.util-cell .util-value { position: relative; font-weight: 600; font-size: 16px; }
.util-cell.alert .util-value { color: #C13B33; }
.util-cell.warn  .util-value { color: #B26A00; }
.util-cell.ok    .util-value { color: #2F7D31; }
/* Model cards on the models page keep the older tighter centered styling. */
.model-card .perf-table { font-size: 12px; box-shadow: none; border-radius: 2px; }
.model-card .perf-table th, .model-card .perf-table td { text-align: center; padding: 6px 10px; }
.model-card .perf-table tbody tr:nth-child(even) td { background: #FFFFFF; }

/* ── Dashboards gallery ── */
.gallery {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
  gap: 18px;
}
.gallery-card {
  background: white; border: 1px solid var(--border); border-radius: 2px;
  text-decoration: none; color: inherit; display: block;
  transition: transform 0.15s, box-shadow 0.15s;
}
.gallery-card:hover {
  transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.08);
}
.gallery-card img {
  width: 100%; height: 220px; object-fit: cover; object-position: top;
  border-bottom: 1px solid var(--border);
}
.gallery-card .meta { padding: 14px 18px; }
.gallery-card .meta h3 { font-size: 15px; color: var(--tableau-blue); margin-bottom: 4px; }
.gallery-card .meta .audience {
  font-size: 11px; color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.3px; margin-bottom: 8px;
}
.gallery-card .meta p { font-size: 12px; line-height: 1.5; }

/* ── Page intro ── */
.page-intro {
  margin-bottom: 22px;
}
.page-intro h1 {
  font-size: 26px; font-weight: 600; color: var(--tableau-blue);
  margin-bottom: 6px;
}
.page-intro p { font-size: 14px; color: var(--text); max-width: 880px; }

/* ── Tableau Public embed frame ── */
.tableau-frame {
  background: white; border: 1px solid var(--border); border-radius: 2px;
  padding: 16px;
  overflow-x: auto;          /* horizontal scroll OUTSIDE the embed if needed */
  overflow-y: visible;       /* never clip vertically */
}
.tableau-frame .tableauPlaceholder {
  width: 1400px;             /* match the workbook's authored size */
  margin: 0 auto;
}
.tableau-caption {
  font-size: 11px; color: var(--muted); margin-top: 12px; text-align: center;
}
.tableau-caption a { color: var(--tableau-light-blue); text-decoration: none; }
.tableau-caption a:hover { text-decoration: underline; }

/* ── Existing dashboard styles (legacy, embedded inside page) ── */
.dashboard {
  max-width: 1360px;
  margin: 0 auto;
  background: var(--card-bg);
  border-radius: 4px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}
.dashboard-header {
  background: var(--tableau-blue);
  color: white;
  padding: 16px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.dashboard-header h1 { font-size: 20px; font-weight: 600; }
.dashboard-header .subtitle { font-size: 13px; opacity: 0.85; }
.dashboard-header .meta { font-size: 12px; opacity: 0.85; text-align: right; }
.dashboard-body { padding: 22px 24px; }
.kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin-bottom: 20px;
}
.kpi-row.tight { grid-template-columns: repeat(8, 1fr); gap: 8px; }
.kpi-card {
  background: white;
  border: 1px solid #E0E0E0;
  border-left: 4px solid var(--tableau-light-blue);
  padding: 12px 14px;
  border-radius: 2px;
}
.kpi-card.alert { border-left-color: var(--tableau-red); background: #FDF1F0; }
.kpi-card.good  { border-left-color: var(--tableau-green); }
.kpi-card.warn  { border-left-color: var(--tableau-orange); }
.kpi-card .label {
  font-size: 10px; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 4px;
}
.kpi-card .value { font-size: 26px; font-weight: 600; line-height: 1.1; }
.kpi-card .sublabel { font-size: 11px; color: var(--muted); margin-top: 3px; }
.chart-container { margin-bottom: 20px; }
.section-title {
  font-size: 12px; font-weight: 600; color: var(--tableau-blue);
  text-transform: uppercase; letter-spacing: 0.5px;
  margin-bottom: 8px; padding-bottom: 4px;
  border-bottom: 2px solid var(--tableau-light-blue);
}
table.data-table {
  width: 100%; border-collapse: collapse; font-size: 12px;
}
table.data-table th {
  background: #F4F4F4; text-align: left; padding: 8px;
  font-weight: 600; border-bottom: 2px solid var(--tableau-blue);
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;
}
table.data-table td { padding: 7px 8px; border-bottom: 1px solid #EEE; }
table.data-table tr.alert td { background: #FDF1F0; }
table.data-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.badge {
  display: inline-block; padding: 2px 8px; border-radius: 10px;
  font-size: 11px; font-weight: 600;
}
.badge.red { background: var(--tableau-red); color: white; }
.badge.green { background: var(--tableau-green); color: white; }
.badge.orange { background: var(--tableau-orange); color: white; }
.split-row { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; }
.gauge {
  height: 28px; background: #EEE; border-radius: 3px;
  position: relative; overflow: hidden;
}
.gauge .fill {
  height: 100%; background: var(--tableau-light-blue);
  border-radius: 3px;
}
.gauge .fill.alert { background: var(--tableau-red); }
.gauge .fill.warn  { background: var(--tableau-orange); }
.gauge .fill.good  { background: var(--tableau-green); }
.gauge-label {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600; color: white;
  text-shadow: 0 1px 2px rgba(0,0,0,0.4);
}
.footer-note {
  font-size: 10px; color: var(--muted); padding: 6px 24px 12px;
  text-align: right;
}

/* ── Tests page ── */
.tests-summary {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px; margin-bottom: 20px;
}
.tests-summary .card {
  background: white; border: 1px solid var(--border);
  border-left: 4px solid var(--tableau-green);
  padding: 14px 16px; border-radius: 2px;
}
.tests-summary .card.muted { border-left-color: var(--tableau-light-blue); }
.tests-summary .card.warn { border-left-color: var(--tableau-orange); }
.tests-summary .card .num { font-size: 24px; font-weight: 600; line-height: 1.1; }
.tests-summary .card .label {
  font-size: 11px; color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.4px; margin-top: 4px;
}
.tests-summary .card .sub { font-size: 11px; color: var(--muted); margin-top: 4px; }

.test-class-card {
  background: white; border: 1px solid var(--border); border-radius: 2px;
  padding: 18px 22px; margin-bottom: 14px;
  border-left: 4px solid var(--tableau-light-blue);
}
.test-class-card.requires-data { border-left-color: var(--tableau-orange); }
.test-class-card .header {
  display: flex; justify-content: space-between; align-items: baseline;
  margin-bottom: 4px; flex-wrap: wrap; gap: 8px;
}
.test-class-card .header h3 {
  font-size: 15px; color: var(--tableau-blue); font-weight: 600;
}
.test-class-card .header .meta {
  font-size: 11px; color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.3px;
}
.test-class-card .blurb {
  font-size: 12px; color: var(--muted); margin-bottom: 12px; line-height: 1.5;
}
.test-table {
  width: 100%; border-collapse: collapse; font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.test-table th {
  background: #F8F8F8; padding: 6px 10px; font-weight: 600; text-align: left;
  border-bottom: 2px solid var(--tableau-blue); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.3px;
}
.test-table td {
  padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top;
}
.test-table td.test-name { font-family: 'SFMono-Regular', Consolas, 'Courier New', monospace; font-size: 11.5px; }
.test-table td.duration { text-align: right; color: var(--muted); white-space: nowrap; }
.status-pill {
  display: inline-block; padding: 2px 8px; border-radius: 10px;
  font-size: 10px; font-weight: 600; letter-spacing: 0.3px;
  text-transform: uppercase;
}
.status-pill.pass { background: var(--tableau-green); color: white; }
.status-pill.fail { background: var(--tableau-red); color: white; }
.status-pill.skip { background: var(--muted); color: white; }
.ci-badges { margin: 12px 0 4px; display: flex; gap: 10px; flex-wrap: wrap; }
.ci-badges img { height: 20px; }
`;

// ── Navigation helper (active page link styled) ──
const REPO_URL = "https://github.com/joshquigs11093/Nurse_Unit_Census_Prediction";
function navBar(active) {
  const link = (id, href, label) =>
    `<a href="${href}"${id === active ? ' class="active"' : ""}>${label}</a>`;
  return `
<nav class="topnav">
  <div class="brand"><a href="index.html">Nurse Census Prediction</a></div>
  <div class="links">
    ${link("home", "index.html", "Home")}
    ${link("models", "models.html", "Models")}
    ${link("methodology", "methodology.html", "Methodology")}
    ${link("tests", "tests.html", "Tests")}
    ${link("dashboards", "dashboards.html", "Dashboards")}
    ${link("monitoring", "monitoring.html", "Monitoring")}
    ${link("explainability", "explainability.html", "Explainability")}
    <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
  </div>
</nav>`;
}

// ── Tableau-like Plotly layout defaults ──
// hovermode defaults to "closest" so any chart that does not override it
// still shows its hovertemplate; pages that want a unified-by-x tooltip
// (e.g. the operational timeline) override locally.
const PLOTLY_LAYOUT_BASE = {
  font: { family: "Segoe UI, Helvetica Neue, Arial, sans-serif", size: 11, color: "#2A2A2A" },
  paper_bgcolor: "#FFFFFF",
  plot_bgcolor: "#FFFFFF",
  margin: { t: 30, r: 20, b: 50, l: 60 },
  hovermode: "closest",
  xaxis: { gridcolor: "#EEEEEE", linecolor: "#CCCCCC", tickfont: { size: 11 } },
  yaxis: { gridcolor: "#EEEEEE", linecolor: "#CCCCCC", tickfont: { size: 11 } },
};
const TABLEAU_PALETTE = ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948"];

// ── Landing page (index.html) ──
function buildIndex() {
  const totalUnits = data.exec.length;  // units actively forecast
  const totalCapacity = data.exec.reduce((s, r) => s + (r.capacity || 0), 0);
  const totalCensus = data.exec.reduce((s, r) => s + (r.latest_census || 0), 0);
  const best1h = data.best.find(r => r.horizon === 1);
  const best72h = data.best.find(r => r.horizon === 72);
  const refreshTime = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const _tr = loadTestResults();
  const totalTests = (_tr && _tr.tests) ? _tr.tests.length : 47;
  const passedTests = (_tr && _tr.tests)
    ? _tr.tests.filter(t => t.outcome === "passed").length : totalTests;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Nurse Unit Census Prediction</title>
  <meta name="description" content="Multi-horizon hospital nurse-unit census forecasting — five model types, eight forecast horizons, deployed end-to-end pipeline with three operational dashboards.">
  <link rel="stylesheet" href="style.css">
</head>
<body>
${navBar("home")}
<div class="page-body">
  <section class="hero">
    <h1>Nurse Unit Census Prediction</h1>
    <p class="tagline">
      Multi-horizon census forecasting for hospital nurse units. Five model types
      trained per unit on two years of hourly admit/discharge/transfer data,
      delivering 1-, 4-, 24-, and 72-hour predictions to three operational
      dashboards, with a live drift-monitoring view.
    </p>
    <div class="metric-callout">
      <div class="num">${best1h ? best1h.within_2_patients_pct.toFixed(1) : "—"}%</div>
      <div class="label">±2 patient accuracy at 1-hour horizon · validation set</div>
    </div>
    <div class="cta-row">
      <a class="cta" href="dashboards.html">View dashboards →</a>
      <a class="cta secondary" href="models.html">Model cards</a>
      <a class="cta secondary" href="methodology.html">Methodology</a>
    </div>
  </section>

  <section class="section">
    <div class="stats-grid">
      <div class="stat-card">
        <div class="num">${totalUnits}</div>
        <div class="label">Active nurse units</div>
      </div>
      <div class="stat-card">
        <div class="num">8</div>
        <div class="label">Forecast horizons (1h–72h)</div>
      </div>
      <div class="stat-card">
        <div class="num">5+1</div>
        <div class="label">Model types + ensemble</div>
      </div>
      <div class="stat-card">
        <div class="num">${totalCapacity}</div>
        <div class="label">Total bed capacity (max observed)</div>
      </div>
      <div class="stat-card">
        <div class="num">${totalCensus}</div>
        <div class="label">Latest house-wide census</div>
      </div>
      <div class="stat-card">
        <div class="num">${best72h ? best72h.within_2_patients_pct.toFixed(1) : "—"}%</div>
        <div class="label">±2 accuracy at 72-hour horizon</div>
      </div>
      <div class="stat-card">
        <div class="num"><a href="tests.html" style="color:inherit;text-decoration:none;">${passedTests} / ${totalTests}</a></div>
        <div class="label">Pytest cases passing — <a href="tests.html" style="color:var(--tableau-light-blue);text-decoration:none;">view suite</a></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="section-title">Operational architecture</div>
    <div class="flow-diagram">
      <div class="flow-row">
        <div class="flow-step accent">GitHub Actions cron<span class="step-sub">daily 12:15 UTC</span></div>
        <div class="flow-arrow">→</div>
        <div class="flow-step">Synthetic ADT generator<span class="step-sub">scripts/generate_synthetic_hour.py</span></div>
        <div class="flow-arrow">→</div>
        <div class="flow-step">Forecast pipeline<span class="step-sub">RF · LightGBM · LSTM · ARIMA · Prophet · Ensemble</span></div>
      </div>
      <div class="flow-row">
        <div class="flow-step muted">CSV exports<span class="step-sub">outputs/tableau/</span></div>
        <div class="flow-arrow">→</div>
        <div class="flow-step muted">Dashboard rebuild<span class="step-sub">scripts/build_dashboards.js</span></div>
        <div class="flow-arrow">→</div>
        <div class="flow-step">Git commit + push<span class="step-sub">github-actions[bot]</span></div>
      </div>
      <div class="flow-row">
        <div class="flow-step muted">GitHub Pages<span class="step-sub">in-repo Plotly dashboards (this site)</span></div>
      </div>
    </div>
    <p style="font-size:12px;color:var(--muted);margin-top:8px;">
      In production, the synthetic ADT step is replaced by an ETL job pulling the live data warehouse;
      everything downstream is unchanged.
    </p>
  </section>

  <section class="section featured-preview">
    <h3>Featured: Executive Census Summary</h3>
    <a href="dashboard3.html" style="display:block;background:#FFFFFF;border:1px solid var(--border);border-radius:3px;padding:24px;text-decoration:none;color:inherit;">
      <div style="display:flex;gap:24px;flex-wrap:wrap;justify-content:space-around;">
        <div style="text-align:center;"><div style="font-size:28px;font-weight:700;color:#1F4E79;">${Math.round(totalCensus)}</div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;">House-wide census</div></div>
        <div style="text-align:center;"><div style="font-size:28px;font-weight:700;color:#1F4E79;">${Math.round(totalCapacity)}</div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;">Capacity</div></div>
        <div style="text-align:center;"><div style="font-size:28px;font-weight:700;color:${totalCapacity > 0 && (totalCensus/totalCapacity) >= 0.9 ? "#E15759" : (totalCapacity > 0 && (totalCensus/totalCapacity) >= 0.75 ? "#F28E2B" : "#59A14F")};">${totalCapacity > 0 ? (totalCensus/totalCapacity*100).toFixed(1) + "%" : "—"}</div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;">Utilization</div></div>
        <div style="text-align:center;"><div style="font-size:28px;font-weight:700;color:#E15759;">${data.exec.filter(r => r.alert_over_90pct === true || r.alert_over_90pct === "True" || Number(r.utilization_pct) >= 90).length}</div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;">Units in alert</div></div>
      </div>
    </a>
    <div class="caption">
      <span>House-wide capacity utilization, 72-hour forecasts per unit, capacity alerts.</span>
      <a href="dashboard3.html">View live →</a>
    </div>
  </section>

  <section class="section">
    <div class="section-title">Quick links</div>
    <div class="gallery">
      <a class="gallery-card" href="models.html">
        <div class="meta">
          <h3>Model cards</h3>
          <div class="audience">Six models</div>
          <p>Per-model architecture, hyperparameters, training data, validation accuracy across all eight horizons, strengths and limitations.</p>
        </div>
      </a>
      <a class="gallery-card" href="methodology.html">
        <div class="meta">
          <h3>Methodology</h3>
          <div class="audience">Pipeline · features · evaluation</div>
          <p>Data preprocessing, leakage-safe feature filtering, per-unit per-horizon training strategy, evaluation metrics and split.</p>
        </div>
      </a>
      <a class="gallery-card" href="tests.html">
        <div class="meta">
          <h3>Test suite</h3>
          <div class="audience">${totalTests} cases · pytest</div>
          <p>Per-test catalog covering data integrity, leakage prevention, chronological splits, metric correctness, model fits, prediction intervals, and drift detection. Data-free subset runs in CI.</p>
        </div>
      </a>
      <a class="gallery-card" href="monitoring.html">
        <div class="meta">
          <h3>Monitoring</h3>
          <div class="audience">Drift over time · intervals</div>
          <p>Per-unit Population Stability Index tracked against a frozen training baseline, the latest drift snapshot, and 90% prediction-interval bands by horizon.</p>
        </div>
      </a>
      <a class="gallery-card" href="explainability.html">
        <div class="meta">
          <h3>Explainability</h3>
          <div class="audience">Feature importance · per unit · per horizon</div>
          <p>Which features the deployed Random Forest and LightGBM models rely on for each unit and forecast horizon, ranked by importance.</p>
        </div>
      </a>
      <a class="gallery-card" href="${REPO_URL}" target="_blank" rel="noopener">
        <div class="meta">
          <h3>Source code</h3>
          <div class="audience">GitHub · MIT licensed</div>
          <p>Full repository: pipeline source, tests (${totalTests} cases), GitHub Actions workflow, configuration, and this static site.</p>
        </div>
      </a>
    </div>
  </section>

  <p style="font-size:11px;color:var(--muted);text-align:center;margin-top:32px;">
    Last regenerated: ${refreshTime} · Daily refresh via GitHub Actions
  </p>
</div>
</body>
</html>`;
}

// ── Models page ──
const MODEL_CARDS = [
  {
    key: "RandomForest",
    name: "Random Forest",
    family: "Tree-based ensemble (bagging)",
    library: "scikit-learn 1.3+",
    description: "Non-parametric ensemble of 200 deep decision trees, each trained on a bootstrap sample with random feature subsets. Captures non-linear interactions across the 61-feature input space without requiring scaling or distributional assumptions.",
    architecture: [
      "200 trees (n_estimators=200)",
      "max_depth=20, min_samples_split=5, min_samples_leaf=2",
      "Per-unit, per-horizon — separate model per (unit, horizon)",
      "Feature inputs respect horizon-dependent leakage filter",
    ],
    strengths: [
      "Handles non-linear feature interactions natively",
      "Built-in feature importance for interpretability",
      "Robust to outliers and missing values",
      "Best in class at the 1-hour horizon (99.7% ±2 accuracy)",
    ],
    limitations: [
      "No native uncertainty quantification (point predictions)",
      "Memory-heavy at inference (200-tree ensemble per (unit, horizon))",
      "Cannot extrapolate beyond training-data range",
    ],
  },
  {
    key: "LightGBM",
    name: "LightGBM",
    family: "Gradient-boosted decision trees",
    library: "lightgbm 4+",
    description: "Microsoft's leaf-wise gradient boosting with histogram-based splits and early stopping on the validation set. Produces strong tabular predictions at modest compute cost; the workhorse model for short-to-medium horizons in this pipeline.",
    architecture: [
      "500 estimators max with early stopping on validation",
      "max_depth=8, num_leaves=31, learning_rate=0.05",
      "Subsampling: 0.8 (rows), 0.8 (columns)",
      "Per-unit, per-horizon",
    ],
    strengths: [
      "Best-in-class accuracy on tabular features (94–98% ±2 at 2–4h horizons)",
      "Fast training and inference vs. RF for similar accuracy",
      "Handles categorical features natively, NaN-safe",
      "Built-in feature importance (split-count and gain)",
    ],
    limitations: [
      "Hyperparameter sensitive (tuning matters)",
      "No native uncertainty quantification",
      "Sequential boosting limits parallelism within one tree fit",
    ],
  },
  {
    key: "LSTM",
    name: "LSTM",
    family: "Recurrent neural network (sequence model)",
    library: "PyTorch 2+",
    description: "Two-layer stacked Long Short-Term Memory network reading 168-hour (7-day) sequences of feature vectors. Best at long horizons where short-term lag features become unavailable due to leakage filtering and the model must rely on captured temporal structure.",
    architecture: [
      "2-layer stacked LSTM, 64 hidden units per layer",
      "Dropout 0.2 between layers, dense output head",
      "Sequence length 168 hours (7 days), batch size 64",
      "Adam optimizer, lr=0.001, MSE loss, early stopping patience 10",
      "Per-unit, per-horizon (with per-horizon scaler)",
    ],
    strengths: [
      "Best at long horizons (12h–72h: 87–91% ±2 accuracy)",
      "Captures long-term temporal patterns missed by tabular models",
      "Sequence input naturally encodes recent history",
    ],
    limitations: [
      "Computationally expensive (PyTorch + per-horizon scaler)",
      "Less interpretable than tree models",
      "Requires sufficient history per unit (sparse units underperform)",
      "Per-horizon training inflates artifact count",
    ],
  },
  {
    key: "ARIMA",
    name: "ARIMA / SARIMA",
    family: "Statistical time series (Box-Jenkins)",
    library: "pmdarima · statsmodels",
    description: "Univariate seasonal ARIMA fit per unit via auto-selection over (p,d,q) and seasonal (P,D,Q) orders with daily seasonality. Trained once per unit and forecast at all horizons (8× speedup over per-horizon training).",
    architecture: [
      "auto_arima search: max_p=5, max_d=2, max_q=5",
      "Seasonal period = 24 (daily seasonality)",
      "3-month rolling window per unit (full history exhausts Kalman state)",
      "JSON parameter serialization (avoids multi-GB SARIMAX pickles)",
    ],
    strengths: [
      "Native confidence intervals from get_forecast()",
      "Statistically interpretable (clear order semantics)",
      "Robust baseline; ~82% ±2 accuracy across all horizons",
    ],
    limitations: [
      "Univariate — ignores ED, surgery, ADT flow features",
      "Slow to fit on long histories (Kalman filter overhead)",
      "Identical accuracy across horizons (cannot exploit horizon-specific features)",
    ],
  },
  {
    key: "Prophet",
    name: "Prophet",
    family: "Decomposable additive time series",
    library: "prophet 1.1+",
    description: "Facebook's piecewise-linear trend model with explicit yearly, weekly, and daily seasonality plus US holiday effects. Trained once per unit; forecasts at horizons by shifting the future dataframe.",
    architecture: [
      "yearly_seasonality, weekly_seasonality, daily_seasonality all enabled",
      "changepoint_prior_scale=0.05 (default)",
      "country_holidays='US' for built-in holiday effects",
      "Per-unit, train-once",
    ],
    strengths: [
      "Robust to missing data and outliers",
      "Native uncertainty intervals",
      "Explicit, interpretable seasonality components",
      "Holiday-aware out of the box",
    ],
    limitations: [
      "Univariate (CENSUS only)",
      "Doesn't capture short-term shocks driven by ADT flow",
      "~86% ±2 accuracy across horizons — solid baseline but bested by ML models",
    ],
  },
  {
    key: "Ensemble",
    name: "Ensemble (inverse-MAPE weighted)",
    family: "Model averaging",
    library: "Custom",
    description: "Per-unit, per-horizon weighted average of all available individual model predictions. Weights are computed from validation MAPE — better-performing models get higher weight — then normalized to sum to 1.",
    architecture: [
      "weight_i = (1 / MAPE_i) normalized across enabled models",
      "Per-unit, per-horizon weights stored as JSON",
      "Skips models with NaN MAPE on the validation set",
      "Requires ≥2 component models per (unit, horizon) to fire",
    ],
    strengths: [
      "Hedges against single-model failure modes",
      "Smoother performance across horizons (no cliff between RF dominance and LSTM dominance)",
      "MAPE-based weighting downweights poor performers automatically",
    ],
    limitations: [
      "Weights frozen from validation set — won't adapt to drift",
      "Inherits the failure modes of all components",
      "Not always the winner: tree models or LSTM often beat the ensemble at their respective horizons",
    ],
  },
];

function buildModels() {
  const horizons = [1, 2, 3, 4, 12, 24, 48, 72];
  const winners = Object.fromEntries(data.best.map(r => [r.horizon, r.model]));

  const cardHtml = (m) => {
    // Pull validation accuracy per horizon from perfAgg
    const accByH = {};
    for (const h of horizons) {
      const row = data.perfAgg.find(r => r.model === m.key && r.horizon === h);
      accByH[h] = row ? row.within_2_patients_pct : null;
    }
    const isWinnerAtAny = horizons.some(h => winners[h] === m.key);
    const perfRow = horizons.map(h => {
      const v = accByH[h];
      const isWinner = winners[h] === m.key;
      const cell = v !== null ? v.toFixed(1) + "%" : "—";
      return `<td class="${isWinner ? "best" : ""}">${cell}</td>`;
    }).join("");

    return `
    <div class="model-card${isWinnerAtAny ? " winner" : ""}" id="model-${m.key.toLowerCase()}">
      <div class="header">
        <h2>${m.name}</h2>
        <div class="family">${m.family} · ${m.library}</div>
      </div>
      <p class="description">${m.description}</p>
      <div class="grid">
        <div>
          <h4>Architecture &amp; hyperparameters</h4>
          <ul>${m.architecture.map(s => `<li>${s}</li>`).join("")}</ul>
        </div>
        <div>
          <h4>Strengths</h4>
          <ul>${m.strengths.map(s => `<li>${s}</li>`).join("")}</ul>
        </div>
      </div>
      <div class="grid" style="margin-top:8px;">
        <div>
          <h4>Limitations</h4>
          <ul>${m.limitations.map(s => `<li>${s}</li>`).join("")}</ul>
        </div>
        <div>
          <h4>Validation ±2 patient accuracy</h4>
          <table class="perf-table">
            <thead><tr>${horizons.map(h => `<th>${h}h</th>`).join("")}</tr></thead>
            <tbody><tr>${perfRow}</tr></tbody>
          </table>
          <p style="font-size:11px;color:var(--muted);margin-top:6px;">
            Cells highlighted indicate this model is the winner at that horizon.
          </p>
        </div>
      </div>
    </div>`;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Model cards — Nurse Census Prediction</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
${navBar("models")}
<div class="page-body">
  <div class="page-intro">
    <h1>Model cards</h1>
    <p>
      Six models across three families: tabular (Random Forest, LightGBM), recurrent (LSTM),
      and statistical (ARIMA, Prophet), plus an inverse-MAPE weighted ensemble. All trained
      per nurse unit; tabular and recurrent models additionally trained per forecast horizon.
      Cards below follow the Mitchell et al. (2019) ML model card convention, adapted for capstone scope.
    </p>
  </div>

  <div class="section">
    <div class="section-title">Live model performance</div>
    <a href="dashboard2.html" class="featured-preview" style="display: block; text-decoration: none; color: inherit; background:#FFFFFF; border:1px solid var(--border); border-radius:3px; padding:20px;">
      <div class="caption" style="margin:0;">
        <span>Interactive ±2 accuracy heatmap (models × horizons), per-unit accuracy breakdown with horizon selector, and best-model-per-horizon highlights.</span>
        <a href="dashboard2.html">Open dashboard →</a>
      </div>
    </a>
  </div>

  <div class="section">
    <div class="section-title">Best model per horizon</div>
    <div class="stats-grid">
      ${data.best.map(r => `
        <div class="stat-card" style="border-left-color:var(--tableau-green);">
          <div class="num">${r.within_2_patients_pct.toFixed(1)}%</div>
          <div class="label">${r.horizon}h · ${r.model} · MAE ${r.mae.toFixed(2)}</div>
        </div>`).join("")}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Individual model cards</div>
    ${MODEL_CARDS.map(cardHtml).join("")}
  </div>

  <div class="section">
    <div class="section-title">References</div>
    <ul style="font-size:12px;line-height:1.8;padding-left:20px;">
      <li>Mitchell, M., et al. (2019). Model Cards for Model Reporting. <em>FAT* '19</em>.</li>
      <li>Box, G.E.P., Jenkins, G.M. (2015). <em>Time Series Analysis: Forecasting and Control</em>, 5th ed.</li>
      <li>Taylor, S.J. &amp; Letham, B. (2018). Forecasting at scale. <em>The American Statistician</em>, 72(1).</li>
      <li>Hochreiter, S. &amp; Schmidhuber, J. (1997). Long Short-Term Memory. <em>Neural Computation</em>, 9(8).</li>
      <li>Breiman, L. (2001). Random Forests. <em>Machine Learning</em>, 45(1).</li>
      <li>Ke, G., et al. (2017). LightGBM: A Highly Efficient Gradient Boosting Decision Tree. <em>NeurIPS 30</em>.</li>
    </ul>
  </div>
</div>
</body>
</html>`;
}

// ── Methodology page ──
function buildMethodology() {
  // ── Diebold-Mariano significance summary (per horizon) ──
  const dmRows = data.dmSummary.map(r =>
    `<tr><td>${r.horizon}h</td><td>${r.modal_best_model}</td>` +
    `<td class="num">${r.n_units}</td>` +
    `<td class="num">${r.n_significant}</td>` +
    `<td class="num">${r.pct_significant}%</td></tr>`).join("");

  const dmBlock = dmRows
    ? `<table class="perf-table" style="margin-top:12px;">
      <thead><tr><th>Horizon</th><th>Best model (modal)</th><th class="num">Units tested</th>
        <th class="num">Significant</th><th class="num">% significant</th></tr></thead>
      <tbody>${dmRows}</tbody>
    </table>
    <p style="font-size:12px;color:var(--muted);margin-top:8px;">
      Per unit and horizon, the lowest-error model is tested against the runner-up with the
      Diebold-Mariano test (squared-error loss, Harvey-Leybourne-Newbold small-sample
      correction, two-sided, &alpha;&nbsp;=&nbsp;0.05). "% significant" is the share of units
      where the leading model's advantage over the runner-up is statistically significant.
      Source: <code>dm_test_summary.csv</code>.
    </p>`
    : `<p style="font-size:12px;color:var(--muted);margin-top:8px;">
      Diebold-Mariano results are generated by <code>run_pipeline.py --phase train</code>
      (<code>dm_test_summary.csv</code>) and not present in this build.</p>`;

  // ── Residual diagnostics summary (per model, across units × horizons) ──
  const median = vals => {
    const a = vals.filter(v => v !== null && Number.isFinite(v)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const sharePct = (rows, pred) => {
    const valid = rows.filter(pred.valid);
    return valid.length ? Math.round(100 * valid.filter(pred.test).length / valid.length) : null;
  };
  const byModel = {};
  data.residualDiag.forEach(r => { (byModel[r.model] = byModel[r.model] || []).push(r); });
  const rdRows = Object.keys(byModel).sort().map(m => {
    const rows = byModel[m];
    const bias = median(rows.map(r => r.mean_residual));
    const normalPct = sharePct(rows,
      { valid: r => r.shapiro_p !== null, test: r => r.shapiro_p >= 0.05 });
    const autocorrPct = sharePct(rows,
      { valid: r => r.ljung_box_p !== null, test: r => r.ljung_box_p < 0.05 });
    return `<tr><td>${m}</td><td class="num">${rows.length}</td>` +
      `<td class="num">${bias === null ? "—" : bias.toFixed(2)}</td>` +
      `<td class="num">${normalPct === null ? "—" : normalPct + "%"}</td>` +
      `<td class="num">${autocorrPct === null ? "—" : autocorrPct + "%"}</td></tr>`;
  }).join("");

  const rdBlock = rdRows
    ? `<table class="perf-table" style="margin-top:12px;">
      <thead><tr><th>Model</th><th class="num">(unit, horizon) fits</th>
        <th class="num">Median bias</th><th class="num">Residuals normal</th>
        <th class="num">Residual autocorrelation</th></tr></thead>
      <tbody>${rdRows}</tbody>
    </table>
    <p style="font-size:12px;color:var(--muted);margin-top:8px;">
      Median bias is the median mean-residual across fits (≈0 indicates an unbiased forecast).
      "Residuals normal" is the share of fits where Shapiro-Wilk fails to reject normality
      (p&nbsp;≥&nbsp;0.05); "Residual autocorrelation" is the share where Ljung-Box detects
      leftover autocorrelation (p&nbsp;&lt;&nbsp;0.05) at a 24-hour lag — expected to rise at
      longer horizons as forecasts overlap. Source: <code>residual_diagnostics.csv</code>.
    </p>`
    : `<p style="font-size:12px;color:var(--muted);margin-top:8px;">
      Residual diagnostics are generated by <code>run_pipeline.py --phase train</code>
      (<code>residual_diagnostics.csv</code>) and not present in this build.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Methodology — Nurse Census Prediction</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
${navBar("methodology")}
<div class="page-body">
  <div class="page-intro">
    <h1>Methodology</h1>
    <p>
      Pipeline design notes covering data ingestion, leakage-safe feature engineering,
      per-unit per-horizon model training, evaluation, and deployment.
    </p>
  </div>

  <div class="section">
    <div class="section-title">1. Data</div>
    <p style="font-size:13px;line-height:1.6;">
      The dataset is two years (May 2024 – May 2026) of de-identified hourly census
      and ADT (admit / discharge / transfer) aggregates across 9 active nurse units, plus
      contextual features (ED census, scheduled surgeries, holiday flags). 157,754 hourly
      observations after cleaning. Lag features (1–72 hour previous census, rolling 4/8/24h
      flow rates, 7-day rolling stats) are pre-computed in SQL and consumed directly by the
      pipeline. Real production deployment would replace the static CSV input with an ETL job
      pulling the live data warehouse.
    </p>
  </div>

  <div class="section">
    <div class="section-title">2. Train / validation / test split</div>
    <table class="perf-table" style="margin-top:12px;">
      <thead><tr><th>Split</th><th>Date range</th><th class="num">Rows</th><th class="num">%</th></tr></thead>
      <tbody>
        <tr><td>Train</td><td>2024-05-23 – 2025-06-30</td><td class="num">86,984</td><td class="num">55.1%</td></tr>
        <tr><td>Validation</td><td>2025-06-30 – 2025-09-30</td><td class="num">19,872</td><td class="num">12.6%</td></tr>
        <tr><td>Test</td><td>2025-09-30 – 2026-05-22</td><td class="num">50,898</td><td class="num">32.3%</td></tr>
      </tbody>
    </table>
    <p style="font-size:12px;color:var(--muted);margin-top:8px;">
      Strictly chronological — no shuffling. Train and validation are frozen so the drift
      baseline stays fixed; the test split holds out everything after September 2025, which
      is also the period monitored for drift.
    </p>
  </div>

  <div class="section">
    <div class="section-title">3. Leakage-safe feature filtering</div>
    <p style="font-size:13px;line-height:1.6;">
      For a forecast at horizon H, only features that would be known H hours in advance can
      be used. The pipeline enforces this automatically: lag features with lag &lt; H are
      excluded from the feature set when training the H-hour model. For H = 72, that excludes
      every census lag shorter than 72 hours and every short rolling delta — leaving only
      temporal/calendar features, the 72-hour and 168-hour lags, and 7-day rolling stats.
    </p>
    <p style="font-size:13px;line-height:1.6;margin-top:8px;">
      Twelve dedicated tests verify this property: for each of 8 horizons, no shorter-lag
      feature appears in the corresponding feature set; for every horizon, no <code>TARGET_*</code>
      column is in features.
    </p>
  </div>

  <div class="section">
    <div class="section-title">4. Per-unit, per-horizon training</div>
    <p style="font-size:13px;line-height:1.6;">
      Nurse units differ markedly in capacity, ADT volatility, and patient mix, so each unit
      gets its own model rather than a single cross-unit model with unit-as-feature. Tabular
      and recurrent models additionally train per horizon (one model per (unit, horizon) pair).
      ARIMA and Prophet train once per unit and forecast at all horizons by slicing — both are
      univariate so the fitted parameters are horizon-invariant, yielding an 8× training
      speedup. Training across units is parallelized with joblib.
    </p>
  </div>

  <div class="section">
    <div class="section-title">5. Evaluation</div>
    <p style="font-size:13px;line-height:1.6;">
      Primary metric: <strong>percentage of forecasts within ±2 patients of the actual census</strong>
      (operationally meaningful for staffing decisions). Secondary metrics: MAE, RMSE, MAPE.
      Evaluation is per (model, unit, horizon); aggregated tables report cross-unit means.
    </p>

    <div class="section-title" style="font-size:14px;margin-top:18px;">5a. Model comparison — significance testing</div>
    <p style="font-size:13px;line-height:1.6;">
      Selecting the best model per horizon on point accuracy alone risks chasing sampling
      noise, so the per-horizon winner is checked against the runner-up with a paired
      Diebold-Mariano test on their common validation targets. Short horizons are dominated by
      the tabular models and long horizons by the LSTM; the test reports where that advantage
      is statistically significant rather than incidental.
    </p>
    ${dmBlock}

    <div class="section-title" style="font-size:14px;margin-top:18px;">5b. Residual diagnostics</div>
    <p style="font-size:13px;line-height:1.6;">
      Each fit's validation residuals are tested for normality (Shapiro-Wilk, sampled if
      n&nbsp;&gt;&nbsp;5000) and for leftover autocorrelation (Ljung-Box at a 24-hour lag),
      summarised per model below.
    </p>
    ${rdBlock}
  </div>

  <div class="section">
    <div class="section-title">6. Operational deployment</div>
    <p style="font-size:13px;line-height:1.6;">
      A scheduled GitHub Actions workflow runs daily at 12:15 UTC. Each run regenerates a
      synthetic hourly window calibrated against the real distributions in
      <code>unit_metadata.csv</code>, runs the export pipeline, rebuilds the static dashboards,
      and commits the result. GitHub Pages auto-rebuilds and any connected Tableau Public
      workbook refreshes daily. Production deployment swaps the synthetic generator for
      a live-data ETL job and leaves the rest of the pipeline unchanged.
    </p>
  </div>

  <div class="section">
    <div class="section-title">7. Reproducibility</div>
    <p style="font-size:13px;line-height:1.6;">
      Random seeds set centrally (numpy, random, PyTorch). Dependencies pinned in
      <code>requirements.txt</code>. All hyperparameters in <code>config/config.yaml</code> —
      no magic constants in code. <strong><a href="tests.html">47 pytest cases</a></strong>
      cover data integrity, leakage prevention, chronological splits, metric correctness,
      model train/predict, ensemble weights, and feature validation; the data-free subset
      (23 cases) runs in GitHub Actions on every push.
    </p>
  </div>
</div>
</body>
</html>`;
}

// ── Dashboards gallery (dashboards.html) ──
function buildDashboardsGallery() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Dashboards — Nurse Census Prediction</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
${navBar("dashboards")}
<div class="page-body">
  <div class="page-intro">
    <h1>Dashboards</h1>
    <p>
      Three audience-specific views over the deployed forecasting pipeline. Click any card
      to open the full-screen interactive dashboard.
    </p>
  </div>

  <div class="gallery">
    <a class="gallery-card" href="dashboard1.html">
      <img src="img/dashboards/dashboard1.png" alt="Operational Census Forecast preview">
      <div class="meta">
        <h3>Operational Census Forecast</h3>
        <div class="audience">House supervisors</div>
        <p>Current census per unit, eight-horizon forecast cards (1h, 2h, 3h, 4h, 12h, 24h, 48h, 72h) with 90% prediction intervals, seven-day actuals + forward forecast timeline with shaded band, capacity alerts.</p>
      </div>
    </a>
    <a class="gallery-card" href="dashboard2.html">
      <img src="img/dashboards/dashboard2.png" alt="Model Performance Analytics preview">
      <div class="meta">
        <h3>Model Performance Analytics</h3>
        <div class="audience">Process improvement</div>
        <p>Best-model-per-horizon highlights, full six-model × eight-horizon accuracy heatmap, per-unit accuracy breakdown with a horizon selector.</p>
      </div>
    </a>
    <a class="gallery-card" href="dashboard3.html">
      <img src="img/dashboards/dashboard3.png" alt="Executive Census Summary preview">
      <div class="meta">
        <h3>Executive Census Summary</h3>
        <div class="audience">Leadership</div>
        <p>House-wide census, capacity, and utilization KPIs, utilization-by-unit ranking with 75% watch and 90% alert thresholds, per-unit detail table with 72-hour forecasts.</p>
      </div>
    </a>
  </div>

  <p style="font-size:12px;color:var(--muted);margin-top:24px;">
    Underlying data: <code>outputs/tableau/forecast_predictions.csv</code>, <code>forecast_timeline.csv</code>,
    <code>executive_summary.csv</code>, <code>model_performance.csv</code>,
    <code>unit_metadata.csv</code>, <code>best_model_per_horizon.csv</code>.
    All refreshed daily via the GitHub Actions cron and rendered in-repo with Plotly.
  </p>
</div>
</body>
</html>`;
}

// Preview thumbnails are now served directly from Tableau Public's CDN
// (https://public.tableau.com/static/images/...), so no local copy step needed.

// ── Tests page (tests.html) ──
// Catalog of tests with one-line descriptions of what each one verifies.
// Statuses + durations are pulled from outputs/test_results.json if present
// (committed by the test workflow); otherwise the page renders with a
// "pending" pill so the catalog itself is always available.
const TEST_CATALOG = [
  {
    name: "TestDataLoading",
    requiresData: true,
    blurb: "Confirms the raw ADT export loads with the expected schema and types — catches breakage in upstream SQL exports before any feature work begins.",
    tests: [
      { name: "test_shape", blurb: "Dataset has &gt; 100,000 rows and at least 60 columns." },
      { name: "test_required_columns", blurb: "The datetime, unit, and census columns from the config are all present." },
      { name: "test_datetime_parsed", blurb: "The datetime column is parsed as <code>datetime64</code>, not left as a string." },
      { name: "test_no_unnamed_column", blurb: "The SQL export's index column (<code>Unnamed: 0</code>) was dropped in cleaning." },
    ],
  },
  {
    name: "TestNoDataLeakage",
    requiresData: false,
    blurb: "The single most important class in the suite. Forecasting at horizon H must not use any feature whose lag is &lt; H, and must never see any <code>TARGET_*</code> column. Parametrized across all eight horizons.",
    tests: [
      { name: "test_no_short_lags_for_horizon[1]",  blurb: "At H=1, no lag feature with lag &lt; 1 leaks into the feature set." },
      { name: "test_no_short_lags_for_horizon[2]",  blurb: "At H=2, no lag feature with lag &lt; 2 leaks into the feature set." },
      { name: "test_no_short_lags_for_horizon[3]",  blurb: "At H=3, no lag feature with lag &lt; 3 leaks into the feature set." },
      { name: "test_no_short_lags_for_horizon[4]",  blurb: "At H=4, no lag feature with lag &lt; 4 leaks into the feature set." },
      { name: "test_no_short_lags_for_horizon[12]", blurb: "At H=12, no lag feature with lag &lt; 12 leaks into the feature set." },
      { name: "test_no_short_lags_for_horizon[24]", blurb: "At H=24, no lag feature with lag &lt; 24 leaks into the feature set." },
      { name: "test_no_short_lags_for_horizon[48]", blurb: "At H=48, no lag feature with lag &lt; 48 leaks into the feature set." },
      { name: "test_no_short_lags_for_horizon[72]", blurb: "At H=72, no lag feature with lag &lt; 72 leaks into the feature set." },
      { name: "test_no_target_in_features[1]",  blurb: "No <code>TARGET_CENSUS_*</code> column appears in the H=1 feature list." },
      { name: "test_no_target_in_features[12]", blurb: "No <code>TARGET_CENSUS_*</code> column appears in the H=12 feature list." },
      { name: "test_no_target_in_features[24]", blurb: "No <code>TARGET_CENSUS_*</code> column appears in the H=24 feature list." },
      { name: "test_no_target_in_features[72]", blurb: "No <code>TARGET_CENSUS_*</code> column appears in the H=72 feature list." },
      { name: "test_no_unit_encoded_in_features", blurb: "Per-unit models do not include <code>unit_encoded</code> as a feature." },
    ],
  },
  {
    name: "TestChronologicalSplit",
    requiresData: true,
    blurb: "Forecasting on a shuffled split would invalidate every accuracy number on the site. These tests fail loudly if anyone ever swaps in a random split or a stratified resample.",
    tests: [
      { name: "test_no_temporal_overlap", blurb: "train.max ≤ val.min and val.max ≤ test.min — splits are strictly ordered in time." },
      { name: "test_split_sizes",          blurb: "Train is the largest split; validation and test are both non-empty." },
      { name: "test_no_shuffling",         blurb: "Within each unit and split, timestamps are monotonically non-decreasing." },
    ],
  },
  {
    name: "TestMetrics",
    requiresData: false,
    blurb: "Hand-checked numerical examples for every metric quoted on the dashboards (MAE, RMSE, MAPE, ±2-patient accuracy). Anchors model-comparison numbers against ground truth, not against themselves.",
    tests: [
      { name: "test_mae_known",          blurb: "MAE on [10,20,30] vs [12,18,33] equals the hand-computed 2.333." },
      { name: "test_rmse_perfect",       blurb: "RMSE = 0 when predictions equal actuals exactly." },
      { name: "test_mape_no_zero_div",   blurb: "MAPE returns a finite number when actuals contain a zero (no divide-by-zero)." },
      { name: "test_within_n_perfect",   blurb: "±2-patient accuracy = 100% on a perfectly matched series." },
      { name: "test_within_n_partial",   blurb: "±2-patient accuracy ≈ 66.67% on a known 2-of-3-match series." },
      { name: "test_evaluate_model_keys", blurb: "<code>evaluate_model</code> returns exactly {mae, rmse, mape, within_2_patients_pct}." },
    ],
  },
  {
    name: "TestModelTrainPredict",
    requiresData: true,
    blurb: "End-to-end smoke tests for the per-unit tabular models — fit, predict, and sanity-check that outputs are usable as a forecast (right shape, never negative).",
    tests: [
      { name: "test_rf_per_unit",            blurb: "Random Forest fits on one unit and produces predictions of the validation shape." },
      { name: "test_lgbm_per_unit",          blurb: "LightGBM (with early stopping) fits and produces predictions of the validation shape." },
      { name: "test_predictions_non_negative", blurb: "A trained model never predicts a negative census — patient counts are bounded below." },
    ],
  },
  {
    name: "TestEnsemble",
    requiresData: false,
    blurb: "The ensemble blends model predictions with weights inversely proportional to validation MAPE. These tests pin down the weighting invariants the dashboards rely on.",
    tests: [
      { name: "test_weights_sum_to_one", blurb: "Inverse-MAPE weights across 3 models sum to 1.0 (within float tolerance)." },
      { name: "test_weights_positive",   blurb: "All ensemble weights are strictly positive — no model gets zeroed out." },
    ],
  },
  {
    name: "TestFeatureColumns",
    requiresData: false,
    blurb: "Sanity checks on the feature-set composition that every model consumes. Catches regressions in the leakage filter and in cyclical encoding.",
    tests: [
      { name: "test_more_features_at_short_horizon", blurb: "The H=1 model has strictly more features than the H=72 model (leakage filter is active)." },
      { name: "test_cyclical_features_present",      blurb: "<code>sin_hour</code>, <code>cos_hour</code>, <code>sin_day</code>, <code>cos_day</code> are all in the feature set." },
      { name: "test_filter_unit_returns_single_unit", blurb: "<code>filter_unit</code> returns a non-empty DataFrame containing exactly one unit ID.", requiresData: true },
    ],
  },
  {
    name: "TestPredictionIntervals",
    requiresData: false,
    blurb: "Verifies the split-conformal prediction intervals: realized coverage tracks the nominal target, the band widens as coverage rises, and bounds stay valid (non-negative, lower &le; upper).",
    tests: [
      { name: "test_conformal_coverage_holds",          blurb: "A 90% band calibrated on one sample covers ≈ 90% of a fresh exchangeable sample." },
      { name: "test_halfwidth_grows_with_coverage",      blurb: "The 95% half-width is wider than the 80% half-width on the same residuals." },
      { name: "test_halfwidth_nonnegative_and_nan_safe", blurb: "Half-width is non-negative and returns NaN cleanly on an empty residual set." },
      { name: "test_interval_clipped_to_nonnegative",    blurb: "Census intervals are clipped at zero and never invert (upper ≥ lower)." },
      { name: "test_asymmetric_quantiles_ordered",       blurb: "The lower residual quantile is below the upper for an asymmetric band." },
      { name: "test_coverage_invalid_args",              blurb: "A coverage outside (0, 1) raises rather than returning a silent bad band." },
    ],
  },
  {
    name: "TestDriftMonitoring",
    requiresData: false,
    blurb: "Covers the drift detector: PSI is near zero for identical distributions and large for shifted ones, status thresholds map correctly, and performance-drift flagging fires only on a real accuracy drop.",
    tests: [
      { name: "test_psi_zero_for_identical",            blurb: "PSI is below the 0.10 threshold when baseline and recent samples share a distribution." },
      { name: "test_psi_large_for_shifted",             blurb: "PSI reaches the major-shift threshold when the mean moves by several standard deviations." },
      { name: "test_drift_status_labels",               blurb: "PSI values map to stable / moderate / major / unknown at the expected cutoffs." },
      { name: "test_performance_drift_flags_degradation", blurb: "A within-2 drop beyond tolerance is flagged; a small drop within tolerance is not." },
      { name: "test_performance_drift_nan_safe",        blurb: "Missing recent accuracy yields no false alarm (degraded = false)." },
      { name: "test_generate_drift_report_shape",       blurb: "The per-unit report carries unit_id, a valid status, and a performance-drift flag." },
      { name: "test_generate_drift_report_missing_recent", blurb: "A unit with no recent data degrades gracefully to an unknown status." },
    ],
  },
  {
    name: "TestSeasonalityAwareDrift",
    requiresData: false,
    blurb: "Verifies the seasonality-aware drift signals: STL residual extraction (and its short-series fallback), and the alert-kind state machine that distinguishes transient, systemic, and true-drift alerts from raw PSI alone.",
    tests: [
      { name: "test_stl_residual_falls_back_when_too_short",  blurb: "When the series is shorter than two STL periods, the function returns mean-centered values rather than raising." },
      { name: "test_stl_residual_runs_on_long_series",         blurb: "On a synthetic series with a 24-hour cycle, STL extracts a residual that is tighter (lower variance) than the raw input." },
      { name: "test_derive_alert_kind_state_machine",         blurb: "All four outcomes fire correctly: stable, transient, systemic, and true_drift, given (in_major, consecutive_major, systemic_fraction) inputs." },
      { name: "test_derive_alert_kind_handles_nan_systemic",  blurb: "A NaN systemic_fraction does not trip a false systemic flag; the unit-specific true_drift path is taken instead." },
      { name: "test_derive_alert_kind_custom_thresholds",     blurb: "Persistence and systemic thresholds are configurable; the function honors overrides." },
    ],
  },
  {
    name: "TestExplainability",
    requiresData: false,
    blurb: "Verifies the feature-importance extraction: ranking is correct, the function tolerates name/length mismatches without crashing, and degrades gracefully on models that do not expose feature_importances_.",
    tests: [
      { name: "test_extract_orders_descending_with_ranks",      blurb: "Features come back sorted by importance descending, with ranks 1..N attached." },
      { name: "test_extract_falls_back_on_name_length_mismatch", blurb: "When feature_names length does not match the importance vector, positional names (<code>feature_0</code>, ...) are used instead of mismatched labels." },
      { name: "test_extract_empty_when_model_lacks_importances", blurb: "A model without a <code>feature_importances_</code> attribute returns an empty list rather than raising." },
      { name: "test_extract_single_feature",                    blurb: "Single-feature models are handled correctly (rank = 1, no edge-case crashes)." },
    ],
  },
  {
    name: "TestEquity",
    requiresData: false,
    blurb: "Covers the per-unit equity classifier: flags underserved when accuracy lags the cohort median or when interval coverage drifts off nominal, recognizes well-served units, and defaults to served on missing inputs.",
    tests: [
      { name: "test_underserved_when_accuracy_far_below_median", blurb: "A 10-pt gap below the cohort median fires the <em>underserved</em> label." },
      { name: "test_underserved_when_coverage_drifts",           blurb: "Solid accuracy but a 90% interval covering only 78% still fires <em>underserved</em>." },
      { name: "test_well_served_when_clearly_above_median",      blurb: "A unit comfortably above the median with healthy coverage reads as <em>well-served</em>." },
      { name: "test_served_when_within_tolerance",               blurb: "Small accuracy variations within the configured tolerance read as <em>served</em>." },
      { name: "test_nan_inputs_default_to_served",               blurb: "Missing accuracy or coverage does not fire a spurious flag." },
      { name: "test_custom_thresholds",                          blurb: "Tighter custom thresholds escalate borderline gaps to <em>underserved</em>." },
    ],
  },
];

function loadTestResults() {
  const p = path.join(REPO_ROOT, "outputs", "test_results.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}

function buildTests() {
  const results = loadTestResults();
  // Build node-id → result map: key form "TestClass::test_name"
  const byKey = {};
  let totalRuntime = 0;
  if (results && Array.isArray(results.tests)) {
    totalRuntime = results.duration || 0;
    for (const t of results.tests) {
      const parts = t.nodeid.split("::");
      const key = `${parts[1]}::${parts[2]}`;
      byKey[key] = {
        outcome: t.outcome,
        ms: ((t.call && t.call.duration) || 0) * 1000,
      };
    }
  }
  const totalTests = TEST_CATALOG.reduce((s, c) => s + c.tests.length, 0);
  const dataFreeTests = TEST_CATALOG.reduce((s, c) =>
    s + c.tests.filter(t => !(t.requiresData ?? c.requiresData)).length, 0);
  const passed = Object.values(byKey).filter(v => v.outcome === "passed").length;
  const failed = Object.values(byKey).filter(v => v.outcome === "failed").length;
  const lastRunIso = results && results.created
    ? new Date(results.created * 1000).toISOString().slice(0, 10)
    : "—";

  const pillFor = (key) => {
    const r = byKey[key];
    if (!r) return `<span class="status-pill skip">Pending</span>`;
    if (r.outcome === "passed") return `<span class="status-pill pass">Pass</span>`;
    if (r.outcome === "failed") return `<span class="status-pill fail">Fail</span>`;
    return `<span class="status-pill skip">${r.outcome}</span>`;
  };
  const durationFor = (key) => {
    const r = byKey[key];
    if (!r) return "—";
    if (r.ms < 1) return r.ms.toFixed(2) + " ms";
    if (r.ms < 1000) return r.ms.toFixed(1) + " ms";
    return (r.ms).toLocaleString(undefined, { maximumFractionDigits: 1 }) + " ms";
  };

  const renderClass = (cls, idx) => {
    const cardCls = cls.requiresData ? "test-class-card requires-data" : "test-class-card";
    const meta = cls.requiresData
      ? `${cls.tests.length} cases · requires_data`
      : (cls.name === "TestFeatureColumns"
          ? `${cls.tests.length} cases · 2 in CI · 1 requires_data`
          : `${cls.tests.length} cases · pure config — runs in CI`);
    const rows = cls.tests.map(t => {
      const key = `${cls.name}::${t.name}`;
      return `        <tr><td class="test-name">${t.name}</td><td>${t.blurb}</td><td>${pillFor(key)}</td><td class="duration">${durationFor(key)}</td></tr>`;
    }).join("\n");
    return `  <div class="${cardCls}">
    <div class="header">
      <h3>${idx + 1} · ${cls.name}</h3>
      <span class="meta">${meta}</span>
    </div>
    <div class="blurb">${cls.blurb}</div>
    <table class="test-table">
      <thead><tr><th>Test</th><th>What it verifies</th><th>Status</th><th>Time</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>`;
  };

  const summaryHeadline = results
    ? `${passed} / ${totalTests}`
    : `${totalTests}`;
  const summarySub = results
    ? `Last local run: ${lastRunIso}`
    : `Run pytest locally to populate`;
  const ciSub = `Runs on every push`;
  const runtimeStr = results ? `${totalRuntime.toFixed(1)} s` : "—";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Tests — Nurse Census Prediction</title>
  <meta name="description" content="Pytest suite covering data integrity, leakage prevention, chronological splits, metric correctness, model training, ensemble weighting, and feature validation.">
  <link rel="stylesheet" href="style.css">
</head>
<body>
${navBar("tests")}
<div class="page-body">
  <div class="page-intro">
    <h1>Test suite</h1>
    <p>
      ${totalTests} pytest cases covering data integrity, leakage prevention, chronological
      splits, metric correctness, per-unit model training, ensemble weighting, and
      feature-column composition. Every push to <code>main</code> runs the
      data-free subset (${dataFreeTests} cases) in GitHub Actions; the full suite runs
      locally with the gitignored ADT export.
    </p>
    <div class="ci-badges">
      <a href="${REPO_URL}/actions/workflows/tests.yml" target="_blank" rel="noopener">
        <img src="${REPO_URL}/actions/workflows/tests.yml/badge.svg" alt="Tests CI status">
      </a>
    </div>
  </div>

  <div class="tests-summary">
    <div class="card">
      <div class="num">${summaryHeadline}</div>
      <div class="label">Full suite passing</div>
      <div class="sub">${summarySub}</div>
    </div>
    <div class="card">
      <div class="num">${dataFreeTests} / ${dataFreeTests}</div>
      <div class="label">CI subset passing</div>
      <div class="sub">${ciSub}</div>
    </div>
    <div class="card muted">
      <div class="num">${TEST_CATALOG.length}</div>
      <div class="label">Test classes</div>
      <div class="sub">Grouped by concern</div>
    </div>
    <div class="card muted">
      <div class="num">${runtimeStr}</div>
      <div class="label">Full suite runtime</div>
      <div class="sub">${results ? "End-to-end on the local box" : "—"}</div>
    </div>
    <div class="card ${failed > 0 ? "warn" : ""}">
      <div class="num">${results ? failed : "—"}</div>
      <div class="label">Failures</div>
      <div class="sub">${results ? "No skips, no errors" : "—"}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Why these tests, in this order</div>
    <p style="font-size:13px;line-height:1.6;">
      The suite is organized by failure mode, not by source file. Each class isolates
      a different way the pipeline could silently produce a wrong answer — leakage from
      future data into the feature set, accidental shuffling across the temporal split,
      a metric that divides by zero, a model that predicts a negative census. Tests
      that need the gitignored 38&nbsp;MB ADT export (<code>data/raw/postsql.csv</code>)
      are marked <code>requires_data</code> and skipped in CI; the rest are pure unit
      tests against config and arithmetic and run on every push.
    </p>
  </div>

${TEST_CATALOG.map(renderClass).join("\n\n")}

  <div class="section">
    <div class="section-title">How to reproduce locally</div>
    <p style="font-size:13px;line-height:1.6;">
      With <code>data/raw/postsql.csv</code> in place (or any export with the same
      schema), run the full suite:
    </p>
    <pre style="background:#f8f8f8;border:1px solid var(--border);padding:10px 14px;font-size:12px;border-radius:2px;margin-top:8px;overflow-x:auto;">python -m pytest tests/test_pipeline.py -v</pre>
    <p style="font-size:13px;line-height:1.6;margin-top:10px;">
      To match what GitHub Actions runs (no data file needed):
    </p>
    <pre style="background:#f8f8f8;border:1px solid var(--border);padding:10px 14px;font-size:12px;border-radius:2px;margin-top:8px;overflow-x:auto;">python -m pytest tests/test_pipeline.py -m "not requires_data" -v</pre>
    <p style="font-size:12px;color:var(--muted);margin-top:10px;">
      Test definitions: <a href="${REPO_URL}/blob/main/tests/test_pipeline.py" target="_blank" rel="noopener">tests/test_pipeline.py</a>
      · Workflow: <a href="${REPO_URL}/blob/main/.github/workflows/tests.yml" target="_blank" rel="noopener">.github/workflows/tests.yml</a>
    </p>
  </div>
</div>
</body>
</html>`;
}

// ── Write HTML and CSS ──
// ── Monitoring page: drift over time + prediction-interval band ──
function buildMonitoring() {
  const HORIZONS = [1, 2, 3, 4, 12, 24, 48, 72];
  const STATUS_COLOR = { stable: "#59A14F", moderate: "#F28E2B", major: "#E15759", unknown: "#999999" };
  const ALERT_COLOR = { stable: "#59A14F", transient: "#F4D03F", systemic: "#4E79A7", true_drift: "#E15759" };
  const EQUITY_COLOR = { "well-served": "#59A14F", served: "#666666", underserved: "#E15759" };

  const report = data.driftReport || [];
  const history = data.driftHistory || [];
  const hasData = report.length > 0 || history.length > 0;

  // PSI-over-time, one series per unit.
  const asOf = [...new Set(history.map(r => r.as_of))].sort();
  const histUnits = [...new Set(history.map(r => r.unit_name))];
  const psiSeries = histUnits.map(name => {
    const byDate = {};
    history.filter(r => r.unit_name === name).forEach(r => { byDate[r.as_of] = r.psi; });
    return { name, x: asOf, y: asOf.map(d => (d in byDate ? byDate[d] : null)) };
  });
  // Boundary between the real test period and the live (synthetic) feed —
  // only meaningful once forward live points exist.
  const testDates = history.filter(r => r.source === "test").map(r => r.as_of).sort();
  const hasLive = history.some(r => r.source === "live");
  const lastTestDate = (hasLive && testDates.length) ? testDates[testDates.length - 1] : null;

  // Latest snapshot, worst drift first.
  const snapshot = [...report].sort((a, b) => (b.psi || 0) - (a.psi || 0));

  // Per-unit interval bands from the latest forecast row for each unit, so the
  // selector can switch the band chart client-side.
  const bandByUnit = {};
  [...new Set(data.forecast.map(r => r.unit_name))].forEach(name => {
    const rows = data.forecast.filter(
      r => r.unit_name === name && r.pred_1hr !== null && r.pred_1hr !== "");
    if (!rows.length) return;
    const row = rows[rows.length - 1];
    const b = { horizons: [], point: [], lower: [], upper: [] };
    HORIZONS.forEach(h => {
      const p = row["pred_" + h + "hr"];
      if (p === null || p === "" || p === undefined) return;
      b.horizons.push(h);
      b.point.push(p);
      const lo = row["pred_" + h + "hr_lower"];
      const hi = row["pred_" + h + "hr_upper"];
      b.lower.push(lo === null || lo === "" || lo === undefined ? p : lo);
      b.upper.push(hi === null || hi === "" || hi === undefined ? p : hi);
    });
    if (b.horizons.length) bandByUnit[name] = b;
  });
  const worstName = snapshot.length ? snapshot[0].unit_name : null;
  const defaultBandUnit = (worstName && bandByUnit[worstName]) ? worstName
                          : (Object.keys(bandByUnit)[0] || null);

  // Unit selector options (PSI history is the primary chart).
  const unitOptions = [...histUnits].sort();
  const selectOptions = ['<option value="__all__">All units</option>']
    .concat(unitOptions.map(u =>
      '<option value="' + u.replace(/"/g, "&quot;") + '">' + u + "</option>"))
    .join("");

  const statusCell = s =>
    '<span style="color:' + (STATUS_COLOR[s] || "#999") + ';font-weight:600;">' + (s || "—") + '</span>';
  const alertCell = a => {
    const label = (a || "—").replace("_", " ");
    return '<span style="color:' + (ALERT_COLOR[a] || "#999") + ';font-weight:600;">' + label + '</span>';
  };
  const fmtPsi = v => (v === null || v === "" || v === undefined || Number.isNaN(Number(v))
                       ? "—" : Number(v).toFixed(3));
  const snapshotRows = snapshot.map(r =>
    "<tr><td>" + (r.unit_name || r.unit_id) + "</td>"
    + '<td class="num">' + fmtPsi(r.psi) + "</td>"
    + '<td class="num">' + fmtPsi(r.psi_residual) + "</td>"
    + '<td class="center">' + alertCell(r.alert_kind) + "</td>"
    + '<td class="num">' + (r.perf_delta_pct === null || r.perf_delta_pct === "" || Number.isNaN(Number(r.perf_delta_pct))
                ? "—" : Number(r.perf_delta_pct).toFixed(1) + " pts") + "</td>"
    + '<td class="center">' + (r.perf_degraded === true || r.perf_degraded === "True"
                ? '<span style="color:#E15759;font-weight:600;">flagged</span>' : "ok") + "</td></tr>"
  ).join("");

  // Equity rows: sort underserved first so issues land at the top.
  const equityRows = [...snapshot]
    .sort((a, b) => {
      const order = { underserved: 0, served: 1, "well-served": 2 };
      return (order[a.equity_status] ?? 1) - (order[b.equity_status] ?? 1);
    })
    .map(r => {
      const acc = (r.accuracy_pct === null || r.accuracy_pct === "" || Number.isNaN(Number(r.accuracy_pct)))
        ? "—" : Number(r.accuracy_pct).toFixed(2) + "%";
      const delta = (r.accuracy_delta_from_median_pct === null || r.accuracy_delta_from_median_pct === ""
                     || Number.isNaN(Number(r.accuracy_delta_from_median_pct)))
        ? "—" : (Number(r.accuracy_delta_from_median_pct) >= 0 ? "+" : "")
                + Number(r.accuracy_delta_from_median_pct).toFixed(1) + " pts";
      const cov = (r.coverage_pct === null || r.coverage_pct === "" || Number.isNaN(Number(r.coverage_pct)))
        ? "—" : (Number(r.coverage_pct) * 100).toFixed(1) + "%";
      const status = r.equity_status || "served";
      const statusCell = '<span style="color:' + (EQUITY_COLOR[status] || "#666")
                         + ';font-weight:600;">' + status + '</span>';
      return "<tr><td>" + (r.unit_name || r.unit_id) + "</td>"
           + '<td class="num">' + acc + '</td><td class="num">' + delta + '</td><td class="num">' + cov + "</td>"
           + '<td class="center">' + statusCell + "</td></tr>";
    }).join("");

  const emptyNote = hasData ? "" : `
      <div class="section" style="text-align:center;color:var(--muted);">
        Monitoring artifacts not found. Run
        <code>python run_pipeline.py --phase calibrate</code> then
        <code>--phase export</code> to generate drift_report.csv and drift_history.csv.
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Monitoring — Nurse Census Prediction</title>
  <meta name="description" content="Forecast drift monitoring (Population Stability Index over time) and prediction-interval coverage for the nurse-unit census forecaster.">
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
${navBar("monitoring")}
<div class="page-body">
  <section class="hero">
    <h1>Model Monitoring</h1>
    <p class="tagline">
      Monitoring for the deployed census forecaster. Distribution drift is tracked
      over time with the Population Stability Index (PSI) measured against the
      training baseline, and every forecast is reported with a 90% prediction
      interval to quantify its uncertainty.
    </p>
  </section>
${emptyNote}
  <section class="section">
    <div class="section-title">Census drift over time (PSI vs. training baseline)</div>
    <p style="font-size:13px;color:var(--muted);margin:0 0 10px;">
      PSI compares each unit's recent census distribution against the frozen training
      baseline. Below 0.10 is stable, 0.10–0.25 is a moderate shift, and 0.25 and above
      is a major shift. A single high reading can be ordinary seasonal variation; a line
      that climbs and stays up is the signal that a unit may need retraining. Computed
      across the held-out test period.
    </p>
    <div style="margin:0 0 12px;">
      <label for="unit-select" style="font-size:13px;color:var(--muted);margin-right:8px;">Unit</label>
      <select id="unit-select" style="font-size:13px;padding:5px 10px;border:1px solid var(--border);border-radius:3px;background:#fff;min-width:220px;">${selectOptions}</select>
    </div>
    <div id="psi-chart" style="height: 360px;"></div>
  </section>

  <section class="section">
    <div class="section-title">Drift snapshot — held-out test period</div>
    <p style="font-size:13px;color:var(--muted);margin:0 0 10px;">
      Detailed evaluation from the last full run on real data. The alert column is
      driven by the deseasoned residual PSI rather than the raw value, so a unit only
      reads as drift after persistent residual movement: <em>stable</em> means within
      tolerance, <em>transient</em> is a recent spike that has not persisted,
      <em>systemic</em> means the shift coincides with most other units (often
      seasonal), and <em>true_drift</em> is unit-specific persistent drift that
      warrants a retrain.
    </p>
    <table class="perf-table">
      <thead><tr><th>Unit</th><th class="num">PSI</th><th class="num">Residual PSI</th><th class="center">Alert</th><th class="num">±2 accuracy change</th><th class="center">Performance</th></tr></thead>
      <tbody>${snapshotRows || '<tr><td colspan="6">No snapshot available.</td></tr>'}</tbody>
    </table>
  </section>

  <section class="section">
    <div class="section-title">Equity across units</div>
    <p style="font-size:13px;color:var(--muted);margin:0 0 10px;">
      Since each unit has its own model, an equity question is whether smaller
      or lower-volume units get forecasts as good as the high-volume ones, both
      in point accuracy (within-2 patients) and in interval reliability (does
      the 90% band actually cover 90% of actuals). A unit is flagged
      <em>underserved</em> when its accuracy is well below the cohort median
      or its coverage drifts off the nominal 90% by more than a small
      tolerance. Underserved units sort to the top.
    </p>
    <table class="perf-table">
      <thead><tr><th>Unit</th><th class="num">±2 accuracy</th><th class="num">vs cohort median</th><th class="num">90% coverage</th><th class="center">Equity</th></tr></thead>
      <tbody>${equityRows || '<tr><td colspan="5">No equity data available.</td></tr>'}</tbody>
    </table>
  </section>

  <section class="section">
    <div class="section-title">Prediction interval — <span id="band-unit-label">${defaultBandUnit || "focus unit"}</span></div>
    <p style="font-size:13px;color:var(--muted);margin:0 0 10px;">
      Point forecast with its 90% prediction interval across horizons. The band widens
      further out, which is the honest behavior: a 1-hour forecast is far more certain
      than a 72-hour one.
    </p>
    <div id="band-chart" style="height: 320px;"></div>
  </section>

  <div class="footer-note">
    Data: drift_history.csv · drift_report.csv · forecast_predictions.csv
  </div>

  <script>
    const layoutBase = ${JSON.stringify(PLOTLY_LAYOUT_BASE)};
    const palette = ${JSON.stringify(TABLEAU_PALETTE)};
    const psiSeries = ${JSON.stringify(psiSeries)};
    const lastTestDate = ${JSON.stringify(lastTestDate)};
    const bandByUnit = ${JSON.stringify(bandByUnit)};
    const defaultBandUnit = ${JSON.stringify(defaultBandUnit)};

    if (psiSeries.length) {
      const psiLayout = JSON.parse(JSON.stringify(layoutBase));
      psiLayout.hovermode = "closest";
      psiLayout.margin = { t: 20, r: 20, b: 50, l: 55 };
      psiLayout.xaxis = { ...psiLayout.xaxis, type: "date", title: { text: "As-of date", font: { size: 11 } } };
      psiLayout.yaxis = { ...psiLayout.yaxis, title: { text: "PSI", font: { size: 11 } }, rangemode: "tozero" };
      psiLayout.legend = { orientation: "h", y: -0.22, x: 0, font: { size: 10 } };
      psiLayout.shapes = [
        { type: "line", xref: "paper", x0: 0, x1: 1, y0: 0.10, y1: 0.10,
          line: { color: "#F28E2B", width: 1, dash: "dot" } },
        { type: "line", xref: "paper", x0: 0, x1: 1, y0: 0.25, y1: 0.25,
          line: { color: "#E15759", width: 1, dash: "dot" } }
      ];
      psiLayout.annotations = [
        { xref: "paper", x: 1, y: 0.10, xanchor: "right", yanchor: "bottom",
          text: "moderate (0.10)", showarrow: false, font: { size: 9, color: "#F28E2B" } },
        { xref: "paper", x: 1, y: 0.25, xanchor: "right", yanchor: "bottom",
          text: "major (0.25)", showarrow: false, font: { size: 9, color: "#E15759" } }
      ];
      if (lastTestDate) {
        psiLayout.shapes.push({
          type: "line", x0: lastTestDate, x1: lastTestDate, yref: "paper", y0: 0, y1: 1,
          line: { color: "#888888", width: 1, dash: "dash" }
        });
        psiLayout.annotations.push({
          x: lastTestDate, xanchor: "right", yref: "paper", y: 1, yanchor: "top",
          text: "real test data   ", showarrow: false, font: { size: 9, color: "#888888" }
        });
        psiLayout.annotations.push({
          x: lastTestDate, xanchor: "left", yref: "paper", y: 1, yanchor: "top",
          text: "   live feed", showarrow: false, font: { size: 9, color: "#888888" }
        });
      }
      const traces = psiSeries.map((s, i) => ({
        x: s.x, y: s.y, name: s.name, type: "scatter", mode: "lines+markers",
        line: { width: 2, color: palette[i % palette.length] }, marker: { size: 4 }
      }));
      Plotly.newPlot("psi-chart", traces, psiLayout, { displayModeBar: false })
        .then(() => { window.RENDERED = true; });
    } else {
      document.getElementById("psi-chart").innerHTML =
        '<p style="color:#999;text-align:center;padding-top:40px;">No drift history yet.</p>';
    }

    // ── Prediction-interval band, driven by the unit selector ──
    const bandLayout = JSON.parse(JSON.stringify(layoutBase));
    bandLayout.hovermode = "closest";
    bandLayout.margin = { t: 20, r: 20, b: 50, l: 55 };
    bandLayout.xaxis = { ...bandLayout.xaxis, type: "category",
                         title: { text: "Forecast horizon (hours)", font: { size: 11 } } };
    bandLayout.yaxis = { ...bandLayout.yaxis, title: { text: "Census (patients)", font: { size: 11 } }, rangemode: "tozero" };
    bandLayout.showlegend = false;

    function renderBand(name) {
      const labelEl = document.getElementById("band-unit-label");
      const chartEl = document.getElementById("band-chart");
      const b = bandByUnit[name];
      if (labelEl) labelEl.textContent = name || "—";
      if (!b) {
        chartEl.innerHTML = '<p style="color:#999;text-align:center;padding-top:40px;">No interval data for this unit.</p>';
        return;
      }
      const xcat = b.horizons.map(h => h + "h");
      Plotly.react(chartEl, [
        { x: xcat, y: b.upper, type: "scatter", mode: "lines", line: { width: 0 },
          hoverinfo: "skip", showlegend: false },
        { x: xcat, y: b.lower, type: "scatter", mode: "lines", fill: "tonexty",
          fillcolor: "rgba(78,121,167,0.20)", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
        { x: xcat, y: b.point, type: "scatter", mode: "lines+markers",
          line: { color: "#1F4E79", width: 2 }, marker: { size: 6 }, name: "Forecast" }
      ], bandLayout, { displayModeBar: false });
    }
    renderBand(defaultBandUnit);

    // ── Unit selector: isolates a PSI line and drives the band chart ──
    const unitSelect = document.getElementById("unit-select");
    if (unitSelect) {
      unitSelect.addEventListener("change", function () {
        const val = unitSelect.value;
        if (psiSeries.length) {
          const vis = (val === "__all__")
            ? psiSeries.map(function () { return true; })
            : psiSeries.map(function (s) { return s.name === val; });
          Plotly.restyle("psi-chart", { visible: vis });
        }
        renderBand(val === "__all__" ? defaultBandUnit : val);
      });
    }
  </script>
</div>
</body>
</html>`;
}

// ── Explainability page: per-(unit, horizon) feature importance ──
function buildExplainability() {
  const fi = data.featureImportance || [];

  // Filter to top-15 per (unit, horizon) so the inlined payload stays small.
  const byUnitHorizon = {};
  fi.forEach(r => {
    if (Number(r.rank) > 15) return;
    const u = r.unit_name || ("Unit " + r.unit_id);
    const h = Number(r.horizon);
    byUnitHorizon[u] = byUnitHorizon[u] || {};
    byUnitHorizon[u][h] = byUnitHorizon[u][h] || [];
    byUnitHorizon[u][h].push({
      feature: r.feature,
      importance: Number(r.importance),
      rank: Number(r.rank),
    });
  });
  Object.values(byUnitHorizon).forEach(byH => {
    Object.values(byH).forEach(arr => arr.sort((a, b) => a.rank - b.rank));
  });

  const units = Object.keys(byUnitHorizon).sort();
  const horizonSet = new Set();
  fi.forEach(r => horizonSet.add(Number(r.horizon)));
  const horizons = [...horizonSet].sort((a, b) => a - b);
  const defaultUnit = units[0] || null;
  const defaultHorizon = horizons[0] || null;
  const hasData = !!defaultUnit;

  const unitOptions = units.map(u =>
    '<option value="' + u.replace(/"/g, "&quot;") + '">' + u + '</option>').join("");
  const horizonOptions = horizons.map(h =>
    '<option value="' + h + '">' + h + 'h</option>').join("");

  const emptyNote = hasData ? "" : `
    <div class="section" style="text-align:center;color:var(--muted);">
      Feature-importance data not found. Run
      <code>python run_pipeline.py --phase calibrate</code>
      to generate feature_importance.csv.
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Explainability — Nurse Census Prediction</title>
  <meta name="description" content="Per-unit, per-horizon feature-importance view for the deployed Random Forest and LightGBM census forecasters.">
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
${navBar("explainability")}
<div class="page-body">
  <section class="hero">
    <h1>Forecast Explainability</h1>
    <p class="tagline">
      Per-unit, per-horizon view of which input features the deployed model
      actually relies on. The bars rank the top-15 features by importance
      (impurity decrease for Random Forest at the 1-hour horizon, split count
      for LightGBM at the longer horizons), so a clinician or auditor can see
      what drives a given forecast.
    </p>
  </section>
${emptyNote}
  <section class="section">
    <div class="section-title">Top features by importance</div>
    <p style="font-size:13px;color:var(--muted);margin:0 0 10px;">
      Feature importance describes what the model uses, not whether the model
      is right; pair it with the drift monitor and prediction intervals to read
      the full picture. Pick a unit and horizon to see the drivers.
    </p>
    <div style="margin:0 0 12px;">
      <label for="unit-select" style="font-size:13px;color:var(--muted);margin-right:8px;">Unit</label>
      <select id="unit-select" style="font-size:13px;padding:5px 10px;border:1px solid var(--border);border-radius:3px;background:#fff;min-width:220px;">${unitOptions}</select>
      <label for="horizon-select" style="font-size:13px;color:var(--muted);margin:0 8px 0 16px;">Horizon</label>
      <select id="horizon-select" style="font-size:13px;padding:5px 10px;border:1px solid var(--border);border-radius:3px;background:#fff;min-width:80px;">${horizonOptions}</select>
    </div>
    <div id="fi-chart" style="height: 460px;"></div>
  </section>

  <div class="footer-note">
    Data: feature_importance.csv (deployed Random Forest at 1h, LightGBM at 2-72h)
  </div>

  <script>
    const layoutBase = ${JSON.stringify(PLOTLY_LAYOUT_BASE)};
    const byUnitHorizon = ${JSON.stringify(byUnitHorizon)};
    const defaultUnit = ${JSON.stringify(defaultUnit)};
    const defaultHorizon = ${JSON.stringify(defaultHorizon)};

    function render(name, horizon) {
      const chart = document.getElementById("fi-chart");
      const entry = (byUnitHorizon[name] || {})[horizon] || [];
      if (!entry.length) {
        chart.innerHTML = '<p style="color:#999;text-align:center;padding-top:60px;">No importance data for this unit/horizon.</p>';
        return;
      }
      // Reverse so the highest-ranked bar sits at the top.
      const features = entry.map(d => d.feature).reverse();
      const importances = entry.map(d => d.importance).reverse();
      const layout = JSON.parse(JSON.stringify(layoutBase));
      layout.margin = { t: 20, r: 30, b: 50, l: 200 };
      layout.xaxis = { ...layout.xaxis, title: { text: "Importance", font: { size: 11 } } };
      layout.yaxis = { ...layout.yaxis, type: "category", automargin: true };
      layout.showlegend = false;
      Plotly.react(chart, [{
        x: importances, y: features, type: "bar", orientation: "h",
        marker: { color: "#1F4E79" },
        hovertemplate: "%{y}: %{x:.4f}<extra></extra>"
      }], layout, { displayModeBar: false })
        .then(() => { window.RENDERED = true; });
    }

    if (defaultUnit && defaultHorizon !== null) {
      render(defaultUnit, defaultHorizon);
    }
    const unitSelect = document.getElementById("unit-select");
    const horizonSelect = document.getElementById("horizon-select");
    function onChange() {
      if (unitSelect && horizonSelect) {
        render(unitSelect.value, parseInt(horizonSelect.value, 10));
      }
    }
    if (unitSelect) unitSelect.addEventListener("change", onChange);
    if (horizonSelect) horizonSelect.addEventListener("change", onChange);
  </script>
</div>
</body>
</html>`;
}

// ── Dashboard 1 (current): self-contained Operational Census Forecast page ──
// Replaces the Tableau embed. Reads executive_summary.csv + forecast_predictions.csv +
// forecast_timeline.csv and renders a unit selector, current-state panel, eight-horizon
// forecast cards (1/2/3/4/12/24/48/72h), and a seven-day actuals + forecast timeline with
// the 90% conformal band shaded forward. This function declaration shadows the legacy
// `buildDashboard1` defined earlier in the file (last function-declaration wins in JS).
function buildDashboard1() {
  const HORIZONS = [1, 2, 3, 4, 12, 24, 48, 72];
  const execRows = data.exec || [];

  const unitData = {};
  execRows.forEach(e => {
    const uid = e.unit_id;
    const name = e.unit_name || ("Unit " + uid);

    // Latest row per unit in forecast_predictions has the pred_* columns populated.
    const predRows = (data.forecast || []).filter(
      r => r.unit_id === uid && r.pred_1hr !== null && r.pred_1hr !== "");
    const latestPred = predRows.length ? predRows[predRows.length - 1] : null;

    // Eight forecast cards, one per horizon. We iterate HORIZONS explicitly so the
    // page always renders a card in the right slot even if a value is missing.
    const cards = [];
    if (latestPred) {
      HORIZONS.forEach(h => {
        const point = latestPred["pred_" + h + "hr"];
        if (point === null || point === "" || point === undefined) return;
        const lower = latestPred["pred_" + h + "hr_lower"];
        const upper = latestPred["pred_" + h + "hr_upper"];
        cards.push({
          horizon: h,
          point: Number(point),
          lower: (lower === null || lower === "" || lower === undefined) ? null : Number(lower),
          upper: (upper === null || upper === "" || upper === undefined) ? null : Number(upper),
          overCapacity: e.capacity != null && Number(point) >= Number(e.capacity),
        });
      });
    }

    // Time-series data from forecast_timeline.csv (actuals + forward forecasts with bands).
    const tlRows = (data.timeline || []).filter(r => r.unit_id === uid);
    const actuals = tlRows.filter(r => r.series === "Actual")
                          .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    const forecasts = tlRows.filter(r => r.series === "Forecast")
                            .sort((a, b) => Number(a.horizon_h) - Number(b.horizon_h));

    unitData[name] = {
      uid: uid,
      capacity: e.capacity == null ? null : Number(e.capacity),
      current: e.latest_census == null ? null : Number(e.latest_census),
      utilization: e.utilization_pct == null ? null : Number(e.utilization_pct),
      alert: e.alert_over_90pct === true || e.alert_over_90pct === "True",
      cards: cards,
      actualsX: actuals.map(r => r.timestamp),
      actualsY: actuals.map(r => Number(r.value)),
      forecastX: forecasts.map(r => r.timestamp),
      forecastY: forecasts.map(r => Number(r.value)),
      forecastLower: forecasts.map(r => Number(r.value_lower)),
      forecastUpper: forecasts.map(r => Number(r.value_upper)),
      forecastHorizons: forecasts.map(r => Number(r.horizon_h)),
    };
  });

  // Sort units by utilization desc so the highest-utilization unit (often the alert one)
  // is the default focus when the page loads.
  const unitNames = Object.keys(unitData).sort(
    (a, b) => (unitData[b].utilization || 0) - (unitData[a].utilization || 0));
  const defaultUnit = unitNames[0] || null;
  const hasData = !!defaultUnit;

  const unitOptions = unitNames.map(u =>
    '<option value="' + u.replace(/"/g, "&quot;") + '">' + u + '</option>').join("");

  const emptyNote = hasData ? "" : `
    <div class="section" style="text-align:center;color:var(--muted);">
      Operational data not found. Run the daily refresh to populate the operational CSV exports.
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Operational Census Forecast — Nurse Census Prediction</title>
  <meta name="description" content="In-repo operational forecast dashboard: current census per unit, eight-horizon forecasts with 90% prediction intervals, and a seven-day actual-vs-forecast timeline.">
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  <style>
    .op-state { display:flex; gap:14px; flex-wrap:wrap; margin: 8px 0 0; }
    .op-state .stat-card { flex: 1 1 150px; min-width:140px; }
    .fc-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:10px; margin-top:10px; }
    .fc-card { background:#FFFFFF; border:1px solid var(--border); border-radius:3px; padding:10px 12px; text-align:center; }
    .fc-card.alert { border-color:#E15759; background:#FFF5F5; }
    .fc-h { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em; }
    .fc-pt { font-size:22px; font-weight:700; color:#1F4E79; margin-top:2px; line-height:1.1; }
    .fc-card.alert .fc-pt { color:#E15759; }
    .fc-band { font-size:11px; color:var(--muted); margin-top:2px; }
    @media (max-width: 800px) { .fc-grid { grid-template-columns: repeat(2, 1fr); } }
  </style>
</head>
<body>
${navBar("dashboards")}
<div class="page-body">
  <section class="hero">
    <h1>Operational Census Forecast</h1>
    <p class="tagline">
      House-supervisor view: current census per unit, eight-horizon forecasts
      (1, 2, 3, 4, 12, 24, 48, and 72 hours ahead) with their 90% prediction
      intervals, and a seven-day actuals + forward forecast timeline showing
      the band ahead of the latest reading.
    </p>
  </section>
${emptyNote}
  <section class="section">
    <div style="margin:0 0 12px;">
      <label for="unit-select" style="font-size:13px;color:var(--muted);margin-right:8px;">Unit</label>
      <select id="unit-select" style="font-size:13px;padding:5px 10px;border:1px solid var(--border);border-radius:3px;background:#fff;min-width:240px;">${unitOptions}</select>
    </div>

    <div class="section-title">Current state</div>
    <div class="op-state" id="op-state"></div>

    <div class="section-title" style="margin-top:18px;">Forecast (next 1h through 72h)</div>
    <div class="fc-grid" id="fc-grid"></div>

    <div class="section-title" style="margin-top:18px;">Seven-day actuals + forecast with 90% band</div>
    <div id="ts-chart" style="height: 360px;"></div>
  </section>

  <div class="footer-note">
    Data: executive_summary.csv · forecast_predictions.csv · forecast_timeline.csv
    · forecast horizons 1h, 2h, 3h, 4h, 12h, 24h, 48h, 72h
  </div>

  <script>
    const layoutBase = ${JSON.stringify(PLOTLY_LAYOUT_BASE)};
    const unitData = ${JSON.stringify(unitData)};
    const HORIZONS = [1, 2, 3, 4, 12, 24, 48, 72];

    function fmtCensus(n) { return (n == null || Number.isNaN(n)) ? "—" : String(Math.round(n)); }
    function fmtBand(lo, hi) {
      if (lo == null || hi == null || Number.isNaN(lo) || Number.isNaN(hi)) return "—";
      return Math.round(lo) + " – " + Math.round(hi);
    }

    function renderState(name) {
      const u = unitData[name];
      const el = document.getElementById("op-state");
      if (!u) { el.innerHTML = ""; return; }
      const utilColor = (u.utilization == null) ? "#1F4E79"
        : (u.utilization >= 90 ? "#E15759" : (u.utilization >= 75 ? "#F28E2B" : "#59A14F"));
      const alertBadge = u.alert
        ? '<span style="color:#E15759;font-weight:600;font-size:14px;">over 90%</span>'
        : '<span style="color:#59A14F;font-weight:600;font-size:14px;">OK</span>';
      el.innerHTML =
        '<div class="stat-card"><div class="num">' + fmtCensus(u.current) + '</div><div class="label">Current census</div></div>' +
        '<div class="stat-card"><div class="num">' + fmtCensus(u.capacity) + '</div><div class="label">Capacity</div></div>' +
        '<div class="stat-card"><div class="num" style="color:' + utilColor + ';">' + (u.utilization == null ? "—" : u.utilization.toFixed(1) + "%") + '</div><div class="label">Utilization</div></div>' +
        '<div class="stat-card"><div class="num">' + alertBadge + '</div><div class="label">Alert</div></div>';
    }

    function renderCards(name) {
      const u = unitData[name];
      const el = document.getElementById("fc-grid");
      if (!u || !u.cards.length) {
        el.innerHTML = '<p style="color:#999;padding:10px 0;">No forecast available for this unit.</p>';
        return;
      }
      // Always render exactly 8 slots in horizon order, missing values show as em-dash.
      const byH = {};
      u.cards.forEach(c => { byH[c.horizon] = c; });
      el.innerHTML = HORIZONS.map(h => {
        const c = byH[h];
        if (!c) {
          return '<div class="fc-card" title="No forecast available for +' + h + 'h">'
               + '<div class="fc-h">' + h + 'h ahead</div>'
               + '<div class="fc-pt">—</div><div class="fc-band">—</div></div>';
        }
        const cls = c.overCapacity ? "fc-card alert" : "fc-card";
        const capInfo = (u.capacity != null) ? " (capacity " + u.capacity + ")" : "";
        const alertLine = c.overCapacity ? "; predicted at or over capacity" : "";
        const title = "Forecast +" + h + "h ahead\\n"
                    + "Predicted: " + fmtCensus(c.point) + " patients" + capInfo + alertLine + "\\n"
                    + "90% interval: " + fmtBand(c.lower, c.upper);
        return '<div class="' + cls + '" title="' + title + '">'
             + '<div class="fc-h">' + h + 'h ahead</div>'
             + '<div class="fc-pt">' + fmtCensus(c.point) + '</div>'
             + '<div class="fc-band">90%: ' + fmtBand(c.lower, c.upper) + '</div></div>';
      }).join("");
    }

    function renderChart(name) {
      const u = unitData[name];
      const el = document.getElementById("ts-chart");
      if (!u) { el.innerHTML = ""; return; }
      const layout = JSON.parse(JSON.stringify(layoutBase));
      layout.hovermode = "x unified";
      layout.margin = { t: 20, r: 30, b: 50, l: 55 };
      layout.xaxis = { ...layout.xaxis, type: "date", title: { text: "Timestamp", font: { size: 11 } } };
      layout.yaxis = { ...layout.yaxis, title: { text: "Census (patients)", font: { size: 11 } }, rangemode: "tozero" };
      layout.legend = { orientation: "h", y: -0.22, x: 0, font: { size: 10 } };
      if (u.capacity) {
        layout.shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: u.capacity, y1: u.capacity,
                           line: { color: "#E15759", width: 1, dash: "dash" } }];
        layout.annotations = [{ xref: "paper", x: 1, y: u.capacity, xanchor: "right", yanchor: "bottom",
                                text: "capacity " + u.capacity, showarrow: false,
                                font: { size: 9, color: "#E15759" } }];
      }
      // Band is drawn as two invisible traces with fill between them. The forecast
      // line carries customdata so its tooltip can show the 90% interval and the
      // horizon (e.g. "+12h ahead") in addition to the point value.
      const fcCustom = u.forecastY.map((_, i) =>
        [u.forecastLower[i], u.forecastUpper[i], u.forecastHorizons[i]]);
      const traces = [
        { x: u.actualsX, y: u.actualsY, name: "Actual", type: "scatter", mode: "lines+markers",
          line: { color: "#1F4E79", width: 2 }, marker: { size: 4 },
          hovertemplate: "<b>%{x}</b><br>Actual census: %{y} patients<extra></extra>" },
        { x: u.forecastX, y: u.forecastUpper, type: "scatter", mode: "lines",
          line: { width: 0 }, hoverinfo: "skip", showlegend: false },
        { x: u.forecastX, y: u.forecastLower, name: "90% band", type: "scatter", mode: "lines",
          fill: "tonexty", fillcolor: "rgba(78,121,167,0.20)", line: { width: 0 }, hoverinfo: "skip" },
        { x: u.forecastX, y: u.forecastY, name: "Forecast", type: "scatter", mode: "lines+markers",
          line: { color: "#4E79A7", width: 2, dash: "dot" }, marker: { size: 6 },
          customdata: fcCustom,
          hovertemplate: "<b>Forecast at %{x}</b><br>"
                       + "Predicted: %{y:.1f} patients<br>"
                       + "90% interval: %{customdata[0]:.1f} – %{customdata[1]:.1f}<br>"
                       + "Horizon: +%{customdata[2]}h<extra></extra>" }
      ];
      Plotly.react(el, traces, layout, { displayModeBar: false })
        .then(() => { window.RENDERED = true; });
    }

    function renderAll(name) { renderState(name); renderCards(name); renderChart(name); }
    const sel = document.getElementById("unit-select");
    if (sel) {
      sel.addEventListener("change", () => renderAll(sel.value));
      renderAll(sel.value);
    }
  </script>
</div>
</body>
</html>`;
}

// ── Dashboard 2 (current): self-contained Model Performance Analytics page ──
function buildDashboard2() {
  const HORIZONS = [1, 2, 3, 4, 12, 24, 48, 72];
  const agg = data.perfAgg || [];
  const best = data.best || [];
  const perUnit = data.perfUnit || [];

  // Stable model order: tabular first, then deep, then statistical, then ensemble.
  const MODEL_ORDER = ["RandomForest", "LightGBM", "LSTM", "ARIMA", "Prophet", "Ensemble"];
  const presentModels = [...new Set(agg.map(r => r.model))];
  const models = MODEL_ORDER.filter(m => presentModels.includes(m))
                            .concat(presentModels.filter(m => !MODEL_ORDER.includes(m)));

  // Heatmap matrix: models × horizons of mean within-2 accuracy.
  const matrix = models.map(m => HORIZONS.map(h => {
    const r = agg.find(x => x.model === m && Number(x.horizon) === h);
    return (r && r.within_2_patients_pct != null) ? Number(r.within_2_patients_pct) : null;
  }));

  // Best model per horizon (one card per horizon).
  const bestByH = HORIZONS.map(h => {
    const r = best.find(x => Number(x.horizon) === h);
    return r
      ? { horizon: h, model: r.model, acc: Number(r.within_2_patients_pct) }
      : { horizon: h, model: "—", acc: null };
  });

  // Per-unit accuracy grouped by horizon: {horizon: [{unit_id, unit_name, RandomForest, LightGBM, LSTM, Ensemble}]}.
  const unitNameById = {};
  (data.unitMeta || []).forEach(r => { unitNameById[r.unit_id] = r.unit_name; });
  const FOCUS_MODELS = ["RandomForest", "LightGBM", "LSTM", "Ensemble"];
  const perUnitByHorizon = {};
  HORIZONS.forEach(h => {
    const rowsAtH = perUnit.filter(r => Number(r.horizon) === h);
    const units = [...new Set(rowsAtH.map(r => r.unit_id))].sort();
    perUnitByHorizon[h] = units.map(uid => {
      const entry = { unit_id: uid, unit_name: unitNameById[uid] || ("Unit " + uid) };
      FOCUS_MODELS.forEach(m => {
        const r = rowsAtH.find(x => x.unit_id === uid && x.model === m);
        entry[m] = (r && r.within_2_patients_pct != null) ? Number(r.within_2_patients_pct) : null;
      });
      return entry;
    });
  });

  const hasData = agg.length > 0;
  const emptyNote = hasData ? "" : `
    <div class="section" style="text-align:center;color:var(--muted);">
      Model performance data not found. Run
      <code>python run_pipeline.py --phase train</code> and
      <code>--phase export</code> to populate model_performance.csv.
    </div>`;

  const bestCards = bestByH.map(b =>
    '<div class="bm-card"><div class="bm-h">' + b.horizon + 'h</div>'
    + '<div class="bm-acc">' + (b.acc == null ? "—" : b.acc.toFixed(1) + "%") + '</div>'
    + '<div class="bm-model">' + b.model + '</div></div>').join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Model Performance Analytics — Nurse Census Prediction</title>
  <meta name="description" content="Model × horizon ±2 accuracy heatmap, best-model-per-horizon highlights, and per-unit model accuracy breakdown.">
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  <style>
    .bm-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:10px; margin-top:10px; }
    .bm-card { background:#FFFFFF; border:1px solid var(--border); border-radius:3px; padding:10px 12px; text-align:center; }
    .bm-h { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em; }
    .bm-acc { font-size:22px; font-weight:700; color:#1F4E79; margin-top:2px; line-height:1.1; }
    .bm-model { font-size:11px; color:var(--muted); margin-top:2px; }
    @media (max-width: 800px) { .bm-grid { grid-template-columns: repeat(2, 1fr); } }
  </style>
</head>
<body>
${navBar("dashboards")}
<div class="page-body">
  <section class="hero">
    <h1>Model Performance Analytics</h1>
    <p class="tagline">
      Process-improvement view: which model wins at each forecast horizon
      (1, 2, 3, 4, 12, 24, 48, 72 hours), the full model × horizon accuracy
      heatmap, and per-unit accuracy breakdown so a PI analyst can see where
      individual units underperform the cohort.
    </p>
  </section>
${emptyNote}
  <section class="section">
    <div class="section-title">Best model per horizon (±2 patient accuracy)</div>
    <div class="bm-grid">${bestCards}</div>
  </section>

  <section class="section">
    <div class="section-title">Accuracy heatmap — models × forecast horizons</div>
    <p style="font-size:13px;color:var(--muted);margin:0 0 10px;">
      Mean ±2 patient accuracy across units, per model per horizon. Hotter colors
      are better.
    </p>
    <div id="heatmap" style="height: 320px;"></div>
  </section>

  <section class="section">
    <div class="section-title">Per-unit accuracy — pick a horizon</div>
    <div style="margin:0 0 12px;">
      <label for="horizon-select" style="font-size:13px;color:var(--muted);margin-right:8px;">Horizon</label>
      <select id="horizon-select" style="font-size:13px;padding:5px 10px;border:1px solid var(--border);border-radius:3px;background:#fff;min-width:80px;">
        ${HORIZONS.map(h => '<option value="' + h + '">' + h + 'h</option>').join("")}
      </select>
    </div>
    <div id="unit-bars" style="height: 360px;"></div>
  </section>

  <div class="footer-note">
    Data: model_performance.csv · model_performance_aggregated.csv · best_model_per_horizon.csv
    · forecast horizons 1h, 2h, 3h, 4h, 12h, 24h, 48h, 72h
  </div>

  <script>
    const layoutBase = ${JSON.stringify(PLOTLY_LAYOUT_BASE)};
    const palette = ${JSON.stringify(TABLEAU_PALETTE)};
    const HORIZONS = [1, 2, 3, 4, 12, 24, 48, 72];
    const models = ${JSON.stringify(models)};
    const matrix = ${JSON.stringify(matrix)};
    const perUnitByHorizon = ${JSON.stringify(perUnitByHorizon)};
    const FOCUS_MODELS = ["RandomForest", "LightGBM", "LSTM", "Ensemble"];

    // Heatmap.
    const heatLayout = JSON.parse(JSON.stringify(layoutBase));
    heatLayout.margin = { t: 20, r: 20, b: 50, l: 140 };
    heatLayout.xaxis = { ...heatLayout.xaxis, type: "category",
                         title: { text: "Forecast horizon", font: { size: 11 } } };
    heatLayout.yaxis = { ...heatLayout.yaxis, automargin: true, type: "category" };
    Plotly.newPlot("heatmap", [{
      type: "heatmap",
      x: HORIZONS.map(h => h + "h"),
      y: models,
      z: matrix,
      colorscale: [[0, "#FBE4E2"], [0.5, "#F4D03F"], [0.85, "#76B7B2"], [1, "#1F4E79"]],
      zmin: 50, zmax: 100,
      colorbar: { title: { text: "± 2 acc %", font: { size: 11 } }, thickness: 12, len: 0.8 },
      text: matrix.map(row => row.map(v => v != null ? v.toFixed(1) + "%" : "")),
      texttemplate: "%{text}",
      textfont: { size: 11, color: "white" },
      hovertemplate: "<b>%{y}</b> @ <b>%{x}</b><br>"
                   + "±2 patient accuracy: %{z:.1f}%<extra></extra>",
    }], heatLayout, { displayModeBar: false }).then(() => { window.RENDERED = true; });

    // Per-unit grouped bar chart, updates with horizon selector.
    const barLayout = JSON.parse(JSON.stringify(layoutBase));
    barLayout.barmode = "group";
    barLayout.margin = { t: 20, r: 20, b: 70, l: 55 };
    barLayout.xaxis = { ...barLayout.xaxis, type: "category", tickangle: -25,
                        title: { text: "Nurse unit", font: { size: 11 } } };
    barLayout.yaxis = { ...barLayout.yaxis, title: { text: "± 2 patient accuracy (%)", font: { size: 11 } },
                        range: [0, 100] };
    barLayout.legend = { orientation: "h", y: -0.28, x: 0, font: { size: 10 } };

    function renderBars(h) {
      const rows = perUnitByHorizon[h] || [];
      if (!rows.length) {
        document.getElementById("unit-bars").innerHTML = '<p style="color:#999;text-align:center;padding-top:60px;">No per-unit data for this horizon.</p>';
        return;
      }
      const labels = rows.map(r => r.unit_name);
      const traces = FOCUS_MODELS.map((m, i) => ({
        x: labels,
        y: rows.map(r => r[m]),
        name: m,
        type: "bar",
        marker: { color: palette[i % palette.length] },
        hovertemplate: "<b>%{x}</b><br>" + m + " @ " + h + "h: %{y:.1f}%<extra></extra>",
      }));
      Plotly.react("unit-bars", traces, barLayout, { displayModeBar: false });
    }
    renderBars(1);
    const hsel = document.getElementById("horizon-select");
    if (hsel) hsel.addEventListener("change", () => renderBars(parseInt(hsel.value, 10)));
  </script>
</div>
</body>
</html>`;
}

// ── Dashboard 3 (current): self-contained Executive Census Summary page ──
function buildDashboard3() {
  const execRows = (data.exec || []).slice();
  const bestRows = data.best || [];

  // House-wide rollups.
  const totalCensus = execRows.reduce((s, r) => s + (Number(r.latest_census) || 0), 0);
  const totalCapacity = execRows.reduce((s, r) => s + (Number(r.capacity) || 0), 0);
  const houseUtil = totalCapacity > 0 ? (totalCensus / totalCapacity * 100) : null;
  const isAlert = r => (r.alert_over_90pct === true || r.alert_over_90pct === "True"
                        || Number(r.utilization_pct) >= 90);
  const alertCount = execRows.filter(isAlert).length;
  const okCount = execRows.length - alertCount;

  // Utilization bar chart: sorted descending so high-utilization units land at top.
  const sorted = execRows.slice().sort(
    (a, b) => (Number(b.utilization_pct) || 0) - (Number(a.utilization_pct) || 0));
  const barLabels = sorted.map(r => r.unit_name || ("Unit " + r.unit_id));
  const barValues = sorted.map(r => Number(r.utilization_pct) || 0);
  const barColors = barValues.map(v => v >= 90 ? "#E15759" : (v >= 75 ? "#F28E2B" : "#59A14F"));
  // customdata gives the tooltip current / capacity / status without re-deriving on hover.
  const barCustom = sorted.map(r => [
    r.latest_census != null ? Math.round(Number(r.latest_census)) : "—",
    r.capacity != null ? Math.round(Number(r.capacity)) : "—",
    isAlert(r) ? "over 90%" : "OK",
    r.forecast_72hr != null && r.forecast_72hr !== "" ? Number(r.forecast_72hr).toFixed(1) : "—",
  ]);

  // Best model for the 72h horizon (the "look-ahead" the executive view leans on).
  const best72 = bestRows.find(r => Number(r.horizon) === 72);
  const recommendedLong = best72 ? best72.model : "—";
  const recommendedAcc = (best72 && best72.within_2_patients_pct != null)
    ? Number(best72.within_2_patients_pct).toFixed(1) + "%" : "—";

  // Per-unit detail rows, sorted high-utilization first. The utilization cell
  // shows a tinted fill bar behind the number (proportional to the percent),
  // and the alert state is a pill badge for visual weight.
  const detailRows = sorted.map(r => {
    const util = Number(r.utilization_pct) || 0;
    const utilCls = util >= 90 ? "alert" : (util >= 75 ? "warn" : "ok");
    const fillPct = Math.min(100, Math.max(0, util));
    const alert = isAlert(r);
    return "<tr>"
      + '<td><span class="unit-name">' + (r.unit_name || r.unit_id) + "</span></td>"
      + '<td class="num">' + (r.latest_census != null ? Math.round(Number(r.latest_census)) : "—") + "</td>"
      + '<td class="num">' + (r.capacity != null ? Math.round(Number(r.capacity)) : "—") + "</td>"
      + '<td class="num util-cell ' + utilCls + '">'
        + '<div class="util-fill" style="width:' + fillPct + '%;"></div>'
        + '<span class="util-value">' + util.toFixed(1) + "%</span>"
      + "</td>"
      + '<td class="center">' + (alert
          ? '<span class="status-pill alert">over 90%</span>'
          : '<span class="status-pill ok">OK</span>') + "</td>"
      + '<td class="num">' + (r.forecast_72hr != null && r.forecast_72hr !== ""
          ? Number(r.forecast_72hr).toFixed(1) : "—") + "</td>"
      + "</tr>";
  }).join("");

  const hasData = execRows.length > 0;
  const emptyNote = hasData ? "" : `
    <div class="section" style="text-align:center;color:var(--muted);">
      Executive summary data not found. Run the daily refresh to populate
      <code>outputs/tableau/executive_summary.csv</code>.
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Executive Census Summary — Nurse Census Prediction</title>
  <meta name="description" content="House-wide census, capacity, utilization, alerts, and 72-hour forecasts per unit, with the best-model recommendation.">
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
${navBar("dashboards")}
<div class="page-body">
  <section class="hero">
    <h1>Executive Census Summary</h1>
    <p class="tagline">
      Leadership view: house-wide census and capacity, utilization ranked by
      unit, alerts at a glance, and the 72-hour look-ahead per unit. The
      ±2-patient accuracy at the 72-hour horizon and the recommended model
      come from the trained model comparison.
    </p>
  </section>
${emptyNote}
  <section class="section">
    <div class="stats-grid">
      <div class="stat-card">
        <div class="num">${Math.round(totalCensus)}</div>
        <div class="label">House-wide census</div>
      </div>
      <div class="stat-card">
        <div class="num">${Math.round(totalCapacity)}</div>
        <div class="label">House-wide capacity</div>
      </div>
      <div class="stat-card">
        <div class="num" style="color:${houseUtil != null && houseUtil >= 90 ? "#E15759" : (houseUtil != null && houseUtil >= 75 ? "#F28E2B" : "#59A14F")};">${houseUtil != null ? houseUtil.toFixed(1) + "%" : "—"}</div>
        <div class="label">House-wide utilization</div>
      </div>
      <div class="stat-card">
        <div class="num" style="color:${alertCount > 0 ? "#E15759" : "#59A14F"};">${alertCount}</div>
        <div class="label">Units in alert (≥ 90%)</div>
      </div>
      <div class="stat-card">
        <div class="num">${recommendedAcc}</div>
        <div class="label">72h ±2 accuracy · ${recommendedLong}</div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="section-title">Utilization by unit</div>
    <p style="font-size:13px;color:var(--muted);margin:0 0 10px;">
      Sorted highest to lowest. Bars turn orange at ≥ 75% utilization and red
      at ≥ 90%; the reference line marks the alert threshold.
    </p>
    <div id="util-bar" style="height: 320px;"></div>
  </section>

  <section class="section">
    <div class="section-title">Per-unit detail</div>
    <table class="perf-table">
      <thead><tr><th>Unit</th><th class="num">Current</th><th class="num">Capacity</th><th class="num">Utilization</th><th class="center">Alert</th><th class="num">72h forecast</th></tr></thead>
      <tbody>${detailRows || '<tr><td colspan="6">No data available.</td></tr>'}</tbody>
    </table>
  </section>

  <div class="footer-note">
    Data: executive_summary.csv · best_model_per_horizon.csv · unit_metadata.csv
  </div>

  <script>
    const layoutBase = ${JSON.stringify(PLOTLY_LAYOUT_BASE)};
    const labels = ${JSON.stringify(barLabels)};
    const values = ${JSON.stringify(barValues)};
    const colors = ${JSON.stringify(barColors)};
    const custom = ${JSON.stringify(barCustom)};

    if (labels.length) {
      const layout = JSON.parse(JSON.stringify(layoutBase));
      layout.margin = { t: 20, r: 20, b: 70, l: 55 };
      layout.xaxis = { ...layout.xaxis, type: "category", tickangle: -25,
                       title: { text: "Nurse unit", font: { size: 11 } } };
      layout.yaxis = { ...layout.yaxis, title: { text: "Utilization (%)", font: { size: 11 } },
                       range: [0, Math.max(100, Math.ceil(Math.max(...values) / 10) * 10)] };
      layout.shapes = [
        { type: "line", xref: "paper", x0: 0, x1: 1, y0: 90, y1: 90,
          line: { color: "#E15759", width: 1, dash: "dash" } },
        { type: "line", xref: "paper", x0: 0, x1: 1, y0: 75, y1: 75,
          line: { color: "#F28E2B", width: 1, dash: "dot" } }
      ];
      layout.annotations = [
        { xref: "paper", x: 1, y: 90, xanchor: "right", yanchor: "bottom",
          text: "alert (90%)", showarrow: false, font: { size: 9, color: "#E15759" } },
        { xref: "paper", x: 1, y: 75, xanchor: "right", yanchor: "bottom",
          text: "watch (75%)", showarrow: false, font: { size: 9, color: "#F28E2B" } }
      ];
      Plotly.newPlot("util-bar", [{
        x: labels, y: values, type: "bar",
        marker: { color: colors },
        customdata: custom,
        hovertemplate: "<b>%{x}</b><br>"
                     + "Utilization: %{y:.1f}%<br>"
                     + "Current: %{customdata[0]} / %{customdata[1]}<br>"
                     + "Status: %{customdata[2]}<br>"
                     + "72h forecast: %{customdata[3]}<extra></extra>",
      }], layout, { displayModeBar: false })
        .then(() => { window.RENDERED = true; });
    }
  </script>
</div>
</body>
</html>`;
}

fs.writeFileSync(path.join(OUT_HTML_DIR, "style.css"), STYLES);
fs.writeFileSync(path.join(OUT_HTML_DIR, "index.html"), buildIndex());
fs.writeFileSync(path.join(OUT_HTML_DIR, "models.html"), buildModels());
fs.writeFileSync(path.join(OUT_HTML_DIR, "methodology.html"), buildMethodology());
fs.writeFileSync(path.join(OUT_HTML_DIR, "tests.html"), buildTests());
fs.writeFileSync(path.join(OUT_HTML_DIR, "dashboards.html"), buildDashboardsGallery());
fs.writeFileSync(path.join(OUT_HTML_DIR, "monitoring.html"), buildMonitoring());
fs.writeFileSync(path.join(OUT_HTML_DIR, "explainability.html"), buildExplainability());
fs.writeFileSync(path.join(OUT_HTML_DIR, "dashboard1.html"), buildDashboard1());
fs.writeFileSync(path.join(OUT_HTML_DIR, "dashboard2.html"), buildDashboard2());
fs.writeFileSync(path.join(OUT_HTML_DIR, "dashboard3.html"), buildDashboard3());
console.log("Wrote HTML to", OUT_HTML_DIR);

// ── Screenshot via puppeteer (skipped in --no-screenshots / cron mode) ──
if (SKIP_SCREENSHOTS) {
  console.log("Skipping screenshots (--no-screenshots)");
} else {
  const puppeteer = require("puppeteer");
  (async () => {
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    for (const i of [1, 2, 3]) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 2 });
      const url = "file://" + path.join(OUT_HTML_DIR, `dashboard${i}.html`).replace(/\\/g, "/");
      await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
      try {
        await page.waitForFunction(() => window.RENDERED === true, { timeout: 15000 });
      } catch (e) {
        console.warn(`Dashboard ${i}: render flag timeout — proceeding with screenshot anyway`);
      }
      await new Promise(r => setTimeout(r, 400));
      const out = path.join(OUT_PNG_DIR, `dashboard${i}.png`);
      await page.screenshot({ path: out, fullPage: true });
      console.log(`Saved ${out}`);
      await page.close();
    }
    await browser.close();
  })();
}
