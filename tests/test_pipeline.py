"""
Pipeline validation tests for the census prediction project.

Run with: python -m pytest tests/test_pipeline.py -v
"""

import numpy as np
import pandas as pd
import pytest

from src.utils import load_config
from src.data import load_raw_data, clean_data, split_data
from src.features import (
    add_cyclical_features, filter_unit, get_feature_columns, prepare_ml_features,
)
from src.evaluation import (
    compute_mae, compute_rmse, compute_mape, compute_within_n, evaluate_model,
)


@pytest.fixture(scope="module")
def config():
    return load_config("config/config.yaml")


@pytest.fixture(scope="module")
def raw_data(config):
    return load_raw_data(config)


@pytest.fixture(scope="module")
def clean_df(raw_data, config):
    return clean_data(raw_data, config)


@pytest.fixture(scope="module")
def splits(clean_df, config):
    return split_data(clean_df, config)


@pytest.fixture(scope="module")
def single_unit_train(splits, config):
    """Return train data for a single unit with cyclical features."""
    train = splits[0]
    uid = sorted(train[config["data"]["unit_col"]].unique())[0]
    return add_cyclical_features(filter_unit(train, uid, config))


@pytest.fixture(scope="module")
def single_unit_val(splits, config):
    """Return val data for a single unit with cyclical features."""
    val = splits[1]
    uid = sorted(val[config["data"]["unit_col"]].unique())[0]
    return add_cyclical_features(filter_unit(val, uid, config))


# ---------- Test 1: Data loading ----------

@pytest.mark.requires_data
class TestDataLoading:
    def test_shape(self, raw_data):
        assert raw_data.shape[0] > 100_000
        assert raw_data.shape[1] >= 60

    def test_required_columns(self, raw_data, config):
        for col in [config["data"]["datetime_col"], config["data"]["unit_col"],
                     config["data"]["census_col"]]:
            assert col in raw_data.columns

    def test_datetime_parsed(self, raw_data, config):
        assert pd.api.types.is_datetime64_any_dtype(raw_data[config["data"]["datetime_col"]])

    def test_no_unnamed_column(self, raw_data):
        assert "Unnamed: 0" not in raw_data.columns


# ---------- Test 2: No data leakage ----------

class TestNoDataLeakage:
    @pytest.mark.parametrize("horizon", [1, 2, 3, 4, 12, 24, 48, 72])
    def test_no_short_lags_for_horizon(self, config, horizon):
        from src.features.feature_engineering import LAG_FEATURE_HOURS
        feature_cols = get_feature_columns(config, horizon)
        for col in feature_cols:
            if col in LAG_FEATURE_HOURS:
                assert LAG_FEATURE_HOURS[col] >= horizon, (
                    f"Feature '{col}' (lag={LAG_FEATURE_HOURS[col]}h) leaked into horizon {horizon}h"
                )

    @pytest.mark.parametrize("horizon", [1, 12, 24, 72])
    def test_no_target_in_features(self, config, horizon):
        feature_cols = get_feature_columns(config, horizon)
        target_cols = [f"TARGET_CENSUS_{h}HR" for h in config["forecast_horizons"]]
        for col in feature_cols:
            assert col not in target_cols

    def test_no_unit_encoded_in_features(self, config):
        """Models are per-unit, so unit_encoded should NOT be a feature."""
        cols = get_feature_columns(config, 1)
        assert "unit_encoded" not in cols


# ---------- Test 3: Chronological split ----------

@pytest.mark.requires_data
class TestChronologicalSplit:
    def test_no_temporal_overlap(self, splits, config):
        train, val, test = splits
        dt_col = config["data"]["datetime_col"]
        assert train[dt_col].max() <= val[dt_col].min()
        assert val[dt_col].max() <= test[dt_col].min()

    def test_split_sizes(self, splits):
        train, val, test = splits
        assert len(train) > len(val)
        assert len(val) > 0 and len(test) > 0

    def test_no_shuffling(self, splits, config):
        dt_col = config["data"]["datetime_col"]
        unit_col = config["data"]["unit_col"]
        for split_df in splits:
            for uid, grp in split_df.groupby(unit_col):
                times = grp[dt_col].values
                assert (times[1:] >= times[:-1]).all()


