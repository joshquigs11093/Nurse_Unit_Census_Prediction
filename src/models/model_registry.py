"""
Model registry — orchestrates per-unit, per-horizon training and evaluation.

Every model trains on a single nurse unit. ARIMA/Prophet train once per unit
and forecast at all horizons. Tabular models train per unit per horizon.
Training is parallelized across units using joblib.
"""

import gc
import logging
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from joblib import Parallel, delayed

from src.evaluation import (
    diebold_mariano,
    evaluate_model,
    residual_diagnostics,
)
from src.features import (
    add_cyclical_features,
    filter_unit,
    get_feature_columns,
    prepare_ml_features,
    prepare_lstm_sequences,
    prepare_prophet_data,
)

from .arima_model import ARIMAModel
from .ensemble_model import EnsembleModel
from .lgbm_model import LightGBMModel
from .lstm_model import LSTMModel
from .prophet_model import ProphetModel
from .rf_model import RandomForestModel

logger = logging.getLogger(__name__)

# Number of parallel workers (units trained in parallel)
N_JOBS = -1  # use all cores


# ======================================================================
# Standalone functions for joblib (must be top-level for pickling)
# ======================================================================
#
# Each trainer returns (uid, results, preds), where preds maps a horizon to
# {"timestamp", "residual"} validation residuals keyed by the forecast's base
# timestamp. These feed the residual-diagnostic and Diebold-Mariano exports;
# keying on timestamp lets any two models be paired on their common targets.


def _val_timestamps(u_val, config, h):
    """Timestamps of the validation rows that survive tabular feature prep.

    Mirrors prepare_ml_features' dropna over the same columns so the result
    aligns one-to-one with its returned X/y (the datetime column has no NaNs,
    so including it does not change which rows drop).
    """
    dt_col = config["data"]["datetime_col"]
    target_col = config["target_columns"][h]
    fcols = [c for c in get_feature_columns(config, h) if c in u_val.columns]
    sub = u_val[[dt_col] + fcols + [target_col]].dropna()
    return sub[dt_col].values


def _train_tabular_unit(ModelClass, name, uid, u_train, u_val, horizons, config):
    """Train one tabular model (RF or LightGBM) for all horizons on one unit."""
    results = {}
    preds_out = {}
    for h in horizons:
        X_tr, y_tr, _ = prepare_ml_features(u_train, config, h)
        X_va, y_va, _ = prepare_ml_features(u_val, config, h)

        if len(X_tr) < 50 or len(X_va) < 10:
            continue

        model = ModelClass(config, h)
        model.train(X_tr, y_tr, X_va, y_va)
        preds = model.predict(X_va)
        results[h] = evaluate_model(y_va, preds)

        ts = _val_timestamps(u_val, config, h)
        if len(ts) == len(y_va):
            preds_out[h] = {
                "timestamp": ts,
                "residual": np.asarray(y_va, dtype=float) - np.asarray(preds, dtype=float),
            }

        model_dir = Path(config["output"]["models_dir"]) / str(uid)
        model.save(model_dir / f"{name.lower()}_{h}h.joblib")

    return uid, results, preds_out


def _train_arima_unit(uid, u_train, u_val, horizons, config):
    """Train ARIMA once for one unit, forecast at all horizons."""
    results = {}
    preds_out = {}
    dt_col = config["data"]["datetime_col"]

    # Train once (horizon doesn't affect the fitted model)
    model = ARIMAModel(config, horizon=1)
    model.train(u_train)
    if not model.is_fitted:
        return uid, results, preds_out

    # Forecast at max horizon length, slice for each
    max_h = max(horizons)
    max_target = config["target_columns"][max_h]
    max_actuals_len = u_val[max_target].dropna().shape[0]
    total_steps = max_actuals_len + max_h

    try:
        if hasattr(model.model, "predict"):
            all_fc = model.model.predict(n_periods=total_steps)
        else:
            all_fc = model.model.forecast(steps=total_steps)
        all_fc = np.asarray(all_fc, dtype=float)
    except Exception as e:
        logger.warning("ARIMA forecast failed for unit %s: %s", uid, e)
        return uid, results, preds_out

    for h in horizons:
        target_col = config["target_columns"][h]
        notna = u_val[target_col].notna()
        actuals = u_val.loc[notna, target_col].values
        ts_all = u_val.loc[notna, dt_col].values
        preds = all_fc[h: h + len(actuals)]
        n = min(len(preds), len(actuals))
        if n == 0:
            continue
        preds, actuals, ts_h = preds[:n], actuals[:n], ts_all[:n]
        mask = ~np.isnan(preds)
        if mask.sum() > 0:
            results[h] = evaluate_model(actuals[mask], preds[mask])
            preds_out[h] = {"timestamp": ts_h[mask],
                            "residual": actuals[mask] - preds[mask]}

    # Save params
    model_dir = Path(config["output"]["models_dir"]) / str(uid)
    model.save(model_dir / "arima")

    del model
    gc.collect()
    return uid, results, preds_out


