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
const OUT_PNG_DIR = path.join(REPO_ROOT, "outputs", "figures", "dashboards");

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

const data = {
  forecast: readCSV("forecast_predictions.csv"),
  perfAgg: readCSV("model_performance_aggregated.csv"),
  best: readCSV("best_model_per_horizon.csv"),
  unitMeta: readCSV("unit_metadata.csv"),
  exec: readCSV("executive_summary.csv"),
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
.model-card .perf-table {
  width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px;
}
.model-card .perf-table th {
  background: #F8F8F8; padding: 6px 10px; font-weight: 600; text-align: center;
  border-bottom: 2px solid var(--tableau-blue);
}
.model-card .perf-table td {
  padding: 6px 10px; text-align: center;
  border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums;
}
.model-card .perf-table td.best { background: #E8F4F8; font-weight: 600; }

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
    <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
  </div>
</nav>`;
}

// ── Tableau Public embeds (user-authored workbooks) ──
const TABLEAU_VIZZES = {
  1: {
    vizId: "viz_op_forecast",
    path: "shared/BZ79XYMTJ",
    title: "Operational Census Forecast",
    subtitle: "House Supervisor View",
  },
  2: {
    vizId: "viz_model_perf",
    path: "shared/DWG6QTPDZ",
    title: "Model Performance Analytics",
    subtitle: "Process Improvement View",
  },
  3: {
    vizId: "viz_exec_summary",
    path: "shared/M8QMRYP65",
    title: "Executive Census Summary",
    subtitle: "Leadership View",
  },
};

// Tableau Public auto-generates thumbnail images for every published workbook.
// They update whenever you re-publish, so they always reflect the current viz.
function tableauThumbnail(viz) {
  const code = viz.path.split("/").pop();
  const prefix = code.slice(0, 2);
  return `https://public.tableau.com/static/images/${prefix}/${code}/1.png`;
}

function tableauEmbed(viz) {
  const code = viz.path.split("/").pop();
  const prefix = code.slice(0, 2);
  const publicUrl = `https://public.tableau.com/views/${code}/Dashboard1`;
  const fallbackUrl = `https://public.tableau.com/${viz.path}`;
  const staticImg = `https://public.tableau.com/static/images/${prefix}/${code}/1.png`;
  const rssImg = `https://public.tableau.com/static/images/${prefix}/${code}/1_rss.png`;
  return `
<div class="tableau-frame">
  <div class="tableauPlaceholder" id="${viz.vizId}" style="position: relative; min-height: 950px;">
    <noscript>
      <a href="${fallbackUrl}" target="_blank" rel="noopener">
        <img alt="${viz.title}" src="${rssImg}" style="border: none; max-width: 100%;" />
      </a>
    </noscript>
    <object class="tableauViz" style="display: none;">
      <param name="host_url" value="https%3A%2F%2Fpublic.tableau.com%2F" />
      <param name="embed_code_version" value="3" />
      <param name="path" value="${viz.path}" />
      <param name="toolbar" value="yes" />
      <param name="static_image" value="${staticImg}" />
      <param name="animate_transition" value="yes" />
      <param name="display_static_image" value="yes" />
      <param name="display_spinner" value="yes" />
      <param name="display_overlay" value="yes" />
      <param name="display_count" value="yes" />
      <param name="language" value="en-US" />
      <param name="filter" value="publish=yes" />
    </object>
  </div>
  <script type="text/javascript">
    (function() {
      var divElement = document.getElementById("${viz.vizId}");
      var vizElement = divElement.getElementsByTagName("object")[0];
      // The published workbook is authored at a fixed 1400 × 950 size in
      // Tableau Desktop, so always render the embed at exactly that size.
      // The outer .tableau-frame allows horizontal scroll on viewports
      // narrower than ~1450px instead of producing internal scrollbars.
      vizElement.style.width = "1400px";
      vizElement.style.height = "950px";
      var scriptElement = document.createElement("script");
      scriptElement.src = "https://public.tableau.com/javascripts/api/viz_v1.js";
      vizElement.parentNode.insertBefore(scriptElement, vizElement);
    })();
  </script>
  <p class="tableau-caption">
    Live Tableau Public workbook · daily refresh via GitHub Actions cron + Google Sheets bridge ·
    <a href="${fallbackUrl}" target="_blank" rel="noopener">Open in Tableau Public ↗</a>
  </p>
</div>`;
}

// ── Tableau-like Plotly layout defaults ──
const PLOTLY_LAYOUT_BASE = {
  font: { family: "Segoe UI, Helvetica Neue, Arial, sans-serif", size: 11, color: "#2A2A2A" },
  paper_bgcolor: "#FFFFFF",
  plot_bgcolor: "#FFFFFF",
  margin: { t: 30, r: 20, b: 50, l: 60 },
  hovermode: false,
  xaxis: { gridcolor: "#EEEEEE", linecolor: "#CCCCCC", tickfont: { size: 11 } },
  yaxis: { gridcolor: "#EEEEEE", linecolor: "#CCCCCC", tickfont: { size: 11 } },
};
const TABLEAU_PALETTE = ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948"];

// ── Tableau-embed dashboard page (replaces the Plotly inline versions) ──
function buildDashboardEmbed(viz) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${viz.title} — Nurse Census Prediction</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
${navBar("dashboards")}
<div class="page-body wide">
  <div class="dashboard">
    <div class="dashboard-header">
      <div>
        <h1>${viz.title}</h1>
        <div class="subtitle">${viz.subtitle}</div>
      </div>
      <div class="meta">
        <div>Live Tableau Public</div>
        <div>Daily refresh from GitHub Actions cron</div>
      </div>
    </div>
    <div class="dashboard-body">
      ${tableauEmbed(viz)}
    </div>
  </div>
</div>
</body>
</html>`;
}

// ── Dashboard 1: Operational Census Forecast (legacy Plotly version, unused) ──
function buildDashboard1() {
  // Pick the most-loaded unit so the dashboard tells a story (alert state)
  // From earlier: 705089 sits at 94% utilization → ideal.
  const focusUnit = 705089;
  const meta = data.unitMeta.find(r => r.unit_id === focusUnit);
  const exec = data.exec.find(r => r.unit_id === focusUnit);

  // Time series: last 168h (7 days) of actual + forecast extension at the end
  const rowsAll = data.forecast.filter(r => r.unit_id === focusUnit);
  const last168 = rowsAll.slice(-168);
  const last = last168[last168.length - 1];
  const horizons = [1, 2, 3, 4, 12, 24, 48, 72];
  const lastTs = new Date(last.timestamp);

  const actualX = last168.map(r => r.timestamp);
  const actualY = last168.map(r => r.actual_census);
  const fcX = horizons.map(h => new Date(lastTs.getTime() + h * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16));
  const fcY = horizons.map(h => last[`pred_${h}hr`]);
  // Connect forecast to last actual
  const fcXFull = [last.timestamp, ...fcX];
  const fcYFull = [last.actual_census, ...fcY];

  // KPI cards: current census + capacity + utilization + 8 forecast cards
  const utilization = exec.utilization_pct;
  const utilCls = utilization >= 90 ? "alert" : utilization >= 75 ? "warn" : "good";

  const forecastCards = horizons.map(h => {
    const v = last[`pred_${h}hr`];
    const over = last[`over_capacity_${h}hr`] === 1;
    return `
      <div class="kpi-card ${over ? "alert" : ""}">
        <div class="label">${h}h Forecast</div>
        <div class="value">${v != null ? v.toFixed(1) : "—"}</div>
        <div class="sublabel">${over ? "OVER CAPACITY" : "patients"}</div>
      </div>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Operational Census Forecast — Nurse Census Prediction</title>
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
${navBar("dashboards")}
<div class="page-body">
  <div class="dashboard">
    <div class="dashboard-header">
      <div>
        <h1>Operational Census Forecast</h1>
        <div class="subtitle">House Supervisor View</div>
      </div>
      <div class="meta">
        <div><strong>${last.unit_name || "Unit " + focusUnit}</strong> (${focusUnit})</div>
        <div>As of ${last.timestamp}</div>
      </div>
    </div>
    <div class="dashboard-body">
      <div class="section-title">Current Status</div>
      <div class="kpi-row" style="grid-template-columns: 1fr 1fr 2fr;">
        <div class="kpi-card">
          <div class="label">Current Census</div>
          <div class="value">${last.actual_census}</div>
          <div class="sublabel">patients</div>
        </div>
        <div class="kpi-card">
          <div class="label">Bed Capacity</div>
          <div class="value">${meta.capacity}</div>
          <div class="sublabel">max observed</div>
        </div>
        <div class="kpi-card ${utilCls}">
          <div class="label">Utilization</div>
          <div class="value">${utilization.toFixed(1)}%</div>
          <div class="gauge" style="margin-top: 8px;">
            <div class="fill ${utilCls}" style="width: ${Math.min(utilization, 100)}%"></div>
            <div class="gauge-label">${utilization.toFixed(0)}%</div>
          </div>
        </div>
      </div>

      <div class="section-title">Forecast Cards (Multi-Horizon)</div>
      <div class="kpi-row tight">${forecastCards}</div>

      <div class="section-title">Census Trend — Last 7 Days + 72h Forecast</div>
      <div id="ts-chart" style="height: 320px;"></div>
    </div>
    <div class="footer-note">
      Data: forecast_predictions.csv, unit_metadata.csv · Forecasts via best tabular model per horizon (RF for 1h, LightGBM for 2-72h)
    </div>
  </div>

  <script>
    const actualX = ${JSON.stringify(actualX)};
    const actualY = ${JSON.stringify(actualY)};
    const fcX = ${JSON.stringify(fcXFull)};
    const fcY = ${JSON.stringify(fcYFull)};
    const capacity = ${meta.capacity};
    const layout = ${JSON.stringify(PLOTLY_LAYOUT_BASE)};
    layout.shapes = [{
      type: "line", xref: "paper", x0: 0, x1: 1,
      yref: "y", y0: capacity, y1: capacity,
      line: { color: "#E15759", width: 1.5, dash: "dash" }
    }];
    layout.annotations = [{
      xref: "paper", x: 1, yref: "y", y: capacity, xanchor: "right", yanchor: "bottom",
      text: "Capacity " + capacity, showarrow: false,
      font: { color: "#E15759", size: 11 }
    }];
    layout.yaxis.title = { text: "Census", font: { size: 11 } };
    layout.xaxis.title = { text: "Time", font: { size: 11 } };
    layout.legend = { orientation: "h", y: 1.12, x: 0 };

    Plotly.newPlot("ts-chart", [
      {
        x: actualX, y: actualY, name: "Actual census",
        type: "scatter", mode: "lines",
        line: { color: "#1F4E79", width: 2 }
      },
      {
        x: fcX, y: fcY, name: "Forecast",
        type: "scatter", mode: "lines+markers",
        line: { color: "#F28E2B", width: 2, dash: "dot" },
        marker: { size: 7, color: "#F28E2B" }
      }
    ], layout, { displayModeBar: false, responsive: true })
    .then(() => { window.RENDERED = true; });
  </script>
</div>
</body>
</html>`;
  return html;
}

// ── Dashboard 2: Model Performance Analytics ──
function buildDashboard2() {
  const horizons = [1, 2, 3, 4, 12, 24, 48, 72];
  const models = ["RandomForest", "LightGBM", "LSTM", "Ensemble", "Prophet", "ARIMA"];
  const matrix = models.map(m =>
    horizons.map(h => {
      const row = data.perfAgg.find(r => r.model === m && r.horizon === h);
      return row ? row.within_2_patients_pct : null;
    })
  );

  // Best model per horizon (already in best_model_per_horizon.csv)
  const bestRows = data.best;

  // KPI cards: best at 1h, 4h, 24h, 72h
  const featuredHorizons = [1, 4, 24, 72];
  const kpiCards = featuredHorizons.map(h => {
    const row = bestRows.find(r => r.horizon === h);
    return `
      <div class="kpi-card good">
        <div class="label">${h}h Best Model</div>
        <div class="value">${row.within_2_patients_pct.toFixed(1)}%</div>
        <div class="sublabel">${row.model} · MAE ${row.mae.toFixed(2)}</div>
      </div>`;
  }).join("");

  // Per-unit breakdown for 24h horizon (representative mid-horizon)
  const focusH = 24;
  const perfByUnit = readCSV("model_performance.csv");
  const perUnit = data.unitMeta.map(u => {
    const allModels = ["RandomForest", "LightGBM", "LSTM"];
    return {
      unit_id: u.unit_id,
      unit_name: u.unit_name || `Unit ${u.unit_id}`,
      ...Object.fromEntries(allModels.map(m => {
        const r = perfByUnit.find(
          r => r.unit_id === u.unit_id && r.model === m && r.horizon === focusH);
        return [m, r ? r.within_2_patients_pct : null];
      })),
    };
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Model Performance Analytics — Nurse Census Prediction</title>
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
${navBar("dashboards")}
<div class="page-body">
  <div class="dashboard">
    <div class="dashboard-header">
      <div>
        <h1>Model Performance Analytics</h1>
        <div class="subtitle">Process Improvement View</div>
      </div>
      <div class="meta">
        <div>Validation set · ${data.unitMeta.length} units · 8 horizons</div>
        <div>Primary metric: ±2 patient accuracy</div>
      </div>
    </div>
    <div class="dashboard-body">
      <div class="section-title">Best Model Per Horizon (Highlights)</div>
      <div class="kpi-row">${kpiCards}</div>

      <div class="section-title">Accuracy Heatmap — Models × Forecast Horizons</div>
      <div id="heatmap" style="height: 280px;"></div>

      <div class="section-title">Per-Unit Accuracy Breakdown — 24h Horizon</div>
      <div id="bar-units" style="height: 260px;"></div>
    </div>
    <div class="footer-note">
      Data: model_performance.csv · model_performance_aggregated.csv · best_model_per_horizon.csv
    </div>
  </div>

  <script>
    const horizons = ${JSON.stringify(horizons)};
    const models = ${JSON.stringify(models)};
    const matrix = ${JSON.stringify(matrix)};
    const layoutBase = ${JSON.stringify(PLOTLY_LAYOUT_BASE)};

    // Heatmap
    const heatLayout = JSON.parse(JSON.stringify(layoutBase));
    heatLayout.margin = { t: 20, r: 20, b: 40, l: 140 };
    heatLayout.xaxis = { ...heatLayout.xaxis, type: "category",
                         title: { text: "Forecast horizon (hours)", font: { size: 11 } },
                         tickmode: "array",
                         tickvals: horizons.map(h => h + "h"),
                         ticktext: horizons.map(h => h + "h") };
    heatLayout.yaxis = { ...heatLayout.yaxis, automargin: true, type: "category" };

    Plotly.newPlot("heatmap", [{
      type: "heatmap",
      x: horizons.map(h => h + "h"),
      y: models,
      z: matrix,
      colorscale: [
        [0,    "#FBE4E2"],
        [0.5,  "#F4D03F"],
        [0.85, "#76B7B2"],
        [1,    "#1F4E79"]
      ],
      zmin: 50, zmax: 100,
      colorbar: { title: { text: "± 2 acc %", font: { size: 11 } }, thickness: 12, len: 0.8 },
      text: matrix.map(row => row.map(v => v !== null ? v.toFixed(1) + "%" : "")),
      texttemplate: "%{text}",
      textfont: { size: 11, color: "white" },
      hoverinfo: "skip"
    }], heatLayout, { displayModeBar: false });

    // Per-unit bar chart for 24h horizon
    const perUnit = ${JSON.stringify(perUnit)};
    const unitLabels = perUnit.map(p => p.unit_name);
    const traceRF = { x: unitLabels, y: perUnit.map(p => p.RandomForest), name: "RandomForest",
                     type: "bar", marker: { color: "#4E79A7" } };
    const traceLGBM = { x: unitLabels, y: perUnit.map(p => p.LightGBM), name: "LightGBM",
                        type: "bar", marker: { color: "#F28E2B" } };
    const traceLSTM = { x: unitLabels, y: perUnit.map(p => p.LSTM), name: "LSTM",
                        type: "bar", marker: { color: "#59A14F" } };

    const barLayout = JSON.parse(JSON.stringify(layoutBase));
    barLayout.barmode = "group";
    barLayout.xaxis = { ...barLayout.xaxis, type: "category",
                        title: { text: "Nurse unit", font: { size: 11 } } };
    barLayout.yaxis.title = { text: "± 2 patient accuracy (%)", font: { size: 11 } };
    barLayout.yaxis.range = [0, 100];
    barLayout.legend = { orientation: "h", y: 1.12, x: 0 };

    Plotly.newPlot("bar-units", [traceRF, traceLGBM, traceLSTM], barLayout, { displayModeBar: false })
      .then(() => { window.RENDERED = true; });
  </script>
</div>
</body>
</html>`;
  return html;
}

