"""
Data loading, validation, cleaning, and splitting for the census prediction pipeline.

All functions expect a config dict loaded from config/config.yaml.
"""

import logging
from pathlib import Path

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


def load_raw_data(config: dict) -> pd.DataFrame:
    """Load postsql.csv, parse datetime, sort by unit + time."""
    raw_path = Path(config["data"]["raw_path"])
    dt_col = config["data"]["datetime_col"]
    unit_col = config["data"]["unit_col"]
    drop_cols = config["data"].get("drop_columns", [])

    logger.info("Loading raw data from %s", raw_path)
    df = pd.read_csv(raw_path)

    # Drop index column from SQL export
    for col in drop_cols:
        if col in df.columns:
            df = df.drop(columns=[col])

    df[dt_col] = pd.to_datetime(df[dt_col])
    df = df.sort_values([unit_col, dt_col]).reset_index(drop=True)

    logger.info("Loaded %d rows, %d columns, %d units",
                len(df), len(df.columns), df[unit_col].nunique())
    return df


def validate_data(df: pd.DataFrame, config: dict) -> dict:
    """Run validation checks and return a report dict."""
    dt_col = config["data"]["datetime_col"]
    unit_col = config["data"]["unit_col"]
    census_col = config["data"]["census_col"]

    report = {}

    # Expected columns
    target_cols = list(config["target_columns"].values())
    expected = [dt_col, unit_col, census_col] + target_cols
    missing_cols = [c for c in expected if c not in df.columns]
    report["missing_expected_columns"] = missing_cols

    # Duplicates
    dupes = df.duplicated(subset=[unit_col, dt_col], keep=False)
    report["duplicate_unit_timestamp_pairs"] = int(dupes.sum())

    # Date range per unit
    date_ranges = (
        df.groupby(unit_col)[dt_col]
        .agg(["min", "max", "count"])
        .rename(columns={"min": "start", "max": "end", "count": "rows"})
    )
    report["date_ranges"] = date_ranges.to_dict(orient="index")

    # Missing values
    missing = df.isnull().sum()
    report["missing_values"] = missing[missing > 0].to_dict()

    # Outliers per unit (±3 std on CENSUS)
    outlier_counts = {}
    for uid, grp in df.groupby(unit_col):
        mean = grp[census_col].mean()
        std = grp[census_col].std()
        n_outliers = int(((grp[census_col] - mean).abs() > 3 * std).sum())
        outlier_counts[uid] = n_outliers
    report["outliers_3std"] = outlier_counts

    # Continuity check: expected hourly rows per unit
    continuity = {}
    for uid, grp in df.groupby(unit_col):
        start = grp[dt_col].min()
        end = grp[dt_col].max()
        expected_hours = int((end - start).total_seconds() / 3600) + 1
        actual = len(grp)
        continuity[uid] = {"expected": expected_hours, "actual": actual,
                           "missing_hours": expected_hours - actual}
    report["continuity"] = continuity

    n_issues = (
        len(missing_cols)
        + report["duplicate_unit_timestamp_pairs"]
        + sum(1 for v in continuity.values() if v["missing_hours"] > 0)
    )
    report["total_issues"] = n_issues
    logger.info("Validation complete: %d issue(s) found", n_issues)
    return report


def clean_data(df: pd.DataFrame, config: dict) -> pd.DataFrame:
    """Clean the DataFrame: handle missing values, drop HOLIDAY_NAME, remove exact dupes."""
    dt_col = config["data"]["datetime_col"]
    unit_col = config["data"]["unit_col"]

    n_before = len(df)
    df = df.drop_duplicates()
    n_dropped = n_before - len(df)
    if n_dropped:
        logger.info("Dropped %d exact duplicate rows", n_dropped)

    # Drop HOLIDAY_NAME (IS_HOLIDAY already encodes this as binary)
    if "HOLIDAY_NAME" in df.columns:
        df = df.drop(columns=["HOLIDAY_NAME"])

    # Fill DAYS_SINCE_LAST_SPIKE NaN with -1 (sentinel: no spike observed)
    if "DAYS_SINCE_LAST_SPIKE" in df.columns:
        df["DAYS_SINCE_LAST_SPIKE"] = df["DAYS_SINCE_LAST_SPIKE"].fillna(-1)

    # Verify target NaNs are only at end of each unit's series (expected)
    target_cols = [c for c in df.columns if c.startswith("TARGET_CENSUS_")]
    for col in target_cols:
        nan_mask = df[col].isna()
        if nan_mask.any():
            # For each unit, NaN targets should only appear at the tail
            for uid, grp in df[nan_mask].groupby(unit_col):
                unit_data = df[df[unit_col] == uid]
                last_valid_idx = unit_data[col].last_valid_index()
                nans_after = unit_data.loc[last_valid_idx:][col].isna().sum() - 0
                nans_total = unit_data[col].isna().sum()
                if nans_after != nans_total:
                    logger.warning(
                        "Unit %s has %d interior NaN values in %s (possible leakage risk)",
                        uid, nans_total - nans_after, col,
                    )

    df = df.sort_values([unit_col, dt_col]).reset_index(drop=True)
    logger.info("Cleaning complete: %d rows remain", len(df))
    return df


def split_data(
    df: pd.DataFrame, config: dict
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Chronological train/val/test split. Never shuffles."""
    dt_col = config["data"]["datetime_col"]
    train_end = pd.Timestamp(config["data"]["train_end"])
    val_end = pd.Timestamp(config["data"]["val_end"])

    train = df[df[dt_col] <= train_end].copy()
    val = df[(df[dt_col] > train_end) & (df[dt_col] <= val_end)].copy()
    test = df[df[dt_col] > val_end].copy()

    logger.info(
        "Split sizes — train: %d, val: %d, test: %d", len(train), len(val), len(test)
    )

    # Sanity check: no temporal overlap
    assert train[dt_col].max() <= val[dt_col].min(), "Train/val overlap!"
    assert val[dt_col].max() <= test[dt_col].min(), "Val/test overlap!"

    return train, val, test


def save_processed_data(
    train: pd.DataFrame,
    val: pd.DataFrame,
    test: pd.DataFrame,
    config: dict,
    validation_report: dict | None = None,
) -> None:
    """Save splits as parquet and optionally save the validation report."""
    processed_dir = Path(config["data"]["processed_dir"])
    processed_dir.mkdir(parents=True, exist_ok=True)

    train.to_parquet(processed_dir / "train.parquet", index=False)
    val.to_parquet(processed_dir / "val.parquet", index=False)
    test.to_parquet(processed_dir / "test.parquet", index=False)
    logger.info("Saved processed splits to %s", processed_dir)

    if validation_report is not None:
        reports_dir = Path(config["output"]["reports_dir"])
        reports_dir.mkdir(parents=True, exist_ok=True)
        report_df = pd.DataFrame([
            {"check": k, "value": str(v)}
            for k, v in validation_report.items()
            if k != "date_ranges"
        ])
        report_df.to_csv(reports_dir / "data_quality_report.csv", index=False)
        logger.info("Saved data quality report")
