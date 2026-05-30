"""
Synthetic hourly census refresh — operational-flow demonstration.

Produces a 7-day rolling window of plausible hourly census readings per active
unit, plus 1-72h forecasts on the latest hour. Calibrated against the
distributional statistics in unit_metadata.csv (mean, std, capacity), with
daily and weekly seasonality factors applied.

Designed to be run on a schedule (GitHub Actions cron, daily) so the deployed
dashboards demonstrate end-to-end refresh — synthetic data feed → forecast
pipeline → CSV exports → static dashboards + Tableau Public — without exposing
real patient-flow data.

Output (overwrites):
  outputs/tableau/forecast_predictions.csv
  outputs/tableau/executive_summary.csv
  outputs/tableau/forecast_timeline.csv
  outputs/tableau/drift_history.csv (appends one forward point)

With --drift-only, the forecast CSVs are left untouched and only the forward
drift point is appended — used once real data backs the forecasts and the
daily job's role is to keep the drift monitor advancing into the future.

This is NOT a substitute for the real prediction pipeline (run_pipeline.py).
The forecasts here use a simple mean-reversion model, not the trained
ARIMA/Prophet/LSTM/RF/LightGBM ensemble.
"""

from __future__ import annotations

import csv
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from random import Random

REPO_ROOT = Path(__file__).resolve().parent.parent
TABLEAU_DIR = REPO_ROOT / "outputs" / "tableau"
META_PATH = TABLEAU_DIR / "unit_metadata.csv"
BASELINE_PATH = TABLEAU_DIR / "drift_baseline.json"
HISTORY_PATH = TABLEAU_DIR / "drift_history.csv"
HORIZONS = [1, 2, 3, 4, 12, 24, 48, 72]
HOURS_OF_HISTORY = 168  # 7 days

# PSI interpretation thresholds (match src/monitoring/drift.py).
PSI_MINOR = 0.10
PSI_MAJOR = 0.25

NUMERIC_META_COLS = {"capacity", "mean_census", "median_census",
                      "min_census", "max_census", "std_census"}


def read_unit_metadata() -> list[dict]:
    rows = []
    with META_PATH.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            for k in NUMERIC_META_COLS:
                if k in row and row[k] != "":
                    row[k] = float(row[k])
            row["total_rows"] = int(row.get("total_rows", "0") or 0)
            rows.append(row)
    return rows


def hour_of_day_factor(hour: int) -> float:
    """Daily seasonality: census peaks 14-16, troughs 04-06.
    Returns ~[0.85, 1.05]."""
    return 0.95 + 0.10 * math.sin(2 * math.pi * (hour - 4) / 24)


def day_of_week_factor(dow: int) -> float:
    """Weekday slightly higher than weekend."""
    return 1.0 if dow < 5 else 0.92


def _sample_from_hist(edges: list[float], props: list[float], capacity: int,
                      rng: Random) -> float:
    """Draw a value from a baseline histogram (edges + bin proportions),
    clamping the open -inf/+inf end bins to the adjacent finite edge."""
    r = rng.random()
    cum = 0.0
    idx = len(props) - 1
    for i, p in enumerate(props):
        cum += p
        if r <= cum:
            idx = i
            break
    lo, hi = edges[idx], edges[idx + 1]
    if lo == float("-inf"):
        lo = max(0.0, hi - 1)
    if hi == float("inf"):
        hi = min(capacity, lo + 1)
    return rng.uniform(lo, hi)


def synth_census(unit: dict, t: datetime, rng: Random,
                 baseline_dist: dict | None = None) -> int:
    capacity = int(unit["capacity"])
    b = (baseline_dist or {}).get(str(unit["unit_id"]))
    if b:
        # Sample the real training distribution (preserves its near-capacity
        # skew), then nudge gently for daily/weekly rhythm.
        base = _sample_from_hist(b["edges"], b["expected_props"], capacity, rng)
        seasonal = hour_of_day_factor(t.hour) * day_of_week_factor(t.weekday()) - 1.0
        c = base + seasonal * unit["std_census"]
        return max(0, min(capacity, round(c)))

    # Fallback (no baseline yet): mean/std model.
    mean = unit["mean_census"]
    std = unit["std_census"]
    seasonal = hour_of_day_factor(t.hour) * day_of_week_factor(t.weekday())
    c = mean * seasonal + rng.gauss(0, std * 0.3)
    return max(0, min(capacity, round(c)))


