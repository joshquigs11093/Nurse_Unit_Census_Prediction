"""Random Forest regressor for census prediction."""

import logging
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestRegressor

from .base_model import BaseModel

logger = logging.getLogger(__name__)


class RandomForestModel(BaseModel):
    """
    Sklearn RandomForestRegressor — one model per horizon across all units.
    Unit ID is included as a label-encoded feature.
    """

    def __init__(self, config: dict, horizon: int):
        super().__init__(config, horizon)
        rf_cfg = config["models"]["random_forest"]
        self.model = RandomForestRegressor(
            n_estimators=rf_cfg["n_estimators"],
            max_depth=rf_cfg["max_depth"],
            min_samples_split=rf_cfg["min_samples_split"],
            min_samples_leaf=rf_cfg["min_samples_leaf"],
            random_state=rf_cfg["random_state"],
            n_jobs=-1,
        )

    def train(self, X_train, y_train, X_val=None, y_val=None):
        logger.info("Training Random Forest for horizon %dh (%d samples, %d features)",
                     self.horizon, X_train.shape[0], X_train.shape[1])
        self.model.fit(X_train, y_train)
        self.is_fitted = True

        if X_val is not None and y_val is not None:
            val_score = self.model.score(X_val, y_val)
            logger.info("  Validation R²: %.4f", val_score)

        return self

    def predict(self, X) -> np.ndarray:
        return self.model.predict(X)

    def get_feature_importance(self) -> np.ndarray:
        return self.model.feature_importances_

    def save(self, path: str | Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(self.model, path)
        logger.info("Saved RF model to %s", path)

    def load(self, path: str | Path):
        self.model = joblib.load(path)
        self.is_fitted = True
        return self
