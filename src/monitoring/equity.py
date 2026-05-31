"""
Per-unit equity (fairness) view for the deployed forecaster.

Because the pipeline trains one model per unit, an "equity" question is
whether smaller, lower-volume units get forecasts as good as the high-volume
ones, both in point accuracy (within-2 patients) and in interval reliability
(does the 90% conformal band actually cover 90% of actuals for every unit).
This module derives those two views and a single classification label per
unit so the monitor can flag underserved units explicitly rather than
averaging them into a cohort number.
"""

import json
import logging
from pathlib import Path

import pandas as pd

logger = logging.getLogger(__name__)


def classify_equity(accuracy_delta_pct: float,
                    coverage_pct: float,
                    nominal_coverage: float = 0.90,
                    accuracy_gap_pct: float = 5.0,
                    coverage_tolerance: float = 0.05) -> str:
    """Per-unit equity label given a unit's accuracy gap vs. the cohort median
    and its empirical interval coverage.

    Returns 'underserved' when the unit's accuracy is well below the cohort
    median or its coverage misses the nominal target by more than the
    tolerance; 'well-served' when it sits clearly above the median and within
    coverage tolerance; 'served' otherwise. NaN inputs default to 'served'
    rather than firing a spurious label.
    """
    bad_accuracy = (not pd.isna(accuracy_delta_pct)
                    and accuracy_delta_pct < -abs(accuracy_gap_pct))
    bad_coverage = (not pd.isna(coverage_pct)
                    and abs(coverage_pct - nominal_coverage) > coverage_tolerance)
    if bad_accuracy or bad_coverage:
        return "underserved"
    if not pd.isna(accuracy_delta_pct) and accuracy_delta_pct > abs(accuracy_gap_pct):
        return "well-served"
    return "served"


def _per_unit_accuracy(reports_dir: Path) -> dict:
    """Mean within-2 accuracy across horizons for the deployed model per unit.
    Returns {unit_id(str): pct}. Reads outputs/reports/model_comparison.csv."""
    comp = reports_dir / "model_comparison.csv"
    if not comp.exists():
        return {}
    df = pd.read_csv(comp)
    if df.empty:
        return {}
    deployed_name = pd.Series(["RandomForest"] * len(df), index=df.index)
    deployed_name = deployed_name.where(df["horizon"] == 1, "LightGBM")
    deployed = df[df["model"] == deployed_name]
    out = (deployed.groupby("unit_id")["within_2_patients_pct"].mean()
                   .round(2).to_dict())
    return {str(k): float(v) for k, v in out.items()}


def _per_unit_coverage(models_dir: Path, unit_ids: list[str]) -> dict:
    """Mean empirical interval coverage across horizons per unit from each
    intervals.json file. Returns {unit_id(str): coverage in [0,1]}."""
    out = {}
    for uid in unit_ids:
        path = models_dir / uid / "intervals.json"
        if not path.exists():
            continue
        try:
            with path.open() as f:
                intervals = json.load(f)
        except Exception:
            continue
        covs = [float(v.get("val_coverage")) for v in intervals.values()
                if v.get("val_coverage") is not None]
        if covs:
            out[uid] = round(sum(covs) / len(covs), 4)
    return out


def compute_unit_equity(config: dict,
                        unit_ids: list[str],
                        nominal_coverage: float = 0.90,
                        accuracy_gap_pct: float = 5.0,
                        coverage_tolerance: float = 0.05) -> dict:
    """Build a per-unit equity record from the saved training artifacts.

    Returns {unit_id(str): {accuracy_pct, coverage_pct,
             accuracy_median_pct, accuracy_delta_from_median_pct,
             equity_status}}.
    """
    reports_dir = Path(config["output"]["reports_dir"])
    models_dir = Path(config["output"]["models_dir"])

    accuracy = _per_unit_accuracy(reports_dir)
    coverage = _per_unit_coverage(models_dir, unit_ids)

    accs = [v for v in accuracy.values() if not pd.isna(v)]
    median = float(pd.Series(accs).median()) if accs else float("nan")

    out = {}
    for uid in unit_ids:
        acc = accuracy.get(uid, float("nan"))
        cov = coverage.get(uid, float("nan"))
        delta = (acc - median) if not pd.isna(acc) and not pd.isna(median) else float("nan")
        status = classify_equity(
            accuracy_delta_pct=delta,
            coverage_pct=cov,
            nominal_coverage=nominal_coverage,
            accuracy_gap_pct=accuracy_gap_pct,
            coverage_tolerance=coverage_tolerance,
        )
        out[uid] = {
            "accuracy_pct": round(acc, 2) if not pd.isna(acc) else float("nan"),
            "coverage_pct": round(cov, 4) if not pd.isna(cov) else float("nan"),
            "accuracy_median_pct": round(median, 2) if not pd.isna(median) else float("nan"),
            "accuracy_delta_from_median_pct":
                round(delta, 2) if not pd.isna(delta) else float("nan"),
            "equity_status": status,
        }
    return out
