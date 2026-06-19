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
    return residual_diagnostics(residuals)


def residual_diagnostics(residuals: np.ndarray) -> dict:
    """
    Normality (Shapiro-Wilk) and autocorrelation (Ljung-Box) tests on a
    residual series. Returns NaN p-values for series too short to test.
    """
    residuals = np.asarray(residuals, dtype=float)
    residuals = residuals[~np.isnan(residuals)]
    n = residuals.size

    if n < 8:
        return {
            "n": int(n),
            "mean_residual": float(np.mean(residuals)) if n else float("nan"),
            "std_residual": float(np.std(residuals)) if n else float("nan"),
            "shapiro_stat": float("nan"),
            "shapiro_p": float("nan"),
            "ljung_box_p": float("nan"),
        }

    # Shapiro-Wilk on a sample (max 5000 for computational feasibility)
    sample = residuals if n <= 5000 else np.random.choice(residuals, 5000, replace=False)
    shapiro_stat, shapiro_p = stats.shapiro(sample)

    # Ljung-Box test for autocorrelation (lag = up to 1 day of hourly data)
    try:
        from statsmodels.stats.diagnostic import acorr_ljungbox
        lag = min(24, n - 1)
        lb_result = acorr_ljungbox(residuals, lags=[lag], return_df=True)
        ljung_box_p = float(lb_result["lb_pvalue"].iloc[0])
    except Exception as e:
        logger.warning("Ljung-Box test failed: %s", e)
        ljung_box_p = float("nan")

    return {
        "n": int(n),
        "mean_residual": float(np.mean(residuals)),
        "std_residual": float(np.std(residuals)),
        "shapiro_stat": float(shapiro_stat),
        "shapiro_p": float(shapiro_p),
        "ljung_box_p": ljung_box_p,
    }


def diebold_mariano(
    errors_a: np.ndarray, errors_b: np.ndarray,
    horizon: int = 1, loss: str = "squared",
) -> dict:
    """
    Diebold-Mariano test for equal predictive accuracy of two forecasts on the
    same targets. Uses the Harvey-Leybourne-Newbold small-sample correction and
    a t-reference distribution.

    errors_a / errors_b are the (actual - predicted) residual series for model A
    and model B, paired on the same observations. A negative mean loss difference
    means model A has the lower loss (is the better forecast).

    Returns dm_stat (HLN-corrected), two-sided p_value, n, and mean_loss_diff.
    NaN stats are returned when the series is too short or has zero variance.
    """
    e1 = np.asarray(errors_a, dtype=float)
    e2 = np.asarray(errors_b, dtype=float)
    if e1.shape != e2.shape:
        raise ValueError("error series must have the same length")
    if loss not in ("squared", "absolute"):
        raise ValueError("loss must be 'squared' or 'absolute'")

    n = e1.size
    nan = {"dm_stat": float("nan"), "p_value": float("nan"),
           "n": int(n), "mean_loss_diff": float("nan")}
    if n < 8:
        return nan

    d = (e1 ** 2 - e2 ** 2) if loss == "squared" else (np.abs(e1) - np.abs(e2))
    mean_d = float(np.mean(d))

    # Long-run variance: autocovariances up to horizon-1 lags (overlap of
    # h-step-ahead forecasts induces autocorrelation up to lag h-1).
    h = max(int(horizon), 1)
    dc = d - mean_d
    var = float(np.mean(dc ** 2))
    for k in range(1, min(h, n)):
        var += 2.0 * float(np.mean(dc[k:] * dc[:-k]))
    var_mean_d = var / n
    if var_mean_d <= 0:
        return nan

    dm = mean_d / np.sqrt(var_mean_d)

    # Harvey-Leybourne-Newbold small-sample correction.
    factor = (n + 1 - 2 * h + h * (h - 1) / n) / n
    if factor > 0:
        dm *= np.sqrt(factor)

    p_value = float(2.0 * (1.0 - stats.t.cdf(abs(dm), df=n - 1)))
    return {"dm_stat": float(dm), "p_value": p_value,
            "n": int(n), "mean_loss_diff": mean_d}


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
