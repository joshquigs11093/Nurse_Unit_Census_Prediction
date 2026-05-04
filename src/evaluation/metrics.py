"""
Standardized evaluation metrics for census prediction models.

Primary metric: percentage of predictions within ±2 patients of actual census.
Secondary metrics: MAE, RMSE, MAPE.
"""

import logging

import numpy as np
import pandas as pd
from scipy import stats

logger = logging.getLogger(__name__)


def compute_mae(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    """Mean Absolute Error."""
    return float(np.mean(np.abs(y_true - y_pred)))


def compute_rmse(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    """Root Mean Squared Error."""
    return float(np.sqrt(np.mean((y_true - y_pred) ** 2)))


def compute_mape(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    """Mean Absolute Percentage Error. Uses max(y_true, 1) to avoid division by zero."""
    denominator = np.maximum(np.abs(y_true), 1)
    return float(np.mean(np.abs(y_true - y_pred) / denominator) * 100)


def compute_within_n(y_true: np.ndarray, y_pred: np.ndarray, n: int = 2) -> float:
    """Percentage of predictions within ±n patients of actual. This is the PRIMARY metric."""
    within = np.abs(y_true - y_pred) <= n
    return float(np.mean(within) * 100)


def evaluate_model(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    """Compute all four metrics and return as a dict."""
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)

    return {
        "mae": round(compute_mae(y_true, y_pred), 4),
        "rmse": round(compute_rmse(y_true, y_pred), 4),
        "mape": round(compute_mape(y_true, y_pred), 4),
        "within_2_patients_pct": round(compute_within_n(y_true, y_pred, n=2), 2),
    }


def compute_residual_diagnostics(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    """
    Residual analysis: normality (Shapiro-Wilk) and autocorrelation (Ljung-Box).
    """
    residuals = np.asarray(y_true, dtype=float) - np.asarray(y_pred, dtype=float)

    # Shapiro-Wilk on a sample (max 5000 for computational feasibility)
    sample = residuals if len(residuals) <= 5000 else np.random.choice(residuals, 5000, replace=False)
    shapiro_stat, shapiro_p = stats.shapiro(sample)

    # Ljung-Box test for autocorrelation (lag 24 = 1 day of hourly data)
    try:
        from statsmodels.stats.diagnostic import acorr_ljungbox
        lb_result = acorr_ljungbox(residuals, lags=[24], return_df=True)
        ljung_box_p = float(lb_result["lb_pvalue"].iloc[0])
    except (ImportError, Exception) as e:
        logger.warning("Ljung-Box test failed: %s", e)
        ljung_box_p = None

    return {
        "residuals": residuals,
        "mean_residual": float(np.mean(residuals)),
        "std_residual": float(np.std(residuals)),
        "shapiro_stat": float(shapiro_stat),
        "shapiro_p": float(shapiro_p),
        "ljung_box_p": ljung_box_p,
    }


def generate_comparison_table(results_dict: dict) -> pd.DataFrame:
    """
    Generate a MultiIndex comparison table from nested results.

    Input format: {model_name: {horizon: {metric: value}}}
    Output: DataFrame with (model, horizon) as rows and metrics as columns.
    """
    rows = []
    for model_name, horizons in results_dict.items():
        for horizon, metrics in horizons.items():
            row = {"model": model_name, "horizon": horizon}
            row.update(metrics)
            rows.append(row)

    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.sort_values(["horizon", "model"]).reset_index(drop=True)
    return df