# ---------- Test 4: Metrics computation ----------

class TestMetrics:
    def test_mae_known(self):
        assert abs(compute_mae(np.array([10, 20, 30]), np.array([12, 18, 33])) - 2.333) < 0.01

    def test_rmse_perfect(self):
        assert compute_rmse(np.array([10, 20, 30]), np.array([10, 20, 30])) == 0.0

    def test_mape_no_zero_div(self):
        assert np.isfinite(compute_mape(np.array([0, 10, 20]), np.array([1, 12, 18])))

    def test_within_n_perfect(self):
        assert compute_within_n(np.array([10, 20, 30]), np.array([10, 20, 30]), n=2) == 100.0

    def test_within_n_partial(self):
        result = compute_within_n(np.array([10, 20, 30]), np.array([11, 25, 29]), n=2)
        assert abs(result - 66.67) < 1.0

    def test_evaluate_model_keys(self):
        result = evaluate_model(np.array([10, 20, 30]), np.array([11, 19, 32]))
        assert set(result.keys()) == {"mae", "rmse", "mape", "within_2_patients_pct"}


# ---------- Test 5: Per-unit model train/predict ----------

@pytest.mark.requires_data
class TestModelTrainPredict:
    def test_rf_per_unit(self, single_unit_train, single_unit_val, config):
        from src.models import RandomForestModel
        X_tr, y_tr, _ = prepare_ml_features(single_unit_train, config, horizon=1)
        X_va, y_va, _ = prepare_ml_features(single_unit_val, config, horizon=1)

        rf = RandomForestModel(config, horizon=1)
        rf.train(X_tr, y_tr)
        preds = rf.predict(X_va)
        assert preds.shape == y_va.shape

    def test_lgbm_per_unit(self, single_unit_train, single_unit_val, config):
        from src.models import LightGBMModel
        X_tr, y_tr, _ = prepare_ml_features(single_unit_train, config, horizon=1)
        X_va, y_va, _ = prepare_ml_features(single_unit_val, config, horizon=1)

        lgbm = LightGBMModel(config, horizon=1)
        lgbm.train(X_tr, y_tr, X_va, y_va)
        preds = lgbm.predict(X_va)
        assert preds.shape == y_va.shape

    def test_predictions_non_negative(self, single_unit_train, single_unit_val, config):
        from src.models import RandomForestModel
        X_tr, y_tr, _ = prepare_ml_features(single_unit_train, config, horizon=1)
        X_va, y_va, _ = prepare_ml_features(single_unit_val, config, horizon=1)

        rf = RandomForestModel(config, horizon=1)
        rf.train(X_tr, y_tr)
        assert (rf.predict(X_va) >= 0).all()


# ---------- Test 6: Ensemble weights ----------

class TestEnsemble:
    def test_weights_sum_to_one(self, config):
        from src.models import EnsembleModel
        ens = EnsembleModel(config, horizon=1)
        weights = ens.compute_weights({
            "A": {"mape": 5.0}, "B": {"mape": 10.0}, "C": {"mape": 20.0},
        })
        assert abs(sum(weights.values()) - 1.0) < 1e-6

    def test_weights_positive(self, config):
        from src.models import EnsembleModel
        ens = EnsembleModel(config, horizon=1)
        weights = ens.compute_weights({"A": {"mape": 5.0}, "B": {"mape": 10.0}})
        assert all(w > 0 for w in weights.values())


# ---------- Test 7: Feature columns ----------

