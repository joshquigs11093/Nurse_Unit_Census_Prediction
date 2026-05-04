"""LSTM model for census prediction using PyTorch."""

import logging
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

from .base_model import BaseModel

logger = logging.getLogger(__name__)

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


class _LSTMNetwork(nn.Module):
    """Stacked LSTM with dropout for regression."""

    def __init__(self, n_features: int, hidden_units: int, num_layers: int, dropout: float):
        super().__init__()
        self.lstm = nn.LSTM(
            input_size=n_features,
            hidden_size=hidden_units,
            num_layers=num_layers,
            dropout=dropout if num_layers > 1 else 0.0,
            batch_first=True,
        )
        self.dropout = nn.Dropout(dropout)
        self.fc = nn.Linear(hidden_units, 1)

    def forward(self, x):
        lstm_out, _ = self.lstm(x)
        # Take the last time step
        last_hidden = lstm_out[:, -1, :]
        out = self.dropout(last_hidden)
        return self.fc(out).squeeze(-1)


class LSTMModel(BaseModel):
    """
    Stacked LSTM trained per horizon across all units using PyTorch.
    """

    def __init__(self, config: dict, horizon: int):
        super().__init__(config, horizon)
        self.lstm_cfg = config["models"]["lstm"]
        self.model = None

    def train(self, X_train, y_train, X_val=None, y_val=None):
        """
        Train LSTM on pre-built sequences.

        Parameters
        ----------
        X_train : ndarray of shape (n_samples, sequence_length, n_features)
        y_train : ndarray of shape (n_samples,)
        """
        n_features = X_train.shape[2]
        logger.info("Training LSTM for horizon %dh (%d samples, seq_len=%d, %d features)",
                     self.horizon, X_train.shape[0], X_train.shape[1], n_features)

        self.model = _LSTMNetwork(
            n_features=n_features,
            hidden_units=self.lstm_cfg["hidden_units"],
            num_layers=self.lstm_cfg["num_layers"],
            dropout=self.lstm_cfg["dropout"],
        ).to(device)

        optimizer = torch.optim.Adam(self.model.parameters(), lr=self.lstm_cfg["learning_rate"])
        criterion = nn.MSELoss()

        # DataLoaders
        train_ds = TensorDataset(
            torch.tensor(X_train, dtype=torch.float32),
            torch.tensor(y_train, dtype=torch.float32),
        )
        train_loader = DataLoader(train_ds, batch_size=self.lstm_cfg["batch_size"], shuffle=True)

        val_loader = None
        if X_val is not None and y_val is not None and len(X_val) > 0:
            val_ds = TensorDataset(
                torch.tensor(X_val, dtype=torch.float32),
                torch.tensor(y_val, dtype=torch.float32),
            )
            val_loader = DataLoader(val_ds, batch_size=self.lstm_cfg["batch_size"])

        best_val_loss = float("inf")
        best_state = None
        patience_counter = 0
        patience = self.lstm_cfg["early_stopping_patience"]

        for epoch in range(self.lstm_cfg["epochs"]):
            # Train
            self.model.train()
            train_loss = 0.0
            for X_batch, y_batch in train_loader:
                X_batch, y_batch = X_batch.to(device), y_batch.to(device)
                optimizer.zero_grad()
                preds = self.model(X_batch)
                loss = criterion(preds, y_batch)
                loss.backward()
                optimizer.step()
                train_loss += loss.item() * len(X_batch)
            train_loss /= len(train_ds)

            # Validate
            if val_loader is not None:
                self.model.eval()
                val_loss = 0.0
                with torch.no_grad():
                    for X_batch, y_batch in val_loader:
                        X_batch, y_batch = X_batch.to(device), y_batch.to(device)
                        preds = self.model(X_batch)
                        val_loss += criterion(preds, y_batch).item() * len(X_batch)
                val_loss /= len(val_ds)

                if val_loss < best_val_loss:
                    best_val_loss = val_loss
                    best_state = {k: v.cpu().clone() for k, v in self.model.state_dict().items()}
                    patience_counter = 0
                else:
                    patience_counter += 1
                    if patience_counter >= patience:
                        logger.info("  Early stopping at epoch %d", epoch + 1)
                        break
            else:
                # No validation — just track training loss
                if train_loss < best_val_loss:
                    best_val_loss = train_loss
                    best_state = {k: v.cpu().clone() for k, v in self.model.state_dict().items()}

        # Restore best weights
        if best_state is not None:
            self.model.load_state_dict(best_state)
        self.model.eval()
        self.is_fitted = True

        logger.info("  Trained %d epochs, best loss: %.4f", epoch + 1, best_val_loss)
        return self

    def predict(self, X) -> np.ndarray:
        """Predict from sequence input. Returns 1D array."""
        self.model.eval()
        X_tensor = torch.tensor(X, dtype=torch.float32).to(device)
        with torch.no_grad():
            preds = self.model(X_tensor).cpu().numpy()
        return preds

    def save(self, path: str | Path):
        path = Path(path).with_suffix(".pt")
        path.parent.mkdir(parents=True, exist_ok=True)
        torch.save(self.model.state_dict(), path)
        # Also save architecture params for loading
        meta_path = path.with_suffix(".meta.pt")
        torch.save({
            "n_features": self.model.lstm.input_size,
            "hidden_units": self.model.lstm.hidden_size,
            "num_layers": self.model.lstm.num_layers,
            "dropout": self.model.dropout.p,
        }, meta_path)
        logger.info("Saved LSTM model to %s", path)

    def load(self, path: str | Path):
        path = Path(path).with_suffix(".pt")
        meta_path = path.with_suffix(".meta.pt")
        meta = torch.load(meta_path, weights_only=True)
        self.model = _LSTMNetwork(
            n_features=meta["n_features"],
            hidden_units=meta["hidden_units"],
            num_layers=meta["num_layers"],
            dropout=meta["dropout"],
        ).to(device)
        self.model.load_state_dict(torch.load(path, weights_only=True))
        self.model.eval()
        self.is_fitted = True
        return self
