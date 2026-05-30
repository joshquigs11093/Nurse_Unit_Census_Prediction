"""
Drift monitoring for the deployed census forecaster.

Two checks against a frozen training baseline:
  - covariate drift via Population Stability Index (PSI) on the census
    distribution
  - performance drift via the change in within-2 accuracy on a recent window
"""

import logging

import numpy as np

logger = logging.getLogger(__name__)

# Conventional PSI interpretation thresholds.
PSI_MINOR = 0.10   # < 0.10: no meaningful shift
PSI_MAJOR = 0.25   # 0.10-0.25: moderate shift; >= 0.25: major shift


def build_psi_bins(baseline: np.ndarray, n_bins: int = 10) -> np.ndarray:
    """
    Quantile bin edges from the baseline sample, with -inf/+inf outer edges so
    live values outside the baseline range still land in a bin. Duplicate
    edges (common with discrete census) are collapsed.
    """
    baseline = np.asarray(baseline, dtype=float)
    baseline = baseline[~np.isnan(baseline)]
    if baseline.size == 0:
        raise ValueError("baseline is empty")

    quantiles = np.linspace(0, 1, n_bins + 1)
    edges = np.unique(np.quantile(baseline, quantiles))
    if edges.size < 2:
        edges = np.array([edges[0], edges[0] + 1.0])
    edges[0] = -np.inf
    edges[-1] = np.inf
    return edges


def _binned_proportions(values: np.ndarray, edges: np.ndarray) -> np.ndarray:
    """Fraction of values in each bin defined by edges."""
    values = np.asarray(values, dtype=float)
    values = values[~np.isnan(values)]
    counts, _ = np.histogram(values, bins=edges)
    total = counts.sum()
    if total == 0:
        return np.zeros(len(edges) - 1, dtype=float)
    return counts / total


def population_stability_index(
    expected: np.ndarray,
    actual: np.ndarray,
    n_bins: int = 10,
    epsilon: float = 1e-6,
) -> float:
    """
    PSI between an expected (baseline) sample and an actual (recent) sample.
    Empty bins are floored at epsilon to keep the logarithm finite. Higher
    values mean more drift; see PSI_MINOR / PSI_MAJOR.
    """
    edges = build_psi_bins(expected, n_bins=n_bins)
    return psi_from_baseline(actual, edges, _binned_proportions(expected, edges),
                             epsilon=epsilon)


def psi_from_baseline(
    actual: np.ndarray,
    edges: np.ndarray,
    expected_props: np.ndarray,
    epsilon: float = 1e-6,
) -> float:
    """PSI using precomputed baseline edges and proportions (the deployment
    path: baseline is frozen at train time and reused on each live window)."""
    expected_props = np.asarray(expected_props, dtype=float)
    actual_props = _binned_proportions(actual, edges)

    e = np.clip(expected_props, epsilon, None)
    a = np.clip(actual_props, epsilon, None)
    psi = np.sum((a - e) * np.log(a / e))
    return float(psi)


def drift_status(psi: float) -> str:
    """Map a PSI value to a label: stable, moderate, major, or unknown."""
    if np.isnan(psi):
        return "unknown"
    if psi < PSI_MINOR:
        return "stable"
    if psi < PSI_MAJOR:
        return "moderate"
    return "major"


def stl_residual_series(values: np.ndarray, period: int) -> np.ndarray:
    """Residual component from STL decomposition; the deseasoned signal used to
    separate genuine drift from ordinary seasonal variation.

    Falls back to mean-centered values when the series is too short for STL
    (it needs at least two full periods) or when statsmodels is unavailable,
    so the caller never has to special-case missing dependencies.
    """
    arr = np.asarray(values, dtype=float)
    arr = arr[~np.isnan(arr)]
    if arr.size < 2 * period:
        return arr - np.mean(arr) if arr.size else arr
    try:
        from statsmodels.tsa.seasonal import STL
        return np.asarray(STL(arr, period=period, robust=True).fit().resid, dtype=float)
    except Exception as exc:
        logger.warning("STL decomposition failed (%s); falling back to mean-centered", exc)
        return arr - np.mean(arr)


def derive_alert_kind(in_major: bool,
                      consecutive_major: int,
                      systemic_fraction: float,
                      persistence_threshold: int = 3,
                      systemic_threshold: float = 0.5) -> str:
    """Classify a per-unit drift reading into a human-actionable label.

    - stable: not in major.
    - transient: in major now but not yet persistent (could be a one-off spike).
    - systemic: persistent major AND most other units are also in major
      (likely seasonal or external event).
    - true_drift: persistent major while other units are stable
      (unit-specific, retrain candidate).
    """
    if not in_major:
        return "stable"
    if consecutive_major < persistence_threshold:
        return "transient"
    if not np.isnan(systemic_fraction) and systemic_fraction >= systemic_threshold:
        return "systemic"
    return "true_drift"


def performance_drift(
    recent_within2: float,
    baseline_within2: float,
    tolerance_pct: float = 5.0,
) -> dict:
    """
    Compare recent within-2 accuracy against the validation baseline. Flags
    `degraded` when the drop exceeds tolerance_pct percentage points.
    """
    if np.isnan(recent_within2) or np.isnan(baseline_within2):
        return {"delta_pct": float("nan"), "degraded": False, "reason": "insufficient data"}
    delta = recent_within2 - baseline_within2
    degraded = delta < -abs(tolerance_pct)
    return {
        "delta_pct": round(delta, 2),
        "degraded": bool(degraded),
        "reason": (
            f"within-2 dropped {abs(delta):.1f} pts (> {tolerance_pct} pt tolerance)"
            if degraded
            else "within tolerance"
        ),
    }


def generate_drift_report(
    baseline_by_unit: dict,
    recent_census_by_unit: dict,
    recent_within2_by_unit: dict | None = None,
    n_bins: int = 10,
    perf_tolerance_pct: float = 5.0,
) -> list[dict]:
    """
    One drift record per unit: unit_id, psi, drift_status, and performance
    drift fields when recent accuracy is supplied.

    baseline_by_unit: {unit_id: {"edges", "expected_props",
        "within_2_patients_pct", ...}}
    recent_census_by_unit: {unit_id: recent census array}
    recent_within2_by_unit: {unit_id: float} or None
    """
    recent_within2_by_unit = recent_within2_by_unit or {}
    records = []

    for uid, baseline in baseline_by_unit.items():
        recent = recent_census_by_unit.get(uid)
        if recent is None or np.asarray(recent, dtype=float).size == 0:
            records.append({
                "unit_id": uid,
                "psi": float("nan"),
                "drift_status": "unknown",
                "perf_delta_pct": float("nan"),
                "perf_degraded": False,
            })
            continue

        edges = np.asarray(baseline["edges"], dtype=float)
        expected_props = np.asarray(baseline["expected_props"], dtype=float)
        psi = psi_from_baseline(recent, edges, expected_props)

        rec = {
            "unit_id": uid,
            "psi": round(psi, 4),
            "drift_status": drift_status(psi),
        }

        baseline_w2 = baseline.get("within_2_patients_pct", float("nan"))
        recent_w2 = recent_within2_by_unit.get(uid, float("nan"))
        perf = performance_drift(recent_w2, baseline_w2, tolerance_pct=perf_tolerance_pct)
        rec["perf_delta_pct"] = perf["delta_pct"]
        rec["perf_degraded"] = perf["degraded"]
        records.append(rec)

    return records
