"""
Main pipeline script for Nurse Unit Census Prediction.

Usage:
    python run_pipeline.py [--config CONFIG] [--phase PHASE]

Phases:
    all       - Run entire pipeline (default)
    clean     - Data loading and cleaning only
    train     - Model training and evaluation
    export    - Export results for Tableau
"""

import argparse
import logging
import math
import shutil
import sys
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from src.utils import load_config, setup_logging, set_random_seeds
from src.data import load_raw_data, validate_data, clean_data, split_data, save_processed_data
from src.features import add_cyclical_features, filter_unit, get_feature_columns
from src.models import ModelRegistry
from src.evaluation.explainability import compute_feature_importance_table
from src.monitoring.calibrate import (
    compute_drift_baseline,
    compute_prediction_intervals,
    load_drift_baseline,
    load_intervals,
    save_drift_baseline,
    save_intervals,
)
from src.monitoring.drift import generate_drift_report
from src.monitoring.equity import compute_unit_equity

logger = logging.getLogger(__name__)


def phase_clean(config: dict) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Load, validate, clean, and split data."""
    logger.info("=" * 60)
    logger.info("PHASE: Data Loading & Cleaning")
    logger.info("=" * 60)

    df = load_raw_data(config)
    report = validate_data(df, config)

    logger.info("Validation: missing_cols=%s, dupes=%d, continuity_gaps=%s",
                report["missing_expected_columns"],
                report["duplicate_unit_timestamp_pairs"],
                {uid: v["missing_hours"] for uid, v in report["continuity"].items()
                 if v["missing_hours"] > 0})

    df = clean_data(df, config)
    train, val, test = split_data(df, config)
    save_processed_data(train, val, test, config, validation_report=report)
    return train, val, test


def phase_train(
    train: pd.DataFrame, val: pd.DataFrame, config: dict,
) -> ModelRegistry:
    """Train all models per unit per horizon, evaluate on validation set."""
    logger.info("=" * 60)
    logger.info("PHASE: Model Training (per-unit, per-horizon)")
    logger.info("=" * 60)

    registry = ModelRegistry(config)
    registry.train_all(train, val)
    registry.export_results()
    registry.export_diagnostics()
    # Also publish diagnostics to the tracked tableau dir so the site/deliverable
    # can read them (outputs/reports is gitignored working scratch).
    registry.export_diagnostics(config["output"]["tableau_dir"])
    return registry


def phase_calibrate(
    train: pd.DataFrame, val: pd.DataFrame, config: dict,
) -> None:
    """Derive prediction intervals + drift baseline from trained models."""
    logger.info("=" * 60)
    logger.info("PHASE: Calibration (prediction intervals + drift baseline)")
    logger.info("=" * 60)

    if config.get("uncertainty", {}).get("enabled", True):
        coverage = config.get("uncertainty", {}).get("coverage", 0.95)
        intervals = compute_prediction_intervals(val, config, coverage=coverage)
        save_intervals(intervals, config)
        logger.info("Calibrated intervals for %d units (coverage=%.0f%%)",
                    len(intervals), coverage * 100)

    if config.get("drift", {}).get("enabled", True):
        n_bins = config.get("drift", {}).get("psi_bins", 10)
        baseline = compute_drift_baseline(train, config, n_bins=n_bins)
        save_drift_baseline(baseline, config)

    # Feature-importance export: which features drive each unit's forecast.
    fi = compute_feature_importance_table(config)
    if not fi.empty:
        out_dir = Path(config["output"]["tableau_dir"])
        out_dir.mkdir(parents=True, exist_ok=True)
        fi_path = out_dir / "feature_importance.csv"
        fi.to_csv(fi_path, index=False)
        logger.info("Exported feature_importance.csv (%d rows, %d units, %d horizons)",
                    len(fi), fi["unit_id"].nunique(), fi["horizon"].nunique())


def _model_path_for_horizon(models_dir: Path, uid, h: int) -> tuple[str, Path]:
    """Pick best tabular model for horizon h: RF at 1h, LightGBM otherwise."""
    name = "randomforest" if h == 1 else "lightgbm"
    return name, models_dir / str(uid) / f"{name}_{h}h.joblib"


def _predict_unit_horizon(u_test_feat: pd.DataFrame, config: dict, horizon: int,
                           model_path: Path) -> pd.Series:
    """Run a saved tabular model on test rows for one unit. Returns a Series
    aligned to u_test_feat.index with NaN where features are missing."""
    feature_cols = [c for c in get_feature_columns(config, horizon)
                    if c in u_test_feat.columns]
    feat_df = u_test_feat[feature_cols]
    valid_mask = feat_df.notna().all(axis=1)
    out = pd.Series(np.nan, index=u_test_feat.index, dtype=float)
    if valid_mask.sum() == 0:
        return out
    model = joblib.load(model_path)
    preds = model.predict(feat_df.loc[valid_mask])
    out.loc[valid_mask] = np.round(preds, 1)
    return out


def _build_forecast_predictions(test: pd.DataFrame, config: dict,
                                 capacity_by_unit: dict) -> pd.DataFrame:
    """Wide-format per-(timestamp, unit) predictions for Dashboard 1."""
    dt_col = config["data"]["datetime_col"]
    unit_col = config["data"]["unit_col"]
    census_col = config["data"]["census_col"]
    horizons = config["forecast_horizons"]
    models_dir = Path(config["output"]["models_dir"])
    unit_names = config.get("unit_names", {})

    test_feat = add_cyclical_features(test)
    units = sorted(test[unit_col].unique())
    intervals_on = config.get("uncertainty", {}).get("enabled", True)
    rows = []

    for uid in units:
        u = filter_unit(test_feat, uid, config).sort_values(dt_col)
        if len(u) < 50:
            continue

        unit_intervals = load_intervals(uid, config) if intervals_on else {}
        cap = capacity_by_unit.get(uid)

        base = pd.DataFrame({
            "timestamp": u[dt_col].values,
            "unit_id": uid,
            "unit_name": unit_names.get(uid, f"Unit {uid}"),
            "actual_census": u[census_col].astype(int).values,
        })

        models_used = {}
        for h in horizons:
            name, mp = _model_path_for_horizon(models_dir, uid, h)
            if not mp.exists():
                base[f"pred_{h}hr"] = np.nan
                base[f"pred_{h}hr_lower"] = np.nan
                base[f"pred_{h}hr_upper"] = np.nan
                models_used[h] = None
                continue
            preds = _predict_unit_horizon(u, config, h, mp)
            base[f"pred_{h}hr"] = preds.values

            hw = unit_intervals.get(str(h), {}).get("halfwidth")
            if hw is not None and not pd.isna(hw):
                lower = (preds - hw).clip(lower=0.0)
                upper = preds + hw
                if cap is not None:
                    upper = upper.clip(upper=float(cap))
                base[f"pred_{h}hr_lower"] = lower.round(1).values
                base[f"pred_{h}hr_upper"] = upper.round(1).values
            else:
                base[f"pred_{h}hr_lower"] = np.nan
                base[f"pred_{h}hr_upper"] = np.nan
            models_used[h] = name

        base["capacity"] = cap
        for h in horizons:
            col = f"pred_{h}hr"
            base[f"over_capacity_{h}hr"] = (
                (base[col] >= cap).astype("Int64") if cap is not None else pd.NA
            )
        rows.append(base)

    if not rows:
        return pd.DataFrame()
    out = pd.concat(rows, ignore_index=True)
    return out


def _build_forecast_timeline(fp: pd.DataFrame, horizons: list[int]) -> pd.DataFrame:
    """Long-format timeline. One row per actual census reading + one row per
    forecast point at its forward timestamp. Column schema:
      timestamp, unit_id, unit_name, value, series, horizon_h, capacity
    """
    rows = []
    # Actuals
    for _, r in fp.iterrows():
        rows.append({
            "timestamp": r["timestamp"],
            "unit_id": r["unit_id"],
            "unit_name": r["unit_name"],
            "value": int(r["actual_census"]),
            "value_lower": int(r["actual_census"]),
            "value_upper": int(r["actual_census"]),
            "series": "Actual",
            "horizon_h": 0,
            "capacity": int(r["capacity"]),
        })
    # Forecasts anchor on the latest row per unit that actually has predictions.
    # On real data the final rows can lack forward-looking features (e.g. future
    # scheduled-surgery windows), leaving their predictions NaN, so the absolute
    # last row is not a safe anchor.
    fp_sorted = fp.sort_values("timestamp")
    fp_pred = fp_sorted[fp_sorted["pred_1hr"].notna()]
    latest_by_unit = (fp_pred if not fp_pred.empty else fp_sorted).groupby("unit_id").tail(1)
    for _, r in latest_by_unit.iterrows():
        anchor_ts = pd.to_datetime(r["timestamp"])
        for h in horizons:
            v = r.get(f"pred_{h}hr")
            if v is None or pd.isna(v):
                continue
            lo = r.get(f"pred_{h}hr_lower")
            hi = r.get(f"pred_{h}hr_upper")
            forecast_ts = anchor_ts + pd.Timedelta(hours=h)
            rows.append({
                "timestamp": forecast_ts.strftime("%Y-%m-%d %H:%M:%S"),
                "unit_id": r["unit_id"],
                "unit_name": r["unit_name"],
                "value": round(float(v), 1),
                "value_lower": (round(float(lo), 1) if lo is not None
                                and not pd.isna(lo) else round(float(v), 1)),
                "value_upper": (round(float(hi), 1) if hi is not None
                                and not pd.isna(hi) else round(float(v), 1)),
                "series": "Forecast",
                "horizon_h": h,
                "capacity": int(r["capacity"]),
            })
    return pd.DataFrame(rows)


def _recent_window_drift_inputs(test: pd.DataFrame, config: dict) -> tuple[dict, dict]:
    """Census array + observed within-2 accuracy per unit over the recent live
    window, for the drift report. Mirrors validation eval on recent test rows."""
    from src.evaluation import compute_within_n
    from src.features import prepare_ml_features

    dt_col = config["data"]["datetime_col"]
    unit_col = config["data"]["unit_col"]
    census_col = config["data"]["census_col"]
    horizons = config["forecast_horizons"]
    models_dir = Path(config["output"]["models_dir"])
    window = config.get("drift", {}).get("recent_window_hours", 168)

    test_feat = add_cyclical_features(test)
    recent_census, recent_within2 = {}, {}

    for uid in sorted(test[unit_col].unique()):
        u = filter_unit(test_feat, uid, config).sort_values(dt_col).tail(window)
        if u.empty:
            continue
        recent_census[str(uid)] = u[census_col].dropna().to_numpy(dtype=float)

        accs = []
        for h in horizons:
            _, mp = _model_path_for_horizon(models_dir, uid, h)
            if not mp.exists():
                continue
            X, y, _ = prepare_ml_features(u, config, h)
            if len(X) < 10:
                continue
            preds = joblib.load(mp).predict(X)
            accs.append(compute_within_n(np.asarray(y, dtype=float), preds, n=2))
        if accs:
            recent_within2[str(uid)] = float(np.mean(accs))

    return recent_census, recent_within2


def _build_drift_history(test: pd.DataFrame, config: dict, baseline: dict,
                          step_days: int = 7) -> pd.DataFrame:
    """PSI trajectory per unit across the test period, with seasonality-aware
    signals layered on top of the raw PSI.

    For each as-of date the function records both the raw PSI (recent census
    vs. frozen baseline) and a deseasoned PSI computed on STL residuals,
    along with a per-unit persistence counter and a per-as_of systemic
    fraction. The combination is what separates a one-off seasonal spike from
    sustained, unit-specific drift.
    """
    from src.monitoring.drift import (
        PSI_MAJOR, derive_alert_kind, drift_status, psi_from_baseline,
        stl_residual_series,
    )

    dt_col = config["data"]["datetime_col"]
    unit_col = config["data"]["unit_col"]
    census_col = config["data"]["census_col"]
    drift_cfg = config.get("drift", {})
    window = pd.Timedelta(hours=drift_cfg.get("recent_window_hours", 168))
    psi_bins = drift_cfg.get("psi_bins", 10)
    stl_period = drift_cfg.get("stl_period", 168)
    persistence_threshold = drift_cfg.get("persistence_threshold", 3)
    systemic_threshold = drift_cfg.get("systemic_threshold", 0.5)
    unit_names = config.get("unit_names", {})

    ts_all = pd.to_datetime(test[dt_col])
    start, end = ts_all.min() + window, ts_all.max()
    if pd.isna(start) or start >= end:
        return pd.DataFrame()
    as_of_dates = pd.date_range(start=start, end=end, freq=f"{step_days}D")

    # Pre-compute the STL residual series per unit (once each) so the as-of
    # loop only has to slice rather than re-decompose.
    residual_by_unit: dict = {}
    for uid in sorted(test[unit_col].unique()):
        u = test[test[unit_col] == uid].sort_values(dt_col)
        census = u[census_col].to_numpy(dtype=float)
        residuals = stl_residual_series(census, period=stl_period)
        if residuals.size == census.size:
            residual_by_unit[uid] = pd.Series(
                residuals, index=pd.to_datetime(u[dt_col]).to_numpy())

    rows = []
    for uid in sorted(test[unit_col].unique()):
        b = baseline.get(str(uid))
        if not b:
            continue
        edges = np.asarray(b["edges"], dtype=float)
        expected_props = np.asarray(b["expected_props"], dtype=float)
        res_edges = np.asarray(b.get("residual_edges", b["edges"]), dtype=float)
        res_props = np.asarray(
            b.get("residual_expected_props", b["expected_props"]), dtype=float)

        u = test[test[unit_col] == uid]
        u_ts = pd.to_datetime(u[dt_col])
        resid_series = residual_by_unit.get(uid)
        name = unit_names.get(uid, f"Unit {uid}")

        for as_of in as_of_dates:
            mask = (u_ts > as_of - window) & (u_ts <= as_of)
            census = u.loc[mask.values, census_col].dropna().to_numpy(dtype=float)
            if census.size < psi_bins:
                continue
            psi = psi_from_baseline(census, edges, expected_props)

            psi_residual = float("nan")
            if resid_series is not None:
                res_window = resid_series[
                    (resid_series.index > (as_of - window).to_datetime64())
                    & (resid_series.index <= as_of.to_datetime64())
                ].dropna().to_numpy()
                if res_window.size >= psi_bins:
                    psi_residual = psi_from_baseline(res_window, res_edges, res_props)

            rows.append({
                "as_of": as_of.strftime("%Y-%m-%d"),
                "unit_id": uid,
                "unit_name": name,
                "psi": round(psi, 4),
                "psi_residual": round(psi_residual, 4) if not np.isnan(psi_residual)
                                else float("nan"),
                "drift_status": drift_status(psi),
                "source": "test",
            })

    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)

    # Alerts run on the deseasoned residual PSI when available so a flu-season
    # spike (which lifts raw PSI but not the residual) does not trip a retrain
    # alert; raw PSI is the fallback when STL had too little data.
    alert_signal = df["psi_residual"].where(df["psi_residual"].notna(), df["psi"])
    in_major = alert_signal >= PSI_MAJOR

    # systemic_fraction per as_of: how many units are simultaneously in major.
    systemic = (pd.DataFrame({"as_of": df["as_of"], "_major": in_major})
                  .groupby("as_of")["_major"].mean())
    df["systemic_fraction"] = df["as_of"].map(systemic).round(3)

    # consecutive_major counter per unit across the chronological as_of sequence.
    df = df.sort_values(["unit_id", "as_of"]).reset_index(drop=True)
    alert_signal = df["psi_residual"].where(df["psi_residual"].notna(), df["psi"])
    in_major = alert_signal >= PSI_MAJOR
    counters: dict = {}
    consec_col = []
    for uid, flag in zip(df["unit_id"], in_major):
        counters[uid] = counters.get(uid, 0) + 1 if flag else 0
        consec_col.append(counters[uid])
    df["consecutive_major"] = consec_col

    df["alert_kind"] = [
        derive_alert_kind(
            in_major=bool(im),
            consecutive_major=int(c),
            systemic_fraction=float(s) if pd.notna(s) else float("nan"),
            persistence_threshold=persistence_threshold,
            systemic_threshold=systemic_threshold,
        )
        for im, c, s in zip(in_major, df["consecutive_major"], df["systemic_fraction"])
    ]
    return df


def phase_export(
    train: pd.DataFrame,
    val: pd.DataFrame,
    test: pd.DataFrame,
    config: dict,
) -> None:
    """Export Tableau-ready CSVs."""
    logger.info("=" * 60)
    logger.info("PHASE: Tableau Data Export")
    logger.info("=" * 60)

    dt_col = config["data"]["datetime_col"]
    unit_col = config["data"]["unit_col"]
    census_col = config["data"]["census_col"]
    horizons = config["forecast_horizons"]
    tableau_dir = Path(config["output"]["tableau_dir"])
    tableau_dir.mkdir(parents=True, exist_ok=True)
    reports_dir = Path(config["output"]["reports_dir"])

    # 1. model_performance.csv + model_performance_aggregated.csv (from training results)
    comp_path = reports_dir / "model_comparison.csv"
    if comp_path.exists():
        pd.read_csv(comp_path).to_csv(tableau_dir / "model_performance.csv", index=False)
        logger.info("Exported model_performance.csv")

    agg_path = reports_dir / "model_comparison_aggregated.csv"
    if agg_path.exists():
        pd.read_csv(agg_path).to_csv(
            tableau_dir / "model_performance_aggregated.csv", index=False
        )

    # 2. best_model_per_horizon.csv (copied for Tableau access)
    best_path = reports_dir / "best_model_per_horizon.csv"
    if best_path.exists():
        shutil.copy(best_path, tableau_dir / "best_model_per_horizon.csv")
        logger.info("Exported best_model_per_horizon.csv")

    # 3. unit_metadata.csv (with derived capacity = max observed census)
    all_data = pd.concat([train, val, test])
    unit_names = config.get("unit_names", {})
    meta_rows = []
    capacity_by_unit = {}
    for uid, grp in all_data.groupby(unit_col):
        max_c = int(grp[census_col].max())
        capacity_by_unit[uid] = max_c
        meta_rows.append({
            "unit_id": uid,
            "unit_name": unit_names.get(uid, f"Unit {uid}"),
            "capacity": max_c,
            "mean_census": round(grp[census_col].mean(), 1),
            "median_census": round(grp[census_col].median(), 1),
            "min_census": int(grp[census_col].min()),
            "max_census": max_c,
            "std_census": round(grp[census_col].std(), 2),
            "total_rows": len(grp),
        })
    pd.DataFrame(meta_rows).to_csv(tableau_dir / "unit_metadata.csv", index=False)
    logger.info("Exported unit_metadata.csv (%d units, capacity = max observed census)",
                len(meta_rows))

    # 4. forecast_predictions.csv (wide; one row per timestamp per unit)
    fp = _build_forecast_predictions(test, config, capacity_by_unit)
    if not fp.empty:
        fp.to_csv(tableau_dir / "forecast_predictions.csv", index=False)
        logger.info("Exported forecast_predictions.csv (%d rows, %d units)",
                    len(fp), fp["unit_id"].nunique())
    else:
        logger.warning("forecast_predictions.csv is empty — no models loaded")

    # 4b. forecast_timeline.csv (long; purpose-built for time-series charts)
    if not fp.empty:
        timeline = _build_forecast_timeline(fp, config["forecast_horizons"])
        timeline.to_csv(tableau_dir / "forecast_timeline.csv", index=False)
        logger.info("Exported forecast_timeline.csv (%d rows: %d actuals + %d forecasts)",
                    len(timeline),
                    int((timeline["series"] == "Actual").sum()),
                    int((timeline["series"] == "Forecast").sum()))

    # 5. executive_summary.csv (current + 72h forecast + capacity utilization)
    latest_72 = test.sort_values(dt_col).groupby(unit_col).tail(72)
    summary_rows = []
    fp_latest = (
        fp.sort_values("timestamp").groupby("unit_id").tail(1)
        if not fp.empty else pd.DataFrame()
    )
    fp_latest_by_unit = (
        fp_latest.set_index("unit_id").to_dict("index") if not fp_latest.empty else {}
    )

    for uid, grp in latest_72.groupby(unit_col):
        grp = grp.sort_values(dt_col)
        latest_census = int(grp[census_col].iloc[-1])
        cap = capacity_by_unit.get(uid)
        utilization = round(latest_census / cap * 100, 1) if cap else None
        fp_row = fp_latest_by_unit.get(uid, {})
        forecast_72hr = fp_row.get("pred_72hr") if fp_row else None
        summary_rows.append({
            "unit_id": uid,
            "unit_name": unit_names.get(uid, f"Unit {uid}"),
            "latest_census": latest_census,
            "census_24h_ago": int(grp[census_col].iloc[-24]) if len(grp) >= 24 else None,
            "census_trend_72h": round(grp[census_col].diff().mean(), 2),
            "max_census_72h": int(grp[census_col].max()),
            "min_census_72h": int(grp[census_col].min()),
            "capacity": cap,
            "utilization_pct": utilization,
            "forecast_72hr": (round(forecast_72hr, 1)
                              if forecast_72hr is not None
                              and not pd.isna(forecast_72hr) else None),
            "alert_over_90pct": (utilization is not None and utilization >= 90),
        })
    pd.DataFrame(summary_rows).to_csv(tableau_dir / "executive_summary.csv", index=False)
    logger.info("Exported executive_summary.csv")

    # 6. drift_history.csv + drift_report.csv (snapshot derived from latest history).
    if config.get("drift", {}).get("enabled", True):
        from src.monitoring.drift import performance_drift
        baseline = load_drift_baseline(config)
        if not baseline:
            logger.warning("drift exports skipped — no drift_baseline.json "
                           "(run --phase calibrate first)")
        else:
            history = _build_drift_history(test, config, baseline)
            if history.empty:
                logger.warning("drift_history is empty; drift_report also skipped")
            else:
                history.to_csv(tableau_dir / "drift_history.csv", index=False)
                logger.info("Exported drift_history.csv (%d rows, %d as-of dates)",
                            len(history), history["as_of"].nunique())

                # Snapshot = latest as_of per unit, enriched with performance drift
                # and per-unit equity (fairness across units).
                latest = (history.sort_values("as_of")
                                  .groupby("unit_id", as_index=False).tail(1))
                _, recent_within2 = _recent_window_drift_inputs(test, config)
                tol = config.get("drift", {}).get("performance_tolerance_pct", 5.0)
                names_by_str = {str(k): v for k, v in unit_names.items()}

                equity_cfg = config.get("equity", {})
                unit_ids_str = [str(uid) for uid in latest["unit_id"]]
                equity_map = compute_unit_equity(
                    config, unit_ids_str,
                    nominal_coverage=config.get("uncertainty", {}).get("coverage", 0.90),
                    accuracy_gap_pct=equity_cfg.get("accuracy_gap_pct", 5.0),
                    coverage_tolerance=equity_cfg.get("coverage_tolerance", 0.05),
                ) if equity_cfg.get("enabled", True) else {}

                report_rows = []
                for _, r in latest.iterrows():
                    uid_str = str(r["unit_id"])
                    baseline_w2 = baseline.get(uid_str, {}).get(
                        "within_2_patients_pct", float("nan"))
                    recent_w2 = recent_within2.get(uid_str, float("nan"))
                    perf = performance_drift(recent_w2, baseline_w2, tolerance_pct=tol)
                    eq = equity_map.get(uid_str, {})
                    report_rows.append({
                        "unit_id": r["unit_id"],
                        "unit_name": names_by_str.get(uid_str, r["unit_name"]),
                        "psi": r["psi"],
                        "psi_residual": r["psi_residual"],
                        "drift_status": r["drift_status"],
                        "consecutive_major": int(r["consecutive_major"]),
                        "systemic_fraction": float(r["systemic_fraction"])
                                              if pd.notna(r["systemic_fraction"])
                                              else float("nan"),
                        "alert_kind": r["alert_kind"],
                        "perf_delta_pct": perf["delta_pct"],
                        "perf_degraded": perf["degraded"],
                        "accuracy_pct": eq.get("accuracy_pct", float("nan")),
                        "coverage_pct": eq.get("coverage_pct", float("nan")),
                        "accuracy_delta_from_median_pct":
                            eq.get("accuracy_delta_from_median_pct", float("nan")),
                        "equity_status": eq.get("equity_status", "served"),
                    })
                drift_df = pd.DataFrame(report_rows)
                drift_df.to_csv(tableau_dir / "drift_report.csv", index=False)
                n_true = int((drift_df["alert_kind"] == "true_drift").sum())
                n_sys = int((drift_df["alert_kind"] == "systemic").sum())
                logger.info("Exported drift_report.csv (%d units, %d true_drift, "
                            "%d systemic)", len(drift_df), n_true, n_sys)


def main():
    parser = argparse.ArgumentParser(description="Nurse Unit Census Prediction Pipeline")
    parser.add_argument("--config", default="config/config.yaml", help="Path to config file")
    parser.add_argument("--phase", default="all",
                        choices=["all", "clean", "train", "calibrate", "export"],
                        help="Pipeline phase to run")
    args = parser.parse_args()

    setup_logging()
    config = load_config(args.config)
    set_random_seeds(config.get("random_seed", 42))

    logger.info("Pipeline started — phase: %s", args.phase)
    start = time.time()

    processed_dir = Path(config["data"]["processed_dir"])

    if args.phase in ("all", "clean"):
        train, val, test = phase_clean(config)
    else:
        logger.info("Loading pre-processed data from %s", processed_dir)
        train = pd.read_parquet(processed_dir / "train.parquet")
        val = pd.read_parquet(processed_dir / "val.parquet")
        test = pd.read_parquet(processed_dir / "test.parquet")

    if args.phase in ("all", "train"):
        registry = phase_train(train, val, config)

    if args.phase in ("all", "calibrate"):
        phase_calibrate(train, val, config)

    if args.phase in ("all", "export"):
        phase_export(train, val, test, config)

    elapsed = time.time() - start
    logger.info("=" * 60)
    logger.info("Pipeline complete in %.1f minutes", elapsed / 60)
    logger.info("=" * 60)


if __name__ == "__main__":
    main()