def synth_forecast(unit: dict, current: int, t_now: datetime,
                    horizon: int, rng: Random) -> float:
    """Mean-reversion forecast with seasonal correction and small noise."""
    mean = unit["mean_census"]
    std = unit["std_census"]
    capacity = int(unit["capacity"])
    ft = t_now + timedelta(hours=horizon)
    seasonal = hour_of_day_factor(ft.hour) * day_of_week_factor(ft.weekday())
    fc = (mean * seasonal
          + (current - mean) * math.exp(-horizon / 24)
          + rng.gauss(0, std * 0.2))
    return round(max(0, min(capacity, fc)), 1)


def forecast_halfwidth(unit: dict, horizon: int) -> float:
    """Interval half-width that widens with horizon, scaled by the unit's std.
    A demonstration band for the synthetic feed; the real pipeline derives
    these from split-conformal validation residuals."""
    std = unit["std_census"]
    return round(std * (0.35 + 0.12 * math.sqrt(horizon)), 1)


def generate_unit_window(unit: dict, now: datetime, rng: Random,
                         baseline_dist: dict | None = None) -> list[dict]:
    rows = []
    capacity = int(unit["capacity"])
    history_pts = []

    for delta in range(HOURS_OF_HISTORY, 0, -1):
        t = now - timedelta(hours=delta)
        history_pts.append((t, synth_census(unit, t, rng, baseline_dist)))

    current_census = synth_census(unit, now, rng, baseline_dist)
    history_pts.append((now, current_census))

    forecasts = {h: synth_forecast(unit, current_census, now, h, rng)
                 for h in HORIZONS}
    bands = {h: forecast_halfwidth(unit, h) for h in HORIZONS}

    for t, c in history_pts:
        is_latest = t == now
        row = {
            "timestamp": t.strftime("%Y-%m-%d %H:%M:%S"),
            "unit_id": unit["unit_id"],
            "unit_name": unit["unit_name"],
            "actual_census": int(c),
        }
        for h in HORIZONS:
            row[f"pred_{h}hr"] = forecasts[h] if is_latest else ""
            if is_latest:
                row[f"pred_{h}hr_lower"] = round(max(0, forecasts[h] - bands[h]), 1)
                row[f"pred_{h}hr_upper"] = round(min(capacity, forecasts[h] + bands[h]), 1)
            else:
                row[f"pred_{h}hr_lower"] = ""
                row[f"pred_{h}hr_upper"] = ""
        row["capacity"] = capacity
        for h in HORIZONS:
            row[f"over_capacity_{h}hr"] = (
                1 if (is_latest and forecasts[h] >= capacity) else
                0 if is_latest else ""
            )
        rows.append(row)

    return rows


def write_forecast_predictions(all_rows: list[dict], path: Path) -> None:
    pred_cols = []
    for h in HORIZONS:
        pred_cols += [f"pred_{h}hr", f"pred_{h}hr_lower", f"pred_{h}hr_upper"]
    fieldnames = (["timestamp", "unit_id", "unit_name", "actual_census"]
                  + pred_cols
                  + ["capacity"]
                  + [f"over_capacity_{h}hr" for h in HORIZONS])
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(all_rows)