class TestFeatureColumns:
    def test_more_features_at_short_horizon(self, config):
        assert len(get_feature_columns(config, 1)) > len(get_feature_columns(config, 72))

    def test_cyclical_features_present(self, config):
        cols = get_feature_columns(config, 1)
        for feat in ["sin_hour", "cos_hour", "sin_day", "cos_day"]:
            assert feat in cols

    @pytest.mark.requires_data
    def test_filter_unit_returns_single_unit(self, clean_df, config):
        uid = sorted(clean_df[config["data"]["unit_col"]].unique())[0]
        filtered = filter_unit(clean_df, uid, config)
        assert filtered[config["data"]["unit_col"]].nunique() == 1
        assert len(filtered) > 0


# ---------- Test 8: Prediction intervals (data-free) ----------

class TestPredictionIntervals:
    def test_conformal_coverage_holds(self):
        """A 90% conformal band built on one sample should cover ~90% on a
        fresh exchangeable sample."""
        from src.evaluation.intervals import build_interval, conformal_halfwidth, empirical_coverage

        rng = np.random.default_rng(0)
        cal_resid = rng.normal(0, 3.0, size=5000)
        hw = conformal_halfwidth(cal_resid, coverage=0.90)

        point = np.full(5000, 20.0)
        y_true = 20.0 + rng.normal(0, 3.0, size=5000)
        lower, upper = build_interval(point, hw, lower_bound=0.0, upper_bound=None)
        cov = empirical_coverage(y_true, lower, upper)
        assert 0.86 <= cov <= 0.94

    def test_halfwidth_grows_with_coverage(self):
        from src.evaluation.intervals import conformal_halfwidth
        rng = np.random.default_rng(1)
        resid = rng.normal(0, 5.0, size=2000)
        assert conformal_halfwidth(resid, 0.95) > conformal_halfwidth(resid, 0.80)

    def test_halfwidth_nonnegative_and_nan_safe(self):
        from src.evaluation.intervals import conformal_halfwidth
        assert conformal_halfwidth(np.array([-2.0, 1.0, np.nan, 3.0]), 0.9) >= 0
        assert np.isnan(conformal_halfwidth(np.array([]), 0.9))

    def test_interval_clipped_to_nonnegative(self):
        from src.evaluation.intervals import build_interval
        lower, upper = build_interval(np.array([1.0, 0.5]), 5.0, lower_bound=0.0)
        assert (lower >= 0).all() and (upper >= lower).all()

    def test_asymmetric_quantiles_ordered(self):
        from src.evaluation.intervals import asymmetric_quantiles
        rng = np.random.default_rng(2)
        q_lo, q_hi = asymmetric_quantiles(rng.normal(0, 2, 3000), 0.90)
        assert q_lo < q_hi

    def test_coverage_invalid_args(self):
        from src.evaluation.intervals import conformal_halfwidth
        with pytest.raises(ValueError):
            conformal_halfwidth(np.array([1.0, 2.0]), coverage=1.5)


# ---------- Test 9: Drift monitoring (data-free) ----------