def _train_prophet_unit(uid, u_train, u_val, horizons, config):
    """Train Prophet once for one unit, forecast at all horizons."""
    results = {}
    preds_out = {}
    dt_col = config["data"]["datetime_col"]
    prophet_train = prepare_prophet_data(u_train, config)
    prophet_val = prepare_prophet_data(u_val, config)

    # Train once
    model = ProphetModel(config, horizon=0)
    model.train(prophet_train)
    if not model.is_fitted:
        return uid, results, preds_out

    for h in horizons:
        target_col = config["target_columns"][h]
        notna = u_val[target_col].notna()
        actuals = u_val.loc[notna, target_col].values
        ts_all = u_val.loc[notna, dt_col].values

        # Forecast at this horizon
        future = pd.DataFrame({"ds": prophet_val["ds"].values})
        future["ds"] = future["ds"] + pd.Timedelta(hours=h)
        try:
            forecast = model.model.predict(future)
            preds = forecast["yhat"].values
        except Exception as e:
            logger.warning("Prophet predict failed for unit %s h=%d: %s", uid, h, e)
            continue

        preds = np.asarray(preds, dtype=float)
        n = min(len(preds), len(actuals))
        if n == 0:
            continue
        preds, actuals, ts_h = preds[:n], actuals[:n], ts_all[:n]
        mask = ~np.isnan(preds)
        if mask.sum() > 0:
            results[h] = evaluate_model(actuals[mask], preds[mask])
            preds_out[h] = {"timestamp": ts_h[mask],
                            "residual": actuals[mask] - preds[mask]}

    # Save
    model_dir = Path(config["output"]["models_dir"]) / str(uid)
    model.save(model_dir / "prophet.joblib")

    del model
    gc.collect()
    return uid, results, preds_out


def _train_lstm_unit(uid, u_train, u_val, horizons, config):
    """Train LSTM per horizon for one unit."""
    results = {}
    preds_out = {}
    for h in horizons:
        lstm_data = prepare_lstm_sequences(u_train, u_val, u_val, config, h)

        if lstm_data["X_train"].size == 0 or lstm_data["X_val"].size == 0:
            continue

        model = LSTMModel(config, h)
        model.train(
            lstm_data["X_train"], lstm_data["y_train"],
            lstm_data["X_val"], lstm_data["y_val"],
        )
        preds = model.predict(lstm_data["X_val"])
        y_val = lstm_data["y_val"]
        results[h] = evaluate_model(y_val, preds)

        ts = lstm_data.get("ts_val", np.array([]))
        if len(ts) == len(preds):
            preds_out[h] = {
                "timestamp": ts,
                "residual": np.asarray(y_val, dtype=float) - np.asarray(preds, dtype=float),
            }

        model_dir = Path(config["output"]["models_dir"]) / str(uid)
        model.save(model_dir / f"lstm_{h}h")
        joblib.dump(lstm_data["scaler"], model_dir / f"lstm_scaler_{h}h.joblib")

        del model, lstm_data
        gc.collect()

    return uid, results, preds_out


# ======================================================================
# ModelRegistry class
# ======================================================================