def write_forecast_timeline(all_rows: list[dict], now: datetime, path: Path) -> None:
    """Long-format timeline: one row per (timestamp, unit) for actuals + one row
    per (forecast_at, unit) for each forecast horizon. Same schema as the
    real-data export so a Tableau workbook can switch between sources."""
    fieldnames = ["timestamp", "unit_id", "unit_name", "value",
                  "value_lower", "value_upper", "series", "horizon_h", "capacity"]
    out_rows = []
    now_str = now.strftime("%Y-%m-%d %H:%M:%S")

    for r in all_rows:
        out_rows.append({
            "timestamp": r["timestamp"],
            "unit_id": r["unit_id"],
            "unit_name": r["unit_name"],
            "value": float(r["actual_census"]),
            "value_lower": float(r["actual_census"]),
            "value_upper": float(r["actual_census"]),
            "series": "Actual",
            "horizon_h": 0,
            "capacity": int(r["capacity"]),
        })

    for r in all_rows:
        if r["timestamp"] != now_str:
            continue
        anchor = now
        for h in HORIZONS:
            v = r.get(f"pred_{h}hr")
            if v == "" or v is None:
                continue
            lo = r.get(f"pred_{h}hr_lower")
            hi = r.get(f"pred_{h}hr_upper")
            forecast_ts = anchor + timedelta(hours=h)
            out_rows.append({
                "timestamp": forecast_ts.strftime("%Y-%m-%d %H:%M:%S"),
                "unit_id": r["unit_id"],
                "unit_name": r["unit_name"],
                "value": float(v),
                "value_lower": float(lo) if lo not in ("", None) else float(v),
                "value_upper": float(hi) if hi not in ("", None) else float(v),
                "series": "Forecast",
                "horizon_h": h,
                "capacity": int(r["capacity"]),
            })

    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(out_rows)


def write_executive_summary(all_rows: list[dict], units: list[dict],
                             now: datetime, path: Path) -> None:
    rows_by_unit = {}
    now_str = now.strftime("%Y-%m-%d %H:%M:%S")
    for r in all_rows:
        if r["timestamp"] == now_str:
            rows_by_unit[r["unit_id"]] = r

    fieldnames = ["unit_id", "unit_name", "latest_census", "capacity",
                  "utilization_pct", "forecast_72hr", "alert_over_90pct"]

    summary_rows = []
    for unit in units:
        latest = rows_by_unit.get(unit["unit_id"])
        if not latest:
            continue
        cap = int(latest["capacity"])
        cur = int(latest["actual_census"])
        util = round(cur / cap * 100, 1) if cap else None
        summary_rows.append({
            "unit_id": unit["unit_id"],
            "unit_name": unit["unit_name"],
            "latest_census": cur,
            "capacity": cap,
            "utilization_pct": util,
            "forecast_72hr": latest[f"pred_72hr"],
            "alert_over_90pct": "True" if (util is not None and util >= 90) else "False",
        })

    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(summary_rows)


def _bin_index(value: float, edges: list[float]) -> int:
    """Bin index for a value given ascending edges with -inf/+inf ends."""
    for i in range(len(edges) - 1):
        if edges[i] <= value < edges[i + 1]:
            return i
    return len(edges) - 2


def _psi(values: list[float], edges: list[float], expected_props: list[float],
         eps: float = 1e-6) -> float:
    """Population Stability Index of `values` against a frozen baseline.
    Pure-Python (the daily refresh runs without numpy)."""
    nbins = len(edges) - 1
    counts = [0] * nbins
    n = 0
    for v in values:
        if v is None:
            continue
        counts[_bin_index(v, edges)] += 1
        n += 1
    if n == 0:
        return float("nan")
    psi = 0.0
    for i in range(nbins):
        a = max(counts[i] / n, eps)
        e = max(expected_props[i], eps)
        psi += (a - e) * math.log(a / e)
    return psi


def _drift_status(psi: float) -> str:
    if psi != psi:  # NaN
        return "unknown"
    if psi < PSI_MINOR:
        return "stable"
    if psi < PSI_MAJOR:
        return "moderate"
    return "major"


