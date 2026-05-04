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

This is NOT a substitute for the real prediction pipeline (run_pipeline.py).
The forecasts here use a simple mean-reversion model, not the trained
ARIMA/Prophet/LSTM/RF/LightGBM ensemble. Real predictions remain available
via the static M3 export.
"""

from __future__ import annotations

import csv
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from random import Random

REPO_ROOT = Path(__file__).resolve().parent.parent
TABLEAU_DIR = REPO_ROOT / "outputs" / "tableau"
META_PATH = TABLEAU_DIR / "unit_metadata.csv"
HORIZONS = [1, 2, 3, 4, 12, 24, 48, 72]
HOURS_OF_HISTORY = 168  # 7 days

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


def synth_census(unit: dict, t: datetime, rng: Random) -> int:
    mean = unit["mean_census"]
    std = unit["std_census"]
    capacity = int(unit["capacity"])
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


def generate_unit_window(unit: dict, now: datetime, rng: Random) -> list[dict]:
    rows = []
    capacity = int(unit["capacity"])
    history_pts = []

    for delta in range(HOURS_OF_HISTORY, 0, -1):
        t = now - timedelta(hours=delta)
        history_pts.append((t, synth_census(unit, t, rng)))

    current_census = synth_census(unit, now, rng)
    history_pts.append((now, current_census))

    forecasts = {h: synth_forecast(unit, current_census, now, h, rng)
                 for h in HORIZONS}

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
        row["capacity"] = capacity
        for h in HORIZONS:
            row[f"over_capacity_{h}hr"] = (
                1 if (is_latest and forecasts[h] >= capacity) else
                0 if is_latest else ""
            )
        rows.append(row)

    return rows


def write_forecast_predictions(all_rows: list[dict], path: Path) -> None:
    fieldnames = (["timestamp", "unit_id", "unit_name", "actual_census"]
                  + [f"pred_{h}hr" for h in HORIZONS]
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
                  "series", "horizon_h", "capacity"]
    out_rows = []
    now_str = now.strftime("%Y-%m-%d %H:%M:%S")

    for r in all_rows:
        out_rows.append({
            "timestamp": r["timestamp"],
            "unit_id": r["unit_id"],
            "unit_name": r["unit_name"],
            "value": float(r["actual_census"]),
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
            forecast_ts = anchor + timedelta(hours=h)
            out_rows.append({
                "timestamp": forecast_ts.strftime("%Y-%m-%d %H:%M:%S"),
                "unit_id": r["unit_id"],
                "unit_name": r["unit_name"],
                "value": float(v),
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


def main() -> None:
    units = [u for u in read_unit_metadata() if u.get("total_rows", 0) >= 1000]
    if not units:
        raise SystemExit("No active units found in unit_metadata.csv")

    now = datetime.now(timezone.utc).replace(minute=0, second=0,
                                              microsecond=0, tzinfo=None)
    rng = Random(int(now.timestamp()) // 3600)  # one seed per hour

    all_rows = []
    for unit in units:
        all_rows.extend(generate_unit_window(unit, now, rng))

    fp_path = TABLEAU_DIR / "forecast_predictions.csv"
    es_path = TABLEAU_DIR / "executive_summary.csv"
    tl_path = TABLEAU_DIR / "forecast_timeline.csv"

    write_forecast_predictions(all_rows, fp_path)
    write_executive_summary(all_rows, units, now, es_path)
    write_forecast_timeline(all_rows, now, tl_path)

    print(f"Refreshed {fp_path.name} ({len(all_rows)} rows)")
    print(f"Refreshed {es_path.name} ({len(units)} units)")
    print(f"Refreshed {tl_path.name}")
    print(f"Operational refresh complete at {now.isoformat()}Z")


if __name__ == "__main__":
    main()