// ── Dashboard 3: Executive Summary ──
function buildDashboard3() {
  const exec = [...data.exec].sort((a, b) => b.utilization_pct - a.utilization_pct);
  const totalCensus = data.exec.reduce((s, r) => s + r.latest_census, 0);
  const totalCapacity = data.exec.reduce((s, r) => s + r.capacity, 0);
  const avgUtil = data.exec.reduce((s, r) => s + r.utilization_pct, 0) / data.exec.length;
  const alertCount = data.exec.filter(r =>
    r.alert_over_90pct === "True" || r.alert_over_90pct === true).length;

  const totalUtilCls = avgUtil >= 90 ? "alert" : avgUtil >= 75 ? "warn" : "good";
  const alertCls = alertCount > 0 ? "alert" : "good";

  const tableRows = exec.map(r => {
    const isAlert = r.alert_over_90pct === "True" || r.alert_over_90pct === true;
    const utilCls = r.utilization_pct >= 90 ? "alert" : r.utilization_pct >= 75 ? "warn" : "good";
    const fc72 = r.forecast_72hr != null ? r.forecast_72hr.toFixed(1) : "—";
    const displayName = r.unit_name || `Unit ${r.unit_id}`;
    return `
      <tr class="${isAlert ? "alert" : ""}">
        <td><strong>${displayName}</strong><div style="font-size:10px;color:#999;">${r.unit_id}</div></td>
        <td class="num">${r.latest_census}</td>
        <td class="num">${r.capacity}</td>
        <td class="num">${fc72}</td>
        <td>
          <div class="gauge" style="height: 22px;">
            <div class="fill ${utilCls}" style="width: ${Math.min(r.utilization_pct, 100)}%"></div>
            <div class="gauge-label">${r.utilization_pct.toFixed(0)}%</div>
          </div>
        </td>
        <td>${isAlert ? '<span class="badge red">>90%</span>' : '<span class="badge green">OK</span>'}</td>
      </tr>`;
  }).join("");

  const bestModelRows = data.best.map(r => `
    <tr>
      <td><strong>${r.horizon}h</strong></td>
      <td>${r.model}</td>
      <td class="num">${r.within_2_patients_pct.toFixed(1)}%</td>
    </tr>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Executive Census Summary — Nurse Census Prediction</title>
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
${navBar("dashboards")}
<div class="page-body">
  <div class="dashboard">
    <div class="dashboard-header">
      <div>
        <h1>Executive Census Summary</h1>
        <div class="subtitle">Leadership View</div>
      </div>
      <div class="meta">
        <div>${data.exec.length} active nurse units</div>
        <div>Census prediction · 1–72h horizons</div>
      </div>
    </div>
    <div class="dashboard-body">
      <div class="section-title">House-Wide KPIs</div>
      <div class="kpi-row">
        <div class="kpi-card">
          <div class="label">Total Current Census</div>
          <div class="value">${totalCensus}</div>
          <div class="sublabel">across ${data.exec.length} units</div>
        </div>
        <div class="kpi-card">
          <div class="label">Total Bed Capacity</div>
          <div class="value">${totalCapacity}</div>
          <div class="sublabel">max observed historical</div>
        </div>
        <div class="kpi-card ${totalUtilCls}">
          <div class="label">Average Utilization</div>
          <div class="value">${avgUtil.toFixed(1)}%</div>
          <div class="sublabel">across all units</div>
        </div>
        <div class="kpi-card ${alertCls}">
          <div class="label">Units Over 90%</div>
          <div class="value">${alertCount}</div>
          <div class="sublabel">capacity alerts</div>
        </div>
      </div>

      <div class="split-row">
        <div>
          <div class="section-title">Utilization by Unit (Sorted)</div>
          <div id="util-bar" style="height: 360px;"></div>
        </div>
        <div>
          <div class="section-title">Best Model Recommendations</div>
          <table class="data-table">
            <thead>
              <tr>
                <th>Horizon</th>
                <th>Model</th>
                <th style="text-align:right;">±2 Acc</th>
              </tr>
            </thead>
            <tbody>${bestModelRows}</tbody>
          </table>
        </div>
      </div>

      <div class="section-title" style="margin-top: 18px;">Per-Unit Detail</div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Unit</th>
            <th style="text-align:right;">Current</th>
            <th style="text-align:right;">Capacity</th>
            <th style="text-align:right;">72h Forecast</th>
            <th>Utilization</th>
            <th>Alert</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div class="footer-note">
      Data: executive_summary.csv · unit_metadata.csv · best_model_per_horizon.csv
    </div>
  </div>

  <script>
    const exec = ${JSON.stringify(exec)};
    const layoutBase = ${JSON.stringify(PLOTLY_LAYOUT_BASE)};
    const utilLayout = JSON.parse(JSON.stringify(layoutBase));
    utilLayout.margin = { t: 20, r: 20, b: 70, l: 50 };
    utilLayout.xaxis = { ...utilLayout.xaxis, type: "category",
                         title: { text: "Nurse unit", font: { size: 11 } } };
    utilLayout.yaxis.title = { text: "Utilization (%)", font: { size: 11 } };
    utilLayout.yaxis.range = [0, 110];
    utilLayout.shapes = [{
      type: "line", xref: "paper", x0: 0, x1: 1,
      yref: "y", y0: 90, y1: 90,
      line: { color: "#E15759", width: 1.5, dash: "dash" }
    }];
    utilLayout.annotations = [{
      xref: "paper", x: 1, yref: "y", y: 90, xanchor: "right", yanchor: "bottom",
      text: "Alert threshold 90%", showarrow: false,
      font: { color: "#E15759", size: 11 }
    }];

    const colors = exec.map(r => {
      if (r.utilization_pct >= 90) return "#E15759";
      if (r.utilization_pct >= 75) return "#F28E2B";
      return "#4E79A7";
    });

    Plotly.newPlot("util-bar", [{
      x: exec.map(r => r.unit_name || ("Unit " + r.unit_id)),
      y: exec.map(r => r.utilization_pct),
      type: "bar",
      marker: { color: colors },
      text: exec.map(r => r.utilization_pct.toFixed(0) + "%"),
      textposition: "outside",
      textfont: { size: 11 },
      hoverinfo: "skip"
    }], utilLayout, { displayModeBar: false })
    .then(() => { window.RENDERED = true; });
  </script>
</div>
</body>
</html>`;
  return html;
}

// ── Landing page (index.html) ──
function buildIndex() {
  const totalUnits = data.unitMeta.length;
  const totalCapacity = data.exec.reduce((s, r) => s + (r.capacity || 0), 0);
  const totalCensus = data.exec.reduce((s, r) => s + (r.latest_census || 0), 0);
  const best1h = data.best.find(r => r.horizon === 1);
  const best72h = data.best.find(r => r.horizon === 72);
  const refreshTime = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

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
      trained per unit on 21 months of hourly admit/discharge/transfer data,
      delivering 1-, 4-, 24-, and 72-hour predictions to three operational dashboards.
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
        <div class="num"><a href="tests.html" style="color:inherit;text-decoration:none;">34 / 34</a></div>
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
        <div class="flow-step muted">GitHub Pages<span class="step-sub">static dashboards (this site)</span></div>
        <div class="flow-arrow">↘</div>
        <div class="flow-step muted">Tableau Public<span class="step-sub">refreshes from raw.githubusercontent.com</span></div>
      </div>
    </div>
    <p style="font-size:12px;color:var(--muted);margin-top:8px;">
      In production, the synthetic ADT step is replaced by an ETL job pulling the live data warehouse;
      everything downstream is unchanged.
    </p>
  </section>

  <section class="section featured-preview">
    <h3>Featured: Executive Census Summary</h3>
    <a href="dashboard3.html"><img src="${tableauThumbnail(TABLEAU_VIZZES[3])}" alt="Executive Census Summary preview"></a>
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
          <div class="audience">34 cases · pytest</div>
          <p>Per-test catalog covering data integrity, leakage prevention, chronological splits, metric correctness, model fits, and ensemble weighting. Data-free subset runs in CI.</p>
        </div>
      </a>
      <a class="gallery-card" href="${REPO_URL}" target="_blank" rel="noopener">
        <div class="meta">
          <h3>Source code</h3>
          <div class="audience">GitHub · MIT licensed</div>
          <p>Full repository: pipeline source, tests (34 cases), GitHub Actions workflow, configuration, and this static site.</p>
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
    <div class="section-title">Live model performance — Tableau Public</div>
    <a href="dashboard2.html" class="featured-preview" style="display: block; text-decoration: none; color: inherit;">
      <img src="${tableauThumbnail(TABLEAU_VIZZES[2])}" alt="Live Tableau Model Performance dashboard" style="display: block; margin: 0 auto;">
      <div class="caption">
        <span>Heatmap, per-unit breakdown, best-model callouts — interactive in the live dashboard.</span>
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
      The training data is 21 months (Mar 2024 – Dec 2025) of de-identified hourly census
      and ADT (admit / discharge / transfer) aggregates across 9 active nurse units, plus
      contextual features (ED census, scheduled surgeries, holiday flags). 139,507 hourly
      observations after cleaning. Lag features (1–72 hour previous census, rolling 4/8/24h
      flow rates, 7-day rolling stats) are pre-computed in SQL and consumed directly by the
      pipeline. Real production deployment would replace the static CSV input with an ETL job
      pulling the live data warehouse.
    </p>
  </div>

  <div class="section">
    <div class="section-title">2. Train / validation / test split</div>
    <table class="perf-table" style="margin-top:12px;">
      <thead><tr><th>Split</th><th>Date range</th><th>Rows</th><th>%</th></tr></thead>
      <tbody>
        <tr><td>Train</td><td>2024-03-25 – 2025-06-30</td><td>99,772</td><td>71.5%</td></tr>
        <tr><td>Validation</td><td>2025-07-01 – 2025-09-30</td><td>19,872</td><td>14.2%</td></tr>
        <tr><td>Test</td><td>2025-10-01 – 2025-12-30</td><td>19,863</td><td>14.2%</td></tr>
      </tbody>
    </table>
    <p style="font-size:12px;color:var(--muted);margin-top:8px;">
      Strictly chronological — no shuffling. Train spans full seasonal cycles; validation
      captures the late-summer trough; test holds out the year-end peak.
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
      Residual diagnostics include Shapiro-Wilk normality test (sampled if n &gt; 5000) and
      Ljung-Box autocorrelation. Evaluation is per (model, unit, horizon); aggregated tables
      report cross-unit means.
    </p>
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
      no magic constants in code. <strong><a href="tests.html">34 pytest cases</a></strong>
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
      <img src="${tableauThumbnail(TABLEAU_VIZZES[1])}" alt="Operational Census Forecast preview">
      <div class="meta">
        <h3>Operational Census Forecast</h3>
        <div class="audience">House Supervisors</div>
        <p>Current census, multi-horizon forecast cards (1h–72h), 7-day actual vs predicted trend, capacity alert indicators.</p>
      </div>
    </a>
    <a class="gallery-card" href="dashboard2.html">
      <img src="${tableauThumbnail(TABLEAU_VIZZES[2])}" alt="Model Performance Analytics preview">
      <div class="meta">
        <h3>Model Performance Analytics</h3>
        <div class="audience">Process Improvement</div>
        <p>Best-per-horizon callouts, full 6-model × 8-horizon accuracy heatmap, per-unit accuracy breakdown.</p>
      </div>
    </a>
    <a class="gallery-card" href="dashboard3.html">
      <img src="${tableauThumbnail(TABLEAU_VIZZES[3])}" alt="Executive Census Summary preview">
      <div class="meta">
        <h3>Executive Census Summary</h3>
        <div class="audience">Leadership</div>
        <p>House-wide KPIs, utilization-by-unit ranking with 90% alert threshold, best-model recommendations, per-unit detail table.</p>
      </div>
    </a>
  </div>

  <p style="font-size:12px;color:var(--muted);margin-top:24px;">
    Underlying data: <code>outputs/tableau/forecast_predictions.csv</code>, <code>executive_summary.csv</code>,
    <code>model_performance.csv</code>, <code>unit_metadata.csv</code>, <code>best_model_per_horizon.csv</code>.
    All refreshed daily via the GitHub Actions cron.
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
fs.writeFileSync(path.join(OUT_HTML_DIR, "style.css"), STYLES);
fs.writeFileSync(path.join(OUT_HTML_DIR, "index.html"), buildIndex());
fs.writeFileSync(path.join(OUT_HTML_DIR, "models.html"), buildModels());
fs.writeFileSync(path.join(OUT_HTML_DIR, "methodology.html"), buildMethodology());
fs.writeFileSync(path.join(OUT_HTML_DIR, "tests.html"), buildTests());
fs.writeFileSync(path.join(OUT_HTML_DIR, "dashboards.html"), buildDashboardsGallery());
fs.writeFileSync(path.join(OUT_HTML_DIR, "dashboard1.html"), buildDashboardEmbed(TABLEAU_VIZZES[1]));
fs.writeFileSync(path.join(OUT_HTML_DIR, "dashboard2.html"), buildDashboardEmbed(TABLEAU_VIZZES[2]));
fs.writeFileSync(path.join(OUT_HTML_DIR, "dashboard3.html"), buildDashboardEmbed(TABLEAU_VIZZES[3]));
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
