"""Inference wrapper for the trained stem-role classifier.

Loads the joblib artifact produced by ``ml.train_stem_classifier`` and exposes
buffer-level, file-level and batch prediction. The artifact is cached per
process so a batch job pays the load cost once.

Nothing here is a neural network. It is a gradient-boosted decision tree
ensemble over engineered spectral features, and it is named accordingly.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np

from ml.audio_features import N_FEATURES, extract_features, extract_from_file

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEFAULT_MODEL_PATH = os.path.join(REPO, "models", "stem_classifier.joblib")

#: How the 4 trained roles map onto the ``stem_type`` vocabulary the
#: arrangement engine already understands.
ROLE_TO_STEM_TYPE = {
    "drums": "rhythm",
    "bass": "bass",
    "vocals": "vocal",
    "other": "harmonic",
}


@dataclass(frozen=True)
class Prediction:
    """One slice's predicted stem role."""

    role: str
    confidence: float
    stem_type: str
    probabilities: dict[str, float]


class StemClassifier:
    """Thin predictor around the saved sklearn pipeline."""

    def __init__(self, model_path: str = DEFAULT_MODEL_PATH):
        if not os.path.isfile(model_path):
            raise FileNotFoundError(
                f"No stem classifier at {model_path}. "
                "Train one with: python engine/train_stem_classifier.py"
            )
        try:
            import joblib

            artifact = joblib.load(model_path)
        except Exception:
            import pickle

            with open(model_path, "rb") as handle:
                artifact = pickle.load(handle)
        self.model = artifact["model"]
        self.labels: list[str] = list(artifact["labels"])
        self.metrics: dict = artifact.get("metrics", {})
        self.n_features: int = int(artifact.get("n_features", N_FEATURES))
        self.model_path = model_path

    # -- core -----------------------------------------------------------
    def predict_matrix(self, X: np.ndarray) -> list[Prediction]:
        """Predict for an ``(n, n_features)`` matrix."""
        X = np.asarray(X, dtype=np.float32)
        if X.ndim == 1:
            X = X[None, :]
        if X.shape[1] != self.n_features:
            raise ValueError(
                f"expected {self.n_features} features, got {X.shape[1]}"
            )
        proba = self.model.predict_proba(X)
        classes = list(self.model.classes_)
        out: list[Prediction] = []
        for row in proba:
            best = int(np.argmax(row))
            role = str(classes[best])
            out.append(
                Prediction(
                    role=role,
                    confidence=float(row[best]),
                    stem_type=ROLE_TO_STEM_TYPE.get(role, "harmonic"),
                    probabilities={str(c): float(p) for c, p in zip(classes, row)},
                )
            )
        return out

    def predict_buffer(self, mono: np.ndarray, sr: int) -> Prediction:
        """Predict from an in-memory audio buffer."""
        return self.predict_matrix(extract_features(mono, sr)[None, :])[0]

    def predict_file(self, path: str) -> Prediction | None:
        """Predict from a wav path. ``None`` if the file cannot be read."""
        vec = extract_from_file(path)
        if vec is None:
            return None
        return self.predict_matrix(vec[None, :])[0]


_CACHED: dict[str, StemClassifier] = {}


def load_classifier(model_path: str = DEFAULT_MODEL_PATH) -> StemClassifier:
    """Process-cached loader."""
    key = os.path.abspath(model_path)
    if key not in _CACHED:
        _CACHED[key] = StemClassifier(model_path)
    return _CACHED[key]


def is_enabled() -> bool:
    """Feature flag. The ML labeller stays off unless explicitly switched on."""
    return (os.environ.get("HYBRID_STEM_ML", "").strip().lower()
            in {"1", "true", "yes", "on"})
