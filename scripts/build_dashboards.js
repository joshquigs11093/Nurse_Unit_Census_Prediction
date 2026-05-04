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
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  padding: 18px;
  font-size: 13px;
}
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
`;

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

// ── Dashboard 1: Operational Census Forecast ──
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
  <title>Operational Census Forecast</title>
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
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
  <title>Model Performance Analytics</title>
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
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
  <title>Executive Census Summary</title>
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
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
</body>
</html>`;
  return html;
}

// ── Index page ──
function buildIndex() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Nurse Census Forecast Dashboards</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="dashboard">
    <div class="dashboard-header">
      <div>
        <h1>Nurse Unit Census Prediction — Dashboards</h1>
        <div class="subtitle">Three audience-specific views over the M3 forecasting pipeline outputs</div>
      </div>
    </div>
    <div class="dashboard-body">
      <ul style="font-size: 14px; line-height: 1.8;">
        <li><a href="dashboard1.html">Dashboard 1 — Operational Census Forecast (House Supervisors)</a></li>
        <li><a href="dashboard2.html">Dashboard 2 — Model Performance Analytics (Process Improvement)</a></li>
        <li><a href="dashboard3.html">Dashboard 3 — Executive Census Summary (Leadership)</a></li>
      </ul>
    </div>
  </div>
</body>
</html>`;
}

// ── Write HTML and CSS ──
fs.writeFileSync(path.join(OUT_HTML_DIR, "style.css"), STYLES);
fs.writeFileSync(path.join(OUT_HTML_DIR, "dashboard1.html"), buildDashboard1());
fs.writeFileSync(path.join(OUT_HTML_DIR, "dashboard2.html"), buildDashboard2());
fs.writeFileSync(path.join(OUT_HTML_DIR, "dashboard3.html"), buildDashboard3());
fs.writeFileSync(path.join(OUT_HTML_DIR, "index.html"), buildIndex());
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
