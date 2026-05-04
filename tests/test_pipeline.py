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

    def test_filter_unit_returns_single_unit(self, clean_df, config):
        uid = sorted(clean_df[config["data"]["unit_col"]].unique())[0]
        filtered = filter_unit(clean_df, uid, config)
        assert filtered[config["data"]["unit_col"]].nunique() == 1
        assert len(filtered) > 0