class TestDriftMonitoring:
    def test_psi_zero_for_identical(self):
        from src.monitoring.drift import population_stability_index
        rng = np.random.default_rng(3)
        x = rng.normal(20, 4, 5000)
        # Same distribution → PSI near zero.
        assert population_stability_index(x, rng.normal(20, 4, 5000)) < 0.10

    def test_psi_large_for_shifted(self):
        from src.monitoring.drift import population_stability_index, PSI_MAJOR
        rng = np.random.default_rng(4)
        baseline = rng.normal(20, 4, 5000)
        shifted = rng.normal(32, 4, 5000)  # mean shifted +12
        assert population_stability_index(baseline, shifted) >= PSI_MAJOR

    def test_drift_status_labels(self):
        from src.monitoring.drift import drift_status
        assert drift_status(0.02) == "stable"
        assert drift_status(0.15) == "moderate"
        assert drift_status(0.40) == "major"
        assert drift_status(float("nan")) == "unknown"

    def test_performance_drift_flags_degradation(self):
        from src.monitoring.drift import performance_drift
        degraded = performance_drift(80.0, 90.0, tolerance_pct=5.0)
        assert degraded["degraded"] is True
        ok = performance_drift(88.0, 90.0, tolerance_pct=5.0)
        assert ok["degraded"] is False

    def test_performance_drift_nan_safe(self):
        from src.monitoring.drift import performance_drift
        res = performance_drift(float("nan"), 90.0)
        assert res["degraded"] is False

    def test_generate_drift_report_shape(self):
        from src.monitoring.drift import build_psi_bins, generate_drift_report
        rng = np.random.default_rng(5)
        base_census = rng.normal(20, 4, 2000)
        edges = build_psi_bins(base_census, n_bins=10)
        counts, _ = np.histogram(base_census, bins=edges)
        props = counts / counts.sum()
        baseline = {
            "1": {
                "edges": [float(e) for e in edges],
                "expected_props": [float(p) for p in props],
                "within_2_patients_pct": 90.0,
            }
        }
        report = generate_drift_report(
            baseline,
            {"1": rng.normal(20, 4, 500)},
            {"1": 91.0},
        )
        assert len(report) == 1
        rec = report[0]
        assert rec["unit_id"] == "1"
        assert rec["drift_status"] in {"stable", "moderate", "major", "unknown"}
        assert "perf_degraded" in rec

    def test_generate_drift_report_missing_recent(self):
        from src.monitoring.drift import generate_drift_report
        baseline = {"1": {"edges": [-np.inf, 10, np.inf],
                          "expected_props": [0.5, 0.5],
                          "within_2_patients_pct": 90.0}}
        report = generate_drift_report(baseline, {})  # no recent data for unit
        assert report[0]["drift_status"] == "unknown"


# ---------- Test 10: Seasonality-aware drift signals (data-free) ----------

class TestSeasonalityAwareDrift:
    def test_stl_residual_falls_back_when_too_short(self):
        from src.monitoring.drift import stl_residual_series
        # Series shorter than 2 periods triggers the fallback (mean-centered).
        x = np.array([10.0, 12.0, 11.0, 13.0, 9.0], dtype=float)
        out = stl_residual_series(x, period=168)
        assert out.shape == x.shape
        assert abs(out.mean()) < 1e-9

    def test_stl_residual_runs_on_long_series(self):
        from src.monitoring.drift import stl_residual_series
        rng = np.random.default_rng(0)
        t = np.arange(168 * 4)
        x = 20 + 3 * np.sin(2 * np.pi * t / 24) + rng.normal(0, 1, t.size)
        out = stl_residual_series(x, period=24)
        # STL should leave a centered residual roughly the size of the noise.
        assert out.size == x.size
        assert abs(out.mean()) < 0.5
        assert out.std() < x.std()  # residual is tighter than the raw signal

    def test_derive_alert_kind_state_machine(self):
        from src.monitoring.drift import derive_alert_kind
        # Not in major -> stable regardless of history.
        assert derive_alert_kind(False, 0, 0.0) == "stable"
        assert derive_alert_kind(False, 5, 0.9) == "stable"
        # In major but not persistent -> transient.
        assert derive_alert_kind(True, 1, 0.0) == "transient"
        assert derive_alert_kind(True, 2, 0.9) == "transient"
        # Persistent and systemic -> systemic.
        assert derive_alert_kind(True, 3, 0.6) == "systemic"
        # Persistent and unit-specific -> true_drift.
        assert derive_alert_kind(True, 3, 0.2) == "true_drift"
        assert derive_alert_kind(True, 10, 0.0) == "true_drift"

    def test_derive_alert_kind_handles_nan_systemic(self):
        from src.monitoring.drift import derive_alert_kind
        assert derive_alert_kind(True, 5, float("nan")) == "true_drift"

    def test_derive_alert_kind_custom_thresholds(self):
        from src.monitoring.drift import derive_alert_kind
        # With persistence=2 the second consecutive reading already trips.
        assert derive_alert_kind(True, 2, 0.1, persistence_threshold=2) == "true_drift"
        # Custom systemic threshold of 0.3 turns a moderate-coincidence event systemic.
        assert derive_alert_kind(True, 3, 0.35, systemic_threshold=0.3) == "systemic"
