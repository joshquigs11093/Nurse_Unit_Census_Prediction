"""LightGBM regressor for census prediction."""

import logging
from pathlib import Path

import joblib
import numpy as np
import lightgbm as lgb

from .base_model import BaseModel

logger = logging.getLogger(__name__)


class LightGBMModel(BaseModel):
    """
    LightGBM regressor — one model per horizon across all units.
    Supports early stopping on validation set.
    """

    def __init__(self, config: dict, horizon: int):
        super().__init__(config, horizon)
        self.lgbm_cfg = config["models"]["lightgbm"]
        self.model = None

    def train(self, X_train, y_train, X_val=None, y_val=None):
        logger.info("Training LightGBM for horizon %dh (%d samples, %d features)",
                     self.horizon, X_train.shape[0], X_train.shape[1])

        params = {
            "n_estimators": self.lgbm_cfg["n_estimators"],
            "max_depth": self.lgbm_cfg["max_depth"],
            "learning_rate": self.lgbm_cfg["learning_rate"],
            "num_leaves": self.lgbm_cfg["num_leaves"],
            "min_child_samples": self.lgbm_cfg["min_child_samples"],
            "subsample": self.lgbm_cfg["subsample"],
            "colsample_bytree": self.lgbm_cfg["colsample_bytree"],
            "random_state": self.lgbm_cfg["random_state"],
            "n_jobs": -1,
            "verbosity": -1,
        }

        self.model = lgb.LGBMRegressor(**params)

        fit_kwargs = {}
        if X_val is not None and y_val is not None:
            fit_kwargs["eval_set"] = [(X_val, y_val)]
            fit_kwargs["callbacks"] = [
                lgb.early_stopping(self.lgbm_cfg["early_stopping_rounds"], verbose=False),
                lgb.log_evaluation(period=0),
            ]

        self.model.fit(X_train, y_train, **fit_kwargs)
        self.is_fitted = True

        best_iter = getattr(self.model, "best_iteration_", self.lgbm_cfg["n_estimators"])
        logger.info("  Best iteration: %d", best_iter)
        return self

    def predict(self, X) -> np.ndarray:
        return self.model.predict(X)

    def get_feature_importance(self) -> np.ndarray:
        return self.model.feature_importances_

    def save(self, path: str | Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(self.model, path)
        logger.info("Saved LightGBM model to %s", path)

    def load(self, path: str | Path):
        self.model = joblib.load(path)
        self.is_fitted = True
        return self
