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

import joblib
import numpy as np
import pandas as pd

from src.evaluation import asymmetric_quantiles, conformal_halfwidth
from src.evaluation.intervals import build_interval, empirical_coverage
from src.features import add_cyclical_features, filter_unit, prepare_ml_features
from src.monitoring.drift import build_psi_bins

logger = logging.getLogger(__name__)

INTERVALS_FILENAME = "intervals.json"
BASELINE_FILENAME = "drift_baseline.json"


def _deployed_model_path(models_dir: Path, uid, h: int) -> tuple[str, Path]:
    """Match run_pipeline._model_path_for_horizon: RF at 1h, LightGBM otherwise."""
    name = "randomforest" if h == 1 else "lightgbm"
    return name, models_dir / str(uid) / f"{name}_{h}h.joblib"


def compute_prediction_intervals(
    val_df: pd.DataFrame, config: dict, coverage: float = 0.90,
) -> dict:
    """
    For each (unit, horizon), run the deployed model on the validation set,
    collect residuals, and derive split-conformal interval parameters.

    Returns {unit_id(str): {horizon(str): {halfwidth, q_lower, q_upper,
             coverage, n, val_coverage}}}.
    """
    unit_col = config["data"]["unit_col"]
    horizons = config["forecast_horizons"]
    models_dir = Path(config["output"]["models_dir"])

    val_feat = add_cyclical_features(val_df)
    units = sorted(val_df[unit_col].unique())
    intervals: dict[str, dict] = {}

    for uid in units:
        u_val = filter_unit(val_feat, uid, config)
        per_h: dict[str, dict] = {}
        for h in horizons:
            _, mp = _deployed_model_path(models_dir, uid, h)
            if not mp.exists():
                continue
            X_va, y_va, _ = prepare_ml_features(u_val, config, h)
            if len(X_va) < 20:
                continue
            model = joblib.load(mp)
            preds = model.predict(X_va)
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
    df["_deployed"] = np.where(df["horizon"] == 1, "RandomForest", "LightGBM")
    deployed = df[df["model"] == df["_deployed"]]
    out = (
        deployed.groupby("unit_id")["within_2_patients_pct"].mean().round(2).to_dict()
    )
    return {str(k): float(v) for k, v in out.items()}


def compute_drift_baseline(train_df: pd.DataFrame, config: dict, n_bins: int = 10) -> dict:
    """
    Freeze the training-window census distribution per unit as the PSI baseline,
    plus the per-unit baseline within-2 accuracy for performance drift.

    Returns {unit_id(str): {edges, expected_props, within_2_patients_pct,
             n, mean_census}}.
    """
    unit_col = config["data"]["unit_col"]
    census_col = config["data"]["census_col"]
    within2 = _baseline_within2_by_unit(config)

    baseline: dict[str, dict] = {}
    for uid, grp in train_df.groupby(unit_col):
        census = grp[census_col].dropna().to_numpy(dtype=float)
        if census.size < n_bins:
            continue
        edges = build_psi_bins(census, n_bins=n_bins)
        counts, _ = np.histogram(census, bins=edges)
        total = counts.sum()
        expected_props = (counts / total) if total else np.zeros(len(edges) - 1)
        baseline[str(uid)] = {
            "edges": [float(e) for e in edges],
            "expected_props": [float(p) for p in expected_props],
            "within_2_patients_pct": within2.get(str(uid), float("nan")),
            "n": int(census.size),
            "mean_census": round(float(np.mean(census)), 2),
        }
    logger.info("Drift baseline computed for %d units", len(baseline))
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