class ModelRegistry:
    """Orchestrates per-unit, per-horizon training with parallel execution."""

    def __init__(self, config: dict):
        self.config = config
        self.horizons = config["forecast_horizons"]
        # results[model_name][unit_id][horizon] = metrics_dict
        self.results: dict[str, dict[int, dict[int, dict]]] = {}
        # prediction_records[model_name][unit_id][horizon] =
        #   {"timestamp": np.ndarray, "residual": np.ndarray}
        self.prediction_records: dict[str, dict[int, dict[int, dict]]] = {}

    def train_all(
        self,
        train_df: pd.DataFrame,
        val_df: pd.DataFrame,
    ) -> dict:
        """Train all enabled models per unit per horizon (parallelized)."""
        config = self.config
        unit_col = config["data"]["unit_col"]
        units = sorted(train_df[unit_col].unique())

        logger.info("Training all models: %d units × %d horizons (parallel=%s)",
                     len(units), len(self.horizons), N_JOBS)

        # Add cyclical features once
        train_feat = add_cyclical_features(train_df)
        val_feat = add_cyclical_features(val_df)

        # Pre-filter per unit (avoids redundant filtering in parallel workers)
        unit_data = {}
        for uid in units:
            unit_data[uid] = {
                "train": filter_unit(train_feat, uid, config),
                "val": filter_unit(val_feat, uid, config),
                "train_raw": filter_unit(train_df, uid, config),
                "val_raw": filter_unit(val_df, uid, config),
            }

        # --- Tabular models (RF, LightGBM) — parallel across units ---
        for ModelClass, name, cfg_key in [
            (RandomForestModel, "RandomForest", "random_forest"),
            (LightGBMModel, "LightGBM", "lightgbm"),
        ]:
            if not config["models"][cfg_key].get("enabled", True):
                continue
            logger.info("Training %s (parallel across %d units)...", name, len(units))

            results_list = Parallel(n_jobs=N_JOBS, verbose=0)(
                delayed(_train_tabular_unit)(
                    ModelClass, name, uid,
                    unit_data[uid]["train"], unit_data[uid]["val"],
                    self.horizons, config,
                )
                for uid in units
            )
            self.results[name] = {uid: res for uid, res, _ in results_list}
            self.prediction_records[name] = {uid: pr for uid, _, pr in results_list}
            self._log_model_summary(name)

        # --- ARIMA — train once per unit, parallel across units ---
        if config["models"]["arima"].get("enabled", True):
            logger.info("Training ARIMA (parallel across %d units, train-once)...", len(units))

            results_list = Parallel(n_jobs=N_JOBS, verbose=0)(
                delayed(_train_arima_unit)(
                    uid, unit_data[uid]["train_raw"], unit_data[uid]["val_raw"],
                    self.horizons, config,
                )
                for uid in units
            )
            self.results["ARIMA"] = {uid: res for uid, res, _ in results_list}
            self.prediction_records["ARIMA"] = {uid: pr for uid, _, pr in results_list}
            self._log_model_summary("ARIMA")

        # --- Prophet — train once per unit, parallel across units ---
        if config["models"]["prophet"].get("enabled", True):
            logger.info("Training Prophet (parallel across %d units, train-once)...", len(units))

            results_list = Parallel(n_jobs=N_JOBS, verbose=0)(
                delayed(_train_prophet_unit)(
                    uid, unit_data[uid]["train_raw"], unit_data[uid]["val_raw"],
                    self.horizons, config,
                )
                for uid in units
            )
            self.results["Prophet"] = {uid: res for uid, res, _ in results_list}
            self.prediction_records["Prophet"] = {uid: pr for uid, _, pr in results_list}
            self._log_model_summary("Prophet")

        # --- LSTM — parallel across units ---
        if config["models"]["lstm"].get("enabled", True):
            logger.info("Training LSTM (parallel across %d units)...", len(units))

            results_list = Parallel(n_jobs=N_JOBS, verbose=0)(
                delayed(_train_lstm_unit)(
                    uid, unit_data[uid]["train"], unit_data[uid]["val"],
                    self.horizons, config,
                )
                for uid in units
            )
            self.results["LSTM"] = {uid: res for uid, res, _ in results_list}
            self.prediction_records["LSTM"] = {uid: pr for uid, _, pr in results_list}
            self._log_model_summary("LSTM")

        # --- Ensemble ---
        if config["models"]["ensemble"].get("enabled", True):
            self._build_ensembles(units)

        self._print_summary()
        return self.results

    def _build_ensembles(self, units):
        """Compute ensemble weights per unit per horizon from validation metrics."""
        config = self.config
        name = "Ensemble"
        self.results[name] = {}
        individual_models = [m for m in self.results if m != name]

        for uid in units:
            self.results[name][uid] = {}
            for h in self.horizons:
                val_metrics = {}
                for mn in individual_models:
                    if uid in self.results[mn] and h in self.results[mn][uid]:
                        m = self.results[mn][uid][h]
                        if not np.isnan(m.get("mape", np.nan)):
                            val_metrics[mn] = m

                if len(val_metrics) < 2:
                    continue

                ensemble = EnsembleModel(config, h)
                ensemble.compute_weights(val_metrics)

                model_dir = Path(config["output"]["models_dir"]) / str(uid)
                model_dir.mkdir(parents=True, exist_ok=True)
                ensemble.save(model_dir / f"ensemble_weights_{h}h.json")

                # Estimated ensemble metrics (weighted avg of individual)
                ens_metrics = {}
                for metric in ["mae", "rmse", "mape", "within_2_patients_pct"]:
                    weighted = sum(
                        ensemble.weights[mn] * val_metrics[mn][metric]
                        for mn in ensemble.weights
                    )
                    ens_metrics[metric] = round(weighted, 2)
                self.results[name][uid][h] = ens_metrics

    def export_results(self, output_dir: str | Path = None) -> None:
        """Export comparison tables to CSV."""
        if output_dir is None:
            output_dir = Path(self.config["output"]["reports_dir"])
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        rows = []
        for model_name, units in self.results.items():
            for uid, horizons in units.items():
                for h, metrics in horizons.items():
                    rows.append({"model": model_name, "unit_id": uid, "horizon": h, **metrics})

        if rows:
            df = pd.DataFrame(rows).sort_values(["model", "unit_id", "horizon"])
            df.to_csv(output_dir / "model_comparison.csv", index=False)

            agg = (
                df.groupby(["model", "horizon"])
                .agg({"mae": "mean", "rmse": "mean", "mape": "mean",
                       "within_2_patients_pct": "mean"})
                .round(2).reset_index()
                .sort_values(["horizon", "model"])
            )
            agg.to_csv(output_dir / "model_comparison_aggregated.csv", index=False)

            best = agg.loc[agg.groupby("horizon")["within_2_patients_pct"].idxmax()]
            best[["horizon", "model", "within_2_patients_pct", "mae"]].to_csv(
                output_dir / "best_model_per_horizon.csv", index=False
            )
            logger.info("Exported results to %s", output_dir)

    # ------------------------------------------------------------------
    # Statistical diagnostics
    # ------------------------------------------------------------------

    def residual_diagnostics_table(self) -> pd.DataFrame:
        """Per (model, unit, horizon) residual normality/autocorrelation tests."""
        rows = []
        for model_name, units in self.prediction_records.items():
            for uid, horizons in units.items():
                for h, rec in horizons.items():
                    diag = residual_diagnostics(rec["residual"])
                    rows.append({"model": model_name, "unit_id": uid,
                                 "horizon": h, **diag})
        return pd.DataFrame(rows)

    def significance_tests(self) -> tuple[pd.DataFrame, pd.DataFrame]:
        """Diebold-Mariano: per (unit, horizon) test the lowest-error model
        against the runner-up on their common validation timestamps.

        Returns (detail, summary). detail has one row per (unit, horizon);
        summary aggregates per horizon (units tested, share significant).
        """
        # Regroup residual series by (unit, horizon) → {model: Series}.
        by_unit_h: dict[tuple, dict[str, pd.Series]] = {}
        for model_name, units in self.prediction_records.items():
            for uid, horizons in units.items():
                for h, rec in horizons.items():
                    s = pd.Series(rec["residual"],
                                  index=pd.Index(rec["timestamp"], name="timestamp"))
                    s = s[~s.index.duplicated(keep="first")]
                    by_unit_h.setdefault((uid, h), {})[model_name] = s

        detail = []
        for (uid, h), model_series in by_unit_h.items():
            if len(model_series) < 2:
                continue
            aligned = pd.concat(model_series, axis=1, join="inner").dropna()
            if len(aligned) < 8:
                continue
            mse = {m: float(np.mean(aligned[m].values ** 2)) for m in aligned.columns}
            ordered = sorted(mse, key=mse.get)
            best, runner = ordered[0], ordered[1]
            dm = diebold_mariano(aligned[best].values, aligned[runner].values, horizon=h)
            significant = (
                not np.isnan(dm["p_value"])
                and dm["p_value"] < 0.05
                and dm["mean_loss_diff"] < 0
            )
            detail.append({
                "unit_id": uid, "horizon": h,
                "best_model": best, "runner_up": runner,
                "n_pairs": dm["n"],
                "best_mse": round(mse[best], 4),
                "runner_up_mse": round(mse[runner], 4),
                "dm_stat": round(dm["dm_stat"], 4) if not np.isnan(dm["dm_stat"]) else np.nan,
                "p_value": round(dm["p_value"], 4) if not np.isnan(dm["p_value"]) else np.nan,
                "significant": bool(significant),
            })

        detail_df = pd.DataFrame(detail)
        if detail_df.empty:
            return detail_df, pd.DataFrame()

        summary_rows = []
        for h, g in detail_df.groupby("horizon"):
            modes = g["best_model"].mode()
            summary_rows.append({
                "horizon": h,
                "n_units": len(g),
                "n_significant": int(g["significant"].sum()),
                "pct_significant": round(100 * g["significant"].mean(), 1),
                "modal_best_model": modes.iloc[0] if not modes.empty else "",
            })
        return detail_df, pd.DataFrame(summary_rows)

    def export_diagnostics(self, output_dir: str | Path = None) -> None:
        """Write residual-diagnostic and Diebold-Mariano tables to CSV."""
        if output_dir is None:
            output_dir = Path(self.config["output"]["reports_dir"])
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        diag = self.residual_diagnostics_table()
        if not diag.empty:
            diag.sort_values(["model", "unit_id", "horizon"]).to_csv(
                output_dir / "residual_diagnostics.csv", index=False)
            logger.info("Exported residual_diagnostics.csv (%d rows)", len(diag))

        detail, summary = self.significance_tests()
        if not detail.empty:
            detail.sort_values(["horizon", "unit_id"]).to_csv(
                output_dir / "dm_test_results.csv", index=False)
            summary.to_csv(output_dir / "dm_test_summary.csv", index=False)
            n_sig = int(detail["significant"].sum())
            logger.info("Exported dm_test_results.csv (%d comparisons, %d significant) "
                        "+ dm_test_summary.csv", len(detail), n_sig)
        else:
            logger.warning("No Diebold-Mariano comparisons produced "
                           "(need ≥2 models with ≥8 common validation points per unit/horizon)")

    # ------------------------------------------------------------------
    # Logging
    # ------------------------------------------------------------------

    def _log_model_summary(self, model_name):
        """Log per-unit summary for a model."""
        model_results = self.results.get(model_name, {})
        for uid in sorted(model_results.keys()):
            horizons = model_results[uid]
            if not horizons:
                continue
            accs = [m["within_2_patients_pct"] for h, m in sorted(horizons.items())
                    if not np.isnan(m.get("within_2_patients_pct", np.nan))]
            if accs:
                logger.info("  %-12s unit %-12s  ±2: %.1f%% (1h) → %.1f%% (72h), mean=%.1f%%",
                            model_name, uid, accs[0], accs[-1], np.mean(accs))

    def _print_summary(self):
        """Print aggregated results table."""
        logger.info("=" * 70)
        logger.info("VALIDATION RESULTS (mean ±2 accuracy across units)")
        header = f"{'Model':<15} " + " ".join(f"{h:>5}h" for h in self.horizons)
        logger.info(header)
        logger.info("-" * 70)

        for model_name in self.results:
            accs = []
            for h in self.horizons:
                unit_accs = [
                    self.results[model_name][uid][h]["within_2_patients_pct"]
                    for uid in self.results[model_name]
                    if h in self.results[model_name][uid]
                    and not np.isnan(self.results[model_name][uid][h].get("within_2_patients_pct", np.nan))
                ]
                accs.append(f"{np.mean(unit_accs):5.1f}" if unit_accs else "  N/A")
            logger.info(f"{model_name:<15} " + " ".join(accs))
        logger.info("=" * 70)
