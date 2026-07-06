"""
Deployment-time model selection and inference.

Bridges the evaluation leaderboard (``best_model_per_horizon.csv``) to the
served forecast so the model that wins each horizon in validation is the one
actually run in production — including the LSTM at the horizons where it leads.

Before this module the served path was hard-coded to Random Forest at 1h and
LightGBM everywhere else, so an LSTM win (24h and 72h on the current leaderboard)
was a benchmark result only, never a serving decision. Selection now reads the
leaderboard; inference dispatches between the tabular ``.joblib`` contract and
the LSTM contract (168-step scaled sequence windows + Torch state dict).

Only models the serving loop can actually execute are eligible: Random Forest,
LightGBM, and LSTM. If the leaderboard names an unservable winner for a horizon
(ARIMA/Prophet/Ensemble — global or weight-only artifacts), that horizon falls
back to the tabular default and logs a warning.
"""

import logging
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from src.features import get_feature_columns
from src.models.lstm_model import LSTMModel

logger = logging.getLogger(__name__)

# Leaderboard uses display names; the serving loop uses artifact-prefix names.
_DISPLAY_TO_INTERNAL = {
    "randomforest": "randomforest",
    "random forest": "randomforest",
    "lightgbm": "lightgbm",
    "lstm": "lstm",
}
INTERNAL_TO_DISPLAY = {
    "randomforest": "RandomForest",
    "lightgbm": "LightGBM",
    "lstm": "LSTM",
}

# Models the served inference path can execute from saved per-horizon artifacts.
SERVABLE_MODELS = frozenset({"randomforest", "lightgbm", "lstm"})

BEST_MODEL_FILENAME = "best_model_per_horizon.csv"


def default_model_for_horizon(horizon: int) -> str:
    """The original hard-coded rule, kept as the fallback: RF at 1h, else LightGBM."""
    return "randomforest" if horizon == 1 else "lightgbm"


def select_deployed_models(config: dict) -> dict[int, str]:
    """Return ``{horizon: internal_model_name}`` for the served forecast.

    Reads ``outputs/reports/best_model_per_horizon.csv`` (written by
    ``ModelRegistry.export_results``). A horizon whose winner is servable adopts
    that winner; anything missing or unservable falls back to
    :func:`default_model_for_horizon`.
    """
    horizons = list(config["forecast_horizons"])
    selected = {h: default_model_for_horizon(h) for h in horizons}

    reports_dir = Path(config["output"]["reports_dir"])
    path = reports_dir / BEST_MODEL_FILENAME
    if not path.exists():
        logger.warning("%s not found; serving falls back to RF@1h / LightGBM",
                       path)
        return selected

    df = pd.read_csv(path)
    for _, row in df.iterrows():
        try:
            h = int(row["horizon"])
        except (TypeError, ValueError):
            continue
        if h not in selected:
            continue
        key = str(row["model"]).strip().lower()
        internal = _DISPLAY_TO_INTERNAL.get(key)
        if internal in SERVABLE_MODELS:
            selected[h] = internal
        else:
            logger.warning("Horizon %dh best model %r is not servable; "
                           "serving %s instead", h, row["model"], selected[h])
    return selected


def deployed_display_by_horizon(config: dict) -> dict[int, str]:
    """Selected model per horizon as leaderboard *display* names.

    For code that filters ``model_comparison.csv`` (which stores display names),
    e.g. calibration baselines and equity accuracy.
    """
    return {h: INTERNAL_TO_DISPLAY[name]
            for h, name in select_deployed_models(config).items()}


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------

def _tabular_model_path(models_dir: Path, uid, horizon: int, model_name: str) -> Path:
    return Path(models_dir) / str(uid) / f"{model_name}_{horizon}h.joblib"


def _lstm_paths(models_dir: Path, uid, horizon: int) -> tuple[Path, Path]:
    unit_dir = Path(models_dir) / str(uid)
    return (unit_dir / f"lstm_{horizon}h.pt",
            unit_dir / f"lstm_scaler_{horizon}h.joblib")


def _feature_cols(u_df: pd.DataFrame, config: dict, horizon: int) -> list[str]:
    return [c for c in get_feature_columns(config, horizon) if c in u_df.columns]


