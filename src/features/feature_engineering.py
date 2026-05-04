"""
Feature engineering and preparation for ML, LSTM, and Prophet models.

All models train per-unit, so feature prep filters to a single unit first.
Key responsibility: prevent data leakage by excluding lag features
whose lag period is shorter than the forecast horizon.
"""

import logging

import numpy as np
import pandas as pd
from sklearn.preprocessing import MinMaxScaler

logger = logging.getLogger(__name__)

# Mapping of lag/rolling feature names to their lag period in hours.
# Features with lag < horizon must be excluded for that horizon.
LAG_FEATURE_HOURS: dict[str, int] = {
    "CENSUS_PREV_1HR": 1,
    "CENSUS_PREV_2HR": 2,
    "CENSUS_PREV_3HR": 3,
    "CENSUS_PREV_4HR": 4,
    "CENSUS_PREV_12HR": 12,
    "CENSUS_SAME_HOUR_YESTERDAY": 24,
    "CENSUS_PREV_48HR": 48,
    "CENSUS_PREV_72HR": 72,
    "CENSUS_SAME_HOUR_LAST_WEEK": 168,
    "CENSUS_DELTA_1HR": 1,
    "CENSUS_DELTA_4HR": 4,
    "CENSUS_DELTA_12HR": 12,
    "CENSUS_DELTA_24HR": 24,
    "ED_CENSUS_DELTA_1HR": 1,
    "ED_CENSUS_DELTA_4HR": 4,
    "ADMITS_ROLLING_4HR": 4,
    "DISCHARGES_ROLLING_4HR": 4,
    "TRANSFERS_IN_ROLLING_4HR": 4,
    "TRANSFERS_OUT_ROLLING_4HR": 4,
    "ADMITS_ROLLING_8HR": 8,
    "DISCHARGES_ROLLING_8HR": 8,
    "ADMITS_ROLLING_24HR": 24,
    "DISCHARGES_ROLLING_24HR": 24,
    "NET_FLOW_ROLLING_8HR": 8,
}


def add_cyclical_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add sin/cos encodings for hour, day-of-week, and month."""
    df = df.copy()
    df["sin_hour"] = np.sin(2 * np.pi * df["HOUR_OF_DAY"] / 24)
    df["cos_hour"] = np.cos(2 * np.pi * df["HOUR_OF_DAY"] / 24)
    df["sin_day"] = np.sin(2 * np.pi * df["DAY_OF_WEEK"] / 7)
    df["cos_day"] = np.cos(2 * np.pi * df["DAY_OF_WEEK"] / 7)
    df["sin_month"] = np.sin(2 * np.pi * df["MONTH_OF_YEAR"] / 12)
    df["cos_month"] = np.cos(2 * np.pi * df["MONTH_OF_YEAR"] / 12)
    return df


def get_feature_columns(config: dict, horizon: int) -> list[str]:
    """
    Return the list of feature columns for a given forecast horizon.

    For horizon H, exclude any lag/rolling feature whose lag period < H hours
    to prevent data leakage. No unit encoding — models are per-unit.
    """
    all_features: list[str] = []
    for group in config["features"].values():
        all_features.extend(group)

    # Add cyclical features (always safe — derived from calendar)
    all_features.extend([
        "sin_hour", "cos_hour", "sin_day", "cos_day", "sin_month", "cos_month",
    ])

    # Filter out features that would leak future information
    safe_features = []
    for feat in all_features:
        if feat in LAG_FEATURE_HOURS:
            if LAG_FEATURE_HOURS[feat] >= horizon:
                safe_features.append(feat)
        else:
            safe_features.append(feat)

    # Deduplicate preserving order
    seen = set()
    return [f for f in safe_features if not (f in seen or seen.add(f))]


def filter_unit(df: pd.DataFrame, unit_id: int, config: dict) -> pd.DataFrame:
    """Filter DataFrame to a single nurse unit, sorted by time."""
    return (
        df[df[config["data"]["unit_col"]] == unit_id]
        .sort_values(config["data"]["datetime_col"])
        .reset_index(drop=True)
    )


def prepare_ml_features(
    df: pd.DataFrame, config: dict, horizon: int,
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """
    Prepare feature matrix X and target vector y for a single unit.

    Expects df already filtered to one unit with cyclical features added.
    Returns (X, y, feature_names) with NaN rows dropped.
    """
    target_col = config["target_columns"][horizon]
    feature_cols = get_feature_columns(config, horizon)
    feature_cols = [c for c in feature_cols if c in df.columns]

    subset = df[feature_cols + [target_col]].dropna()
    X = subset[feature_cols].values
    y = subset[target_col].values
    return X, y, feature_cols


def prepare_lstm_sequences(
    train_df: pd.DataFrame,
    val_df: pd.DataFrame,
    test_df: pd.DataFrame,
    config: dict,
    horizon: int,
) -> dict:
    """
    Create sliding-window sequences for LSTM training for a single unit.

    Expects DataFrames already filtered to one unit with cyclical features.
    Fits scaler on train only.

    Returns dict: X_train, y_train, X_val, y_val, X_test, y_test, scaler, feature_names
    """
    seq_len = config["models"]["lstm"]["sequence_length"]
    target_col = config["target_columns"][horizon]
    feature_cols = get_feature_columns(config, horizon)

    scaler = MinMaxScaler()
    results = {}

    for split_name, split_df in [("train", train_df), ("val", val_df), ("test", test_df)]:
        available_cols = [c for c in feature_cols if c in split_df.columns]
        feat_data = split_df[available_cols].values
        target_data = split_df[target_col].values

        # Fit scaler on training data only
        if split_name == "train":
            valid_rows = feat_data[~np.isnan(feat_data).any(axis=1)]
            if len(valid_rows) > 0:
                scaler.fit(valid_rows)

        # Build sequences
        sequences, targets = [], []
        for i in range(seq_len, len(split_df)):
            seq = feat_data[i - seq_len:i]
            tgt = target_data[i]
            if not np.isnan(seq).any() and not np.isnan(tgt):
                sequences.append(seq)
                targets.append(tgt)

        if sequences:
            X = np.array(sequences)
            y = np.array(targets)
            # Scale features
            shape = X.shape
            X = scaler.transform(X.reshape(-1, shape[-1])).reshape(shape)
            results[f"X_{split_name}"] = X
            results[f"y_{split_name}"] = y
        else:
            results[f"X_{split_name}"] = np.array([])
            results[f"y_{split_name}"] = np.array([])

    results["scaler"] = scaler
    results["feature_names"] = [c for c in feature_cols if c in train_df.columns]
    return results


def prepare_prophet_data(
    df: pd.DataFrame, config: dict,
) -> pd.DataFrame:
    """
    Prepare Prophet-formatted DataFrame for a single unit.

    Expects df already filtered to one unit.
    Returns DataFrame with columns 'ds' (datetime) and 'y' (census).
    """
    dt_col = config["data"]["datetime_col"]
    census_col = config["data"]["census_col"]
    return (
        df[[dt_col, census_col]]
        .rename(columns={dt_col: "ds", census_col: "y"})
        .sort_values("ds")
        .reset_index(drop=True)
    )
