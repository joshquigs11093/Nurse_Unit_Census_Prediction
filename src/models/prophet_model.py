"""Prophet model for census prediction — single unit, single horizon."""

import logging
import warnings
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from .base_model import BaseModel

logger = logging.getLogger(__name__)


class ProphetModel(BaseModel):
    """Facebook Prophet for a single nurse unit. Captures daily/weekly/yearly seasonality."""

    def __init__(self, config: dict, horizon: int):
        super().__init__(config, horizon)
        self.prophet_cfg = config["models"]["prophet"]
        self.model = None

    def train(self, train_df: pd.DataFrame, y_train=None, X_val=None, y_val=None):
        """
        Fit Prophet on a single unit.

        Expects train_df with columns 'ds' (datetime) and 'y' (census).
        Use prepare_prophet_data() to create this format.
        """
        from prophet import Prophet

        if len(train_df) < 48:
            logger.warning("Only %d obs, too few for Prophet", len(train_df))
            return self

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.model = Prophet(
                yearly_seasonality=self.prophet_cfg["yearly_seasonality"],
                weekly_seasonality=self.prophet_cfg["weekly_seasonality"],
                daily_seasonality=self.prophet_cfg["daily_seasonality"],
                changepoint_prior_scale=self.prophet_cfg["changepoint_prior_scale"],
            )
            self.model.add_country_holidays(country_name="US")
            self.model.fit(train_df)

        self.is_fitted = True
        return self

    def predict(self, X) -> np.ndarray:
        """
        Forecast for given timestamps.

        X : DataFrame with 'ds' column, or int (number of periods to forecast).
        Returns 1D array of predictions.
        """
        if self.model is None:
            n = X if isinstance(X, int) else len(X)
            return np.full(n, np.nan)

        if isinstance(X, int):
            future = self.model.make_future_dataframe(periods=X, freq="h")
            future = future.tail(X)
        else:
            future = pd.DataFrame({"ds": X["ds"].values})
            # Shift forward by horizon hours for the forecast target time
            future["ds"] = future["ds"] + pd.Timedelta(hours=self.horizon)

        forecast = self.model.predict(future)
        return forecast["yhat"].values

    def save(self, path: str | Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(self.model, path)
        logger.debug("Saved Prophet model to %s", path)

    def load(self, path: str | Path):
        self.model = joblib.load(path)
        self.is_fitted = True
        return self
