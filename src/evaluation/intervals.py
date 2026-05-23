"""
Prediction intervals for census forecasts.

Wraps point predictions in split-conformal intervals derived from held-out
validation residuals, giving each forecast an operational range rather than a
single number.
"""

import numpy as np


def conformal_halfwidth(residuals: np.ndarray, coverage: float = 0.90) -> float:
    """
    Symmetric split-conformal half-width for a target coverage.

    Uses the (1 - alpha) quantile of the absolute residuals with the finite
    sample correction ceil((n + 1)(1 - alpha)) / n. Returns a non-negative
    half-width h; the interval is [pred - h, pred + h].
    """
    r = np.abs(np.asarray(residuals, dtype=float))
    r = r[~np.isnan(r)]
    n = r.size
    if n == 0:
        return float("nan")
    if not 0.0 < coverage < 1.0:
        raise ValueError("coverage must be in (0, 1)")

    level = min(1.0, np.ceil((n + 1) * coverage) / n)
    return float(np.quantile(r, level, method="higher"))


def asymmetric_quantiles(
    residuals: np.ndarray, coverage: float = 0.90
) -> tuple[float, float]:
    """
    Lower and upper residual quantiles (alpha/2, 1 - alpha/2) for the target
    coverage. The interval is [pred + q_lower, pred + q_upper]; q_lower is
    typically negative.
    """
    r = np.asarray(residuals, dtype=float)
    r = r[~np.isnan(r)]
    if r.size == 0:
        return float("nan"), float("nan")
    if not 0.0 < coverage < 1.0:
        raise ValueError("coverage must be in (0, 1)")

    alpha = 1.0 - coverage
    q_lower = float(np.quantile(r, alpha / 2.0))
    q_upper = float(np.quantile(r, 1.0 - alpha / 2.0))
    return q_lower, q_upper


def build_interval(
    point: np.ndarray,
    halfwidth: float,
    lower_bound: float | None = 0.0,
    upper_bound: float | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Apply a symmetric half-width to point forecasts, clipped to valid census
    (lower bound defaults to 0; optional upper_bound clips at capacity)."""
    point = np.asarray(point, dtype=float)
    lower = point - halfwidth
    upper = point + halfwidth
    if lower_bound is not None:
        lower = np.maximum(lower, lower_bound)
    if upper_bound is not None:
        upper = np.minimum(upper, upper_bound)
    return lower, upper


def empirical_coverage(
    y_true: np.ndarray, lower: np.ndarray, upper: np.ndarray
) -> float:
    """Fraction of true values that fall within [lower, upper]."""
    y_true = np.asarray(y_true, dtype=float)
    lower = np.asarray(lower, dtype=float)
    upper = np.asarray(upper, dtype=float)
    inside = (y_true >= lower) & (y_true <= upper)
    valid = ~(np.isnan(y_true) | np.isnan(lower) | np.isnan(upper))
    if valid.sum() == 0:
        return float("nan")
    return float(np.mean(inside[valid]))


def mean_interval_width(lower: np.ndarray, upper: np.ndarray) -> float:
    """Average width of the interval band."""
    lower = np.asarray(lower, dtype=float)
    upper = np.asarray(upper, dtype=float)
    width = upper - lower
    width = width[~np.isnan(width)]
    if width.size == 0:
        return float("nan")
    return float(np.mean(width))