def _build_lstm_windows(u_df: pd.DataFrame, config: dict, horizon: int,
                        feature_cols: list[str], scaler):
    """Sliding windows for LSTM inference on one unit, matching training layout.

    For each target row ``i`` the window is the ``seq_len`` rows *before* ``i``
    (``feat[i-seq_len:i]``), identical to :func:`prepare_lstm_sequences`.
    Windows containing any NaN are skipped. Returns
    ``(X_scaled | None, positions, targets)`` where ``positions`` are the index
    labels of the target rows and ``targets`` are the (possibly-NaN) target
    values at those rows.
    """
    seq_len = config["models"]["lstm"]["sequence_length"]
    target_col = config["target_columns"][horizon]
    feat = u_df[feature_cols].to_numpy(dtype=float)
    tgt = (u_df[target_col].to_numpy(dtype=float)
           if target_col in u_df.columns else np.full(len(u_df), np.nan))
    idx = u_df.index.to_numpy()

    windows, positions, targets = [], [], []
    for i in range(seq_len, len(u_df)):
        window = feat[i - seq_len:i]
        if np.isnan(window).any():
            continue
        windows.append(window)
        positions.append(idx[i])
        targets.append(tgt[i])

    if not windows:
        return None, [], np.array([])

    X = np.asarray(windows)
    shape = X.shape
    X = scaler.transform(X.reshape(-1, shape[-1])).reshape(shape)
    return X, positions, np.asarray(targets, dtype=float)


def predict_series(u_df: pd.DataFrame, config: dict, horizon: int,
                   model_name: str, models_dir, uid) -> pd.Series:
    """Predictions for one unit/horizon aligned to ``u_df.index`` (NaN where a
    prediction cannot be made). Dispatches tabular vs LSTM by ``model_name``."""
    out = pd.Series(np.nan, index=u_df.index, dtype=float)
    feature_cols = _feature_cols(u_df, config, horizon)

    if model_name == "lstm":
        model_path, scaler_path = _lstm_paths(models_dir, uid, horizon)
        if not model_path.exists() or not scaler_path.exists():
            return out
        scaler = joblib.load(scaler_path)
        X, positions, _ = _build_lstm_windows(
            u_df, config, horizon, feature_cols, scaler)
        if X is None:
            return out
        model = LSTMModel(config, horizon).load(model_path)
        preds = model.predict(X)
        out.loc[positions] = np.round(preds, 1)
        return out

    model_path = _tabular_model_path(models_dir, uid, horizon, model_name)
    if not model_path.exists():
        return out
    feat_df = u_df[feature_cols]
    valid_mask = feat_df.notna().all(axis=1)
    if valid_mask.sum() == 0:
        return out
    preds = joblib.load(model_path).predict(feat_df.loc[valid_mask])
    out.loc[valid_mask] = np.round(preds, 1)
    return out


def predict_eval(u_df: pd.DataFrame, config: dict, horizon: int,
                 model_name: str, models_dir, uid) -> tuple[np.ndarray, np.ndarray]:
    """Return ``(y_true, y_pred)`` for one unit/horizon using the served model,
    for residual/accuracy computation (calibration, drift). Rows with a missing
    target or missing features are dropped, matching ``prepare_ml_features``."""
    feature_cols = _feature_cols(u_df, config, horizon)
    target_col = config["target_columns"][horizon]
    empty = (np.array([]), np.array([]))

    if model_name == "lstm":
        model_path, scaler_path = _lstm_paths(models_dir, uid, horizon)
        if not model_path.exists() or not scaler_path.exists():
            return empty
        scaler = joblib.load(scaler_path)
        X, _, targets = _build_lstm_windows(
            u_df, config, horizon, feature_cols, scaler)
        if X is None:
            return empty
        model = LSTMModel(config, horizon).load(model_path)
        preds = model.predict(X)
        mask = ~np.isnan(targets)
        return targets[mask], preds[mask]

    model_path = _tabular_model_path(models_dir, uid, horizon, model_name)
    if not model_path.exists():
        return empty
    subset = u_df[feature_cols + [target_col]].dropna()
    if subset.empty:
        return empty
    preds = joblib.load(model_path).predict(subset[feature_cols])
    return subset[target_col].to_numpy(dtype=float), np.asarray(preds, dtype=float)