def append_drift_history(all_rows: list[dict], now: datetime) -> None:
    """Compute today's PSI per unit on the synthetic window vs the committed
    baseline and append one `live` row per unit to drift_history.csv. The same
    computation runs on real data once the synthetic feed is swapped for the
    live warehouse, so the monitoring loop is identical in either case."""
    if not BASELINE_PATH.exists():
        print(f"Drift baseline not found at {BASELINE_PATH}; skipping drift append")
        return
    with BASELINE_PATH.open(encoding="utf-8") as f:
        baseline = json.load(f)

    census_by_unit: dict[str, list[float]] = {}
    names: dict[str, str] = {}
    for r in all_rows:
        uid = str(r["unit_id"])
        census_by_unit.setdefault(uid, []).append(float(r["actual_census"]))
        names[uid] = r["unit_name"]

    today = now.strftime("%Y-%m-%d")
    new_rows = []
    for uid, census in census_by_unit.items():
        b = baseline.get(uid)
        if not b:
            continue
        psi = _psi(census, b["edges"], b["expected_props"])
        new_rows.append({
            "as_of": today,
            "unit_id": uid,
            "unit_name": names.get(uid, f"Unit {uid}"),
            "psi": round(psi, 4),
            "drift_status": _drift_status(psi),
            "source": "live",
        })
    if not new_rows:
        return

    fieldnames = ["as_of", "unit_id", "unit_name", "psi", "drift_status", "source"]
    existing = []
    last_real_date = ""
    if HISTORY_PATH.exists():
        with HISTORY_PATH.open(encoding="utf-8") as f:
            reader = csv.DictReader(f)
            # Preserve whatever schema is on disk so richer columns added by the
            # offline pipeline (e.g. psi_residual, alert_kind) are not dropped.
            if reader.fieldnames:
                fieldnames = list(reader.fieldnames)
            for row in reader:
                if row.get("source") == "test":
                    last_real_date = max(last_real_date, row.get("as_of", ""))
                if row.get("as_of") != today:  # replace any prior run from today
                    existing.append(row)

    # Only simulate drift for dates beyond the real data; real test points
    # always take precedence where they exist.
    if last_real_date and today <= last_real_date:
        print(f"Real drift data covers {today} (through {last_real_date}); "
              "skipping synthetic append")
        return

    # Pad new live rows so they carry every column in the on-disk schema; the
    # richer offline-only columns just stay blank for live points.
    for nr in new_rows:
        for col in fieldnames:
            nr.setdefault(col, "")

    with HISTORY_PATH.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(existing)
        w.writerows(new_rows)
    print(f"Appended {len(new_rows)} live drift points for {today} to {HISTORY_PATH.name}")


def main() -> None:
    units = [u for u in read_unit_metadata() if u.get("total_rows", 0) >= 1000]
    if not units:
        raise SystemExit("No active units found in unit_metadata.csv")

    now = datetime.now(timezone.utc).replace(minute=0, second=0,
                                              microsecond=0, tzinfo=None)
    rng = Random(int(now.timestamp()) // 3600)  # one seed per hour

    baseline_dist = {}
    if BASELINE_PATH.exists():
        with BASELINE_PATH.open(encoding="utf-8") as f:
            baseline_dist = json.load(f)

    all_rows = []
    for unit in units:
        all_rows.extend(generate_unit_window(unit, now, rng, baseline_dist))

    fp_path = TABLEAU_DIR / "forecast_predictions.csv"
    es_path = TABLEAU_DIR / "executive_summary.csv"
    tl_path = TABLEAU_DIR / "forecast_timeline.csv"

    drift_only = "--drift-only" in sys.argv

    if not drift_only:
        write_forecast_predictions(all_rows, fp_path)
        write_executive_summary(all_rows, units, now, es_path)
        write_forecast_timeline(all_rows, now, tl_path)
        print(f"Refreshed {fp_path.name} ({len(all_rows)} rows)")
        print(f"Refreshed {es_path.name} ({len(units)} units)")
        print(f"Refreshed {tl_path.name}")

    # Always advance the drift monitor. In --drift-only mode the committed
    # real forecast exports are left untouched; only forward drift is appended.
    append_drift_history(all_rows, now)

    mode = "drift-only" if drift_only else "full"
    print(f"Operational refresh complete ({mode}) at {now.isoformat()}Z")


if __name__ == "__main__":
    main()
