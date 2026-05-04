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
    return registry


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
    rows = []

    for uid in units:
        u = filter_unit(test_feat, uid, config).sort_values(dt_col)
        if len(u) < 50:
            continue

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
                models_used[h] = None
                continue
            preds = _predict_unit_horizon(u, config, h, mp)
            base[f"pred_{h}hr"] = preds.values
            models_used[h] = name

        cap = capacity_by_unit.get(uid)
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
            "series": "Actual",
            "horizon_h": 0,
            "capacity": int(r["capacity"]),
        })
    # Forecasts: only the latest row per unit holds predictions
    fp_sorted = fp.sort_values("timestamp")
    latest_by_unit = fp_sorted.groupby("unit_id").tail(1)
    for _, r in latest_by_unit.iterrows():
        anchor_ts = pd.to_datetime(r["timestamp"])
        for h in horizons:
            v = r.get(f"pred_{h}hr")
            if v is None or pd.isna(v):
                continue
            forecast_ts = anchor_ts + pd.Timedelta(hours=h)
            rows.append({
                "timestamp": forecast_ts.strftime("%Y-%m-%d %H:%M:%S"),
                "unit_id": r["unit_id"],
                "unit_name": r["unit_name"],
                "value": round(float(v), 1),
                "series": "Forecast",
                "horizon_h": h,
                "capacity": int(r["capacity"]),
            })
    return pd.DataFrame(rows)


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


def main():
    parser = argparse.ArgumentParser(description="Nurse Unit Census Prediction Pipeline")
    parser.add_argument("--config", default="config/config.yaml", help="Path to config file")
    parser.add_argument("--phase", default="all",
                        choices=["all", "clean", "train", "export"],
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

    if args.phase in ("all", "export"):
        phase_export(train, val, test, config)

    elapsed = time.time() - start
    logger.info("=" * 60)
    logger.info("Pipeline complete in %.1f minutes", elapsed / 60)
    logger.info("=" * 60)


if __name__ == "__main__":
    main()
