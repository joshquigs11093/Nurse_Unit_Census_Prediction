"""
Calibration step: derive prediction intervals and a drift baseline from the
already-trained models and persist them alongside the model artifacts.

Runs after training without retraining. Loads the deployed tabular models
(Random Forest at 1h, LightGBM elsewhere), runs them on the validation set to
collect residuals for the intervals, and freezes a training-window census
distribution for PSI.
"""

import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd

from src.evaluation import asymmetric_quantiles, conformal_halfwidth
from src.evaluation.intervals import build_interval, empirical_coverage
from src.features import add_cyclical_features, filter_unit
from src.models.deployment import (
    deployed_display_by_horizon,
    predict_eval,
    select_deployed_models,
)
from src.monitoring.drift import build_psi_bins, stl_residual_series

logger = logging.getLogger(__name__)

INTERVALS_FILENAME = "intervals.json"
EXPORT_INTERVALS_FILENAME = "prediction_intervals.json"
BASELINE_FILENAME = "drift_baseline.json"


def compute_prediction_intervals(
    val_df: pd.DataFrame, config: dict, coverage: float = 0.90,
) -> dict:
    """
    For each (unit, horizon), run the *served* model (RF/LightGBM/LSTM per the
    leaderboard) on the validation set, collect residuals, and derive
    split-conformal interval parameters. Serving the LSTM at a horizon therefore
    calibrates that horizon's band on LSTM residuals, not LightGBM's.

    Returns {unit_id(str): {horizon(str): {halfwidth, q_lower, q_upper,
             coverage, n, val_coverage}}}.
    """
    unit_col = config["data"]["unit_col"]
    horizons = config["forecast_horizons"]
    models_dir = Path(config["output"]["models_dir"])
    deployed = select_deployed_models(config)

    val_feat = add_cyclical_features(val_df)
    units = sorted(val_df[unit_col].unique())
    intervals: dict[str, dict] = {}

    for uid in units:
        u_val = filter_unit(val_feat, uid, config)
        per_h: dict[str, dict] = {}
        for h in horizons:
            y_va, preds = predict_eval(u_val, config, h, deployed[h], models_dir, uid)
            if len(y_va) < 20:
                continue
            residuals = np.asarray(y_va, dtype=float) - np.asarray(preds, dtype=float)

            hw = conformal_halfwidth(residuals, coverage=coverage)
            q_lo, q_hi = asymmetric_quantiles(residuals, coverage=coverage)
            lower, upper = build_interval(preds, hw, lower_bound=0.0)
            val_cov = empirical_coverage(y_va, lower, upper)

            per_h[str(h)] = {
                "halfwidth": round(hw, 4),
                "q_lower": round(q_lo, 4),
                "q_upper": round(q_hi, 4),
                "coverage": coverage,
                "n": int(len(residuals)),
                "val_coverage": round(val_cov, 4),
            }
        if per_h:
            intervals[str(uid)] = per_h
            logger.info("Intervals for unit %s: %d horizons calibrated", uid, len(per_h))

    return intervals


def _baseline_within2_by_unit(config: dict) -> dict:
    """
    Per-unit baseline within-2 accuracy for the deployed models, read from the
    training run's model_comparison.csv. Averages the deployed model's
    within-2 across horizons. Returns {unit_id(str): pct} (may be empty).
    """
    reports_dir = Path(config["output"]["reports_dir"])
    comp_path = reports_dir / "model_comparison.csv"
    if not comp_path.exists():
        logger.warning("model_comparison.csv not found; baseline accuracy omitted")
        return {}

    df = pd.read_csv(comp_path)
    disp_by_h = deployed_display_by_horizon(config)
    df["_deployed"] = df["horizon"].map(disp_by_h)
    deployed = df[df["model"] == df["_deployed"]]
    out = (
        deployed.groupby("unit_id")["within_2_patients_pct"].mean().round(2).to_dict()
    )
    return {str(k): float(v) for k, v in out.items()}


