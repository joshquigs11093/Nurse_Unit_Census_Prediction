"""Shared utilities: config loading, logging, seed management."""

import logging
import random
from pathlib import Path

import numpy as np
import yaml


def load_config(config_path: str = "config/config.yaml") -> dict:
    """Load YAML config file and return as dict."""
    path = Path(config_path)
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {path}")
    with open(path, "r") as f:
        return yaml.safe_load(f)


def setup_logging(level: int = logging.INFO) -> None:
    """Configure root logger with consistent format."""
    logging.basicConfig(
        level=level,
        format="%(asctime)s | %(name)-30s | %(levelname)-7s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def set_random_seeds(seed: int = 42) -> None:
    """Set random seeds for reproducibility across numpy, random, and tensorflow."""
    random.seed(seed)
    np.random.seed(seed)
    try:
        import torch
        torch.manual_seed(seed)
    except ImportError:
        pass
