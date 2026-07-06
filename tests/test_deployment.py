"""
Tests for deployment-time model selection and inference (src/models/deployment.py).

Covers the fix that wires the LSTM into the served forecast: selection must
honor the validation leaderboard (best_model_per_horizon.csv) rather than the
old fixed RF@1h / LightGBM rule, and inference must dispatch the LSTM's
sequence+scaler+Torch contract alongside the tabular .joblib contract.

Run with: python -m pytest tests/test_deployment.py -v
Selection tests are data-free; inference tests need processed data + saved
models and are marked requires_data (skipped when artifacts are absent).
"""

import copy
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src.utils import load_config
from src.features import add_cyclical_features, filter_unit
from src.models.deployment import (
    default_model_for_horizon,
    deployed_display_by_horizon,
    predict_eval,
    predict_series,
    select_deployed_models,
)


@pytest.fixture(scope="module")
def base_config():
    return load_config("config/config.yaml")


def _config_with_reports(base_config, reports_dir: Path) -> dict:
    cfg = copy.deepcopy(base_config)
    cfg["output"] = dict(cfg["output"])
    cfg["output"]["reports_dir"] = str(reports_dir)
    return cfg


def _write_leaderboard(reports_dir: Path, rows: list[tuple]):
    reports_dir.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows, columns=["horizon", "model", "within_2_patients_pct", "mae"]).to_csv(
        reports_dir / "best_model_per_horizon.csv", index=False
    )


# ---------- Selection logic (data-free) ----------

class TestModelSelection:
    def test_default_rule(self):
        assert default_model_for_horizon(1) == "randomforest"
        assert default_model_for_horizon(72) == "lightgbm"

    def test_missing_leaderboard_falls_back_to_defaults(self, base_config, tmp_path):
        cfg = _config_with_reports(base_config, tmp_path / "empty")
        selected = select_deployed_models(cfg)
        assert selected[1] == "randomforest"
        assert all(selected[h] == "lightgbm" for h in cfg["forecast_horizons"] if h != 1)

    def test_lstm_winner_is_served(self, base_config, tmp_path):
        reports = tmp_path / "reports"
        _write_leaderboard(reports, [
            (1, "RandomForest", 99.7, 0.27),
            (24, "LSTM", 88.84, 1.0),
            (72, "LSTM", 87.45, 1.11),
        ])
        cfg = _config_with_reports(base_config, reports)
        selected = select_deployed_models(cfg)
        assert selected[24] == "lstm"
        assert selected[72] == "lstm"
        assert selected[1] == "randomforest"
        # A horizon absent from the leaderboard keeps its default.
        assert selected[12] == "lightgbm"

    def test_unservable_winner_falls_back(self, base_config, tmp_path):
        """A leaderboard winner the serving loop cannot execute (Prophet/ARIMA/
        Ensemble) must fall back to the tabular default, not crash."""
        reports = tmp_path / "reports"
        _write_leaderboard(reports, [
            (48, "Prophet", 80.0, 1.5),
            (72, "Ensemble", 85.0, 1.2),
        ])
        cfg = _config_with_reports(base_config, reports)
        selected = select_deployed_models(cfg)
        assert selected[48] == "lightgbm"
        assert selected[72] == "lightgbm"

    def test_display_names_round_trip(self, base_config, tmp_path):
        reports = tmp_path / "reports"
        _write_leaderboard(reports, [(1, "RandomForest", 99.7, 0.27),
                                     (72, "LSTM", 87.45, 1.11)])
        cfg = _config_with_reports(base_config, reports)
        disp = deployed_display_by_horizon(cfg)
        assert disp[1] == "RandomForest"
        assert disp[72] == "LSTM"

    def test_selection_covers_every_horizon(self, base_config):
        selected = select_deployed_models(base_config)
        assert set(selected.keys()) == set(base_config["forecast_horizons"])
        assert all(v in {"randomforest", "lightgbm", "lstm"} for v in selected.values())


# ---------- Inference dispatch (needs processed data + saved models) ----------

def _load_unit(config, split_name):
    processed = Path(config["data"]["processed_dir"]) / f"{split_name}.parquet"
    if not processed.exists():
        pytest.skip(f"{processed} not available")
    df = pd.read_parquet(processed)
    uid = sorted(df[config["data"]["unit_col"]].unique())[0]
    models_dir = Path(config["output"]["models_dir"])
    if not (models_dir / str(uid) / "lstm_72h.pt").exists():
        pytest.skip("saved LSTM artifacts not available")
    u = filter_unit(add_cyclical_features(df), uid, config).sort_values(
        config["data"]["datetime_col"])
    return u, uid, models_dir


@pytest.mark.requires_data
class TestInferenceDispatch:
    def test_lstm_series_aligned_and_valid(self, base_config):
        u, uid, models_dir = _load_unit(base_config, "test")
        preds = predict_series(u, base_config, 72, "lstm", models_dir, uid)
        # Series is aligned to the unit frame's index.
        assert preds.index.equals(u.index)
        valid = preds.dropna()
        # Losing at most seq_len (+ any NaN windows) leading rows.
        seq_len = base_config["models"]["lstm"]["sequence_length"]
        assert len(valid) > 0
        assert len(u) - len(valid) >= seq_len - 1
        # Census forecasts are non-negative and finite.
        assert (valid >= 0).all()
        assert np.isfinite(valid.to_numpy()).all()

    def test_tabular_series_aligned(self, base_config):
        u, uid, models_dir = _load_unit(base_config, "test")
        preds = predict_series(u, base_config, 12, "lightgbm", models_dir, uid)
        assert preds.index.equals(u.index)
        assert preds.notna().sum() > 0

    def test_lstm_eval_returns_matched_arrays(self, base_config):
        u, uid, models_dir = _load_unit(base_config, "val")
        y, p = predict_eval(u, base_config, 72, "lstm", models_dir, uid)
        assert y.shape == p.shape
        assert len(y) > 0
        # Predictions track actuals within a sane error band on validation.
        assert float(np.mean(np.abs(y - p))) < 5.0

    def test_missing_artifacts_return_empty(self, base_config):
        u, uid, models_dir = _load_unit(base_config, "test")
        # A unit id with no saved model yields an all-NaN series, never a crash.
        preds = predict_series(u, base_config, 72, "lstm", models_dir, uid="__missing__")
        assert preds.isna().all()
        y, p = predict_eval(u, base_config, 72, "lstm", models_dir, uid="__missing__")
        assert len(y) == 0 and len(p) == 0
