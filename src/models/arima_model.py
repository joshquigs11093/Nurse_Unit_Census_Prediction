"""ARIMA/SARIMA model for census prediction — single unit, single horizon."""

import json
import logging
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from statsmodels.tsa.statespace.sarimax import SARIMAX

from .base_model import BaseModel

logger = logging.getLogger(__name__)

TRAIN_WINDOW_HOURS = 24 * 90  # last 3 months of hourly data


class ARIMAModel(BaseModel):
    """SARIMA for a single nurse unit. Trains on CENSUS, forecasts forward."""

    def __init__(self, config: dict, horizon: int):
        super().__init__(config, horizon)
        self.arima_cfg = config["models"]["arima"]
        self.model = None
        self.model_params = None  # lightweight dict for serialization

    def train(self, train_df: pd.DataFrame, y_train=None, X_val=None, y_val=None):
        """
        Fit SARIMA on a single unit's CENSUS time series.

        Expects train_df already filtered to one unit, sorted by time.
        """
        dt_col = self.config["data"]["datetime_col"]
        census_col = self.config["data"]["census_col"]
        seasonal_period = self.arima_cfg["seasonal_period"]

        series = train_df.set_index(dt_col)[census_col]

        # Use recent window for speed and memory
        if len(series) > TRAIN_WINDOW_HOURS:
            series = series.iloc[-TRAIN_WINDOW_HOURS:]

        if len(series) < seasonal_period * 3:
            logger.warning("Only %d obs, too few for ARIMA", len(series))
            return self

        try:
            import pmdarima as pm
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                self.model = pm.auto_arima(
                    series,
                    seasonal=True,
                    m=seasonal_period,
                    max_p=self.arima_cfg["max_p"],
                    max_q=self.arima_cfg["max_q"],
                    max_P=2, max_Q=2, max_d=2, max_D=1,
                    stepwise=True,
                    suppress_warnings=True,
                    error_action="ignore",
                    n_fits=30,
                )
            self.model_params = {
                "order": self.model.order,
                "seasonal_order": self.model.seasonal_order,
            }
        except ImportError:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                self.model = SARIMAX(
                    series,
                    order=(2, 1, 2),
                    seasonal_order=(1, 1, 1, seasonal_period),
                    enforce_stationarity=False,
                    enforce_invertibility=False,
                ).fit(disp=False, maxiter=200)
            self.model_params = {
                "order": (2, 1, 2),
                "seasonal_order": (1, 1, 1, seasonal_period),
            }

        self.is_fitted = True
        return self

    def predict(self, X) -> np.ndarray:
        """
        Forecast n_steps ahead. X is the number of steps or ignored if array.

        Returns 1D array of predictions.
        """
        if self.model is None:
            return np.array([])

        n_steps = X if isinstance(X, int) else len(X)

        try:
            if hasattr(self.model, "predict"):
                # pmdarima
                fc = self.model.predict(n_periods=n_steps + self.horizon)
            else:
                # statsmodels
                fc = self.model.forecast(steps=n_steps + self.horizon)
            return fc[self.horizon: self.horizon + n_steps]
        except Exception as e:
            logger.warning("ARIMA predict failed: %s", e)
            return np.full(n_steps, np.nan)

    def save(self, path: str | Path):
        path = Path(path).with_suffix(".json")
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(self.model_params, f, indent=2)
        logger.debug("Saved ARIMA params to %s", path)

    def load(self, path: str | Path):
        path = Path(path).with_suffix(".json")
        with open(path) as f:
            self.model_params = json.load(f)
        self.is_fitted = True
        return self
