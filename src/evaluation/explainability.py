"""
Feature-importance extraction for the deployed tabular models.

The pipeline ships per-(unit, horizon) Random Forest and LightGBM models that
expose `feature_importances_`, so a clinician or auditor can see which
features actually drive a given unit's forecast at a given horizon. This
module turns those raw importance arrays into a stable, ranked, named view
ready to publish to a dashboard.
"""

from pathlib import Path

import joblib
import numpy as np
import pandas as pd


def extract_feature_importance(model, feature_names: list[str]) -> list[dict]:
    """Return [{feature, importance, rank}, ...] sorted descending by importance.

    Falls back to positional names (`feature_0`, `feature_1`, ...) when the
    supplied feature_names length does not match the model's importance vector,
    so a schema mismatch never silently produces wrong labels.
    """
    if not hasattr(model, "feature_importances_"):
        return []
    importances = np.asarray(model.feature_importances_, dtype=float)
    if len(feature_names) != len(importances):
        feature_names = [f"feature_{i}" for i in range(len(importances))]
    order = np.argsort(-importances)
    out = []
    for rank, idx in enumerate(order, start=1):
        out.append({
            "feature": feature_names[int(idx)],
            "importance": float(importances[int(idx)]),
            "rank": int(rank),
        })
    return out


def _deployed_model_path(models_dir: Path, uid, h: int) -> tuple[str, Path]:
    """Match the export's deployed model selection: RF at 1h, LightGBM elsewhere."""
    name = "randomforest" if h == 1 else "lightgbm"
    return name, models_dir / str(uid) / f"{name}_{h}h.joblib"


def compute_feature_importance_table(config: dict) -> pd.DataFrame:
    """Walk every (unit, horizon) with a saved deployed model and return a
    long-format DataFrame of per-feature importance.

    Columns: unit_id, unit_name, horizon, model, feature, importance, rank.
    Units without a trained model directory are skipped. Pure inference on
    saved models; no training data required.
    """
    from src.features import get_feature_columns

    models_dir = Path(config["output"]["models_dir"])
    horizons = config["forecast_horizons"]
    unit_names = config.get("unit_names", {})

    if not models_dir.exists():
        return pd.DataFrame()

    unit_ids = []
    for child in models_dir.iterdir():
        if child.is_dir() and child.name.isdigit():
            unit_ids.append(int(child.name))
    unit_ids = sorted(unit_ids)

    rows = []
    for uid in unit_ids:
        for h in horizons:
            name, mp = _deployed_model_path(models_dir, uid, h)
            if not mp.exists():
                continue
            try:
                model = joblib.load(mp)
            except Exception:
                continue
            feature_names = get_feature_columns(config, h)
            for entry in extract_feature_importance(model, feature_names):
                rows.append({
                    "unit_id": uid,
                    "unit_name": unit_names.get(uid, f"Unit {uid}"),
                    "horizon": h,
                    "model": name,
                    "feature": entry["feature"],
                    "importance": round(entry["importance"], 6),
                    "rank": entry["rank"],
                })
    return pd.DataFrame(rows)
