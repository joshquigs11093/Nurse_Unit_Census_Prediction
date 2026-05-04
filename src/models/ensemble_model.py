"""Weighted ensemble model — combines predictions from individual models."""

import json
import logging
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)


class EnsembleModel:
    """
    Weighted average ensemble. Weights are computed as inverse MAPE
    from validation set performance, normalized to sum to 1.
    """

    def __init__(self, config: dict, horizon: int):
        self.config = config
        self.horizon = horizon
        self.weights = {}  # model_name -> weight
        self.is_fitted = False

    def compute_weights(self, val_metrics: dict[str, dict]) -> dict[str, float]:
        """
        Compute ensemble weights from validation metrics.

        Parameters
        ----------
        val_metrics : {model_name: {"mape": float, ...}}

        Returns
        -------
        Normalized weight dict.
        """
        inverse_mape = {}
        for model_name, metrics in val_metrics.items():
            mape = metrics.get("mape", None)
            if mape is not None and mape > 0:
                inverse_mape[model_name] = 1.0 / mape
            else:
                logger.warning("Skipping %s for ensemble (MAPE=%s)", model_name, mape)

        if not inverse_mape:
            # Fallback: equal weights
            n = len(val_metrics)
            self.weights = {name: 1.0 / n for name in val_metrics}
        else:
            total = sum(inverse_mape.values())
            self.weights = {name: w / total for name, w in inverse_mape.items()}

        self.is_fitted = True
        logger.info("Ensemble weights for horizon %dh: %s",
                     self.horizon,
                     {k: round(v, 4) for k, v in self.weights.items()})
        return self.weights

    def predict(self, predictions: dict[str, np.ndarray]) -> np.ndarray:
        """
        Weighted average of model predictions.

        Parameters
        ----------
        predictions : {model_name: predictions_array}
        """
        weighted_sum = None
        total_weight = 0.0

        for model_name, preds in predictions.items():
            if model_name not in self.weights:
                continue
            w = self.weights[model_name]
            if weighted_sum is None:
                weighted_sum = w * preds
            else:
                weighted_sum += w * preds
            total_weight += w

        if weighted_sum is None:
            raise ValueError("No valid predictions for ensemble")

        # Re-normalize in case some models were missing
        if total_weight > 0 and abs(total_weight - 1.0) > 1e-6:
            weighted_sum /= total_weight

        return weighted_sum

    def save(self, path: str | Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {"horizon": self.horizon, "weights": self.weights}
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
        logger.info("Saved ensemble weights to %s", path)

    def load(self, path: str | Path):
        with open(path, "r") as f:
            data = json.load(f)
        self.weights = data["weights"]
        self.horizon = data["horizon"]
        self.is_fitted = True
        return self
