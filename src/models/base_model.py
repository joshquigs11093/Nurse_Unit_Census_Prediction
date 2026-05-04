"""Abstract base class for all census prediction models."""

from abc import ABC, abstractmethod
from pathlib import Path

import numpy as np


class BaseModel(ABC):
    """Common interface for all model implementations."""

    def __init__(self, config: dict, horizon: int):
        self.config = config
        self.horizon = horizon
        self.is_fitted = False

    @abstractmethod
    def train(self, X_train, y_train, X_val=None, y_val=None):
        """Train the model. Return self."""

    @abstractmethod
    def predict(self, X) -> np.ndarray:
        """Return predictions array."""

    @abstractmethod
    def save(self, path: str | Path):
        """Serialize model to disk."""

    @abstractmethod
    def load(self, path: str | Path):
        """Load model from disk."""

    @property
    def name(self) -> str:
        return self.__class__.__name__