def compute_drift_baseline(train_df: pd.DataFrame, config: dict,
                            n_bins: int = 10, stl_period: int = 168) -> dict:
    """
    Freeze the training-window census distribution per unit as the PSI baseline,
    plus the per-unit baseline within-2 accuracy for performance drift and a
    second baseline built from STL residuals so the deseasoned drift signal
    can be tracked separately.

    Returns {unit_id(str): {edges, expected_props, within_2_patients_pct,
             n, mean_census, residual_edges, residual_expected_props}}.
    """
    unit_col = config["data"]["unit_col"]
    census_col = config["data"]["census_col"]
    dt_col = config["data"]["datetime_col"]
    within2 = _baseline_within2_by_unit(config)

    baseline: dict[str, dict] = {}
    for uid, grp in train_df.groupby(unit_col):
        grp = grp.sort_values(dt_col)
        census = grp[census_col].dropna().to_numpy(dtype=float)
        if census.size < n_bins:
            continue
        edges = build_psi_bins(census, n_bins=n_bins)
        counts, _ = np.histogram(census, bins=edges)
        total = counts.sum()
        expected_props = (counts / total) if total else np.zeros(len(edges) - 1)

        residuals = stl_residual_series(census, period=stl_period)
        residuals = residuals[~np.isnan(residuals)]
        if residuals.size >= n_bins:
            res_edges = build_psi_bins(residuals, n_bins=n_bins)
            res_counts, _ = np.histogram(residuals, bins=res_edges)
            res_total = res_counts.sum()
            res_props = (res_counts / res_total) if res_total else np.zeros(len(res_edges) - 1)
        else:
            res_edges = edges
            res_props = expected_props

        baseline[str(uid)] = {
            "edges": [float(e) for e in edges],
            "expected_props": [float(p) for p in expected_props],
            "residual_edges": [float(e) for e in res_edges],
            "residual_expected_props": [float(p) for p in res_props],
            "within_2_patients_pct": within2.get(str(uid), float("nan")),
            "n": int(census.size),
            "mean_census": round(float(np.mean(census)), 2),
        }
    logger.info("Drift baseline computed for %d units (with STL residual baseline)",
                len(baseline))
    return baseline


def save_intervals(intervals: dict, config: dict) -> Path:
    """Persist per-unit intervals to models/{uid}/intervals.json."""
    models_dir = Path(config["output"]["models_dir"])
    for uid, per_h in intervals.items():
        unit_dir = models_dir / str(uid)
        unit_dir.mkdir(parents=True, exist_ok=True)
        with open(unit_dir / INTERVALS_FILENAME, "w") as f:
            json.dump(per_h, f, indent=2)
    return models_dir


def save_intervals_export(intervals: dict, config: dict) -> Path:
    """Persist a consolidated copy of the calibrated intervals to
    outputs/tableau/prediction_intervals.json.

    Lives under the tableau exports (half-widths and coverage only, no PHI) so
    it is committed and available to the daily synthetic refresh, which has no
    access to the trained models under models/."""
    out_dir = Path(config["output"]["tableau_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / EXPORT_INTERVALS_FILENAME
    with open(path, "w") as f:
        json.dump(intervals, f, indent=2)
    logger.info("Saved calibrated intervals to %s", path)
    return path


def save_drift_baseline(baseline: dict, config: dict) -> Path:
    """Persist the drift baseline to outputs/tableau/drift_baseline.json.

    Lives under the tableau exports (aggregate distribution bins, no PHI) so it
    is committed and available to the daily synthetic refresh, which recomputes
    PSI without access to the trained models.
    """
    out_dir = Path(config["output"]["tableau_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / BASELINE_FILENAME
    with open(path, "w") as f:
        json.dump(baseline, f, indent=2)
    logger.info("Saved drift baseline to %s", path)
    return path


def load_intervals(uid, config: dict) -> dict:
    """Load intervals.json for a unit; returns {} if absent."""
    path = Path(config["output"]["models_dir"]) / str(uid) / INTERVALS_FILENAME
    if not path.exists():
        return {}
    with open(path) as f:
        return json.load(f)


def load_drift_baseline(config: dict) -> dict:
    """Load drift_baseline.json from the tableau exports; returns {} if absent."""
    path = Path(config["output"]["tableau_dir"]) / BASELINE_FILENAME
    if not path.exists():
        return {}
    with open(path) as f:
        return json.load(f)
