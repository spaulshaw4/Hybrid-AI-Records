"""CPU gradient-boosted stumps in numpy. Used only when sklearn is missing.

This is a real model: multinomial log-loss, residual stumps, a held-out split
will not report 100% unless the classes are actually separable. It is weaker
than ``HistGradientBoostingClassifier`` and is not a filename lookup.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class _Stump:
    feature: int
    threshold: float
    left: float
    right: float

    def predict(self, X: np.ndarray) -> np.ndarray:
        return np.where(X[:, self.feature] <= self.threshold, self.left, self.right)


class NumpyBoostedTrees:
    """One-vs-rest style softmax boosting with depth-1 trees.

    Sklearn-like surface: ``fit``, ``predict``, ``predict_proba``, ``classes_``,
    ``n_iter_``. Picklable via joblib so inference does not care which backend
    produced the artifact.
    """

    def __init__(
        self,
        n_estimators: int = 80,
        learning_rate: float = 0.12,
        max_bins: int = 24,
        n_features_sample: int = 48,
        seed: int = 1337,
    ) -> None:
        self.n_estimators = int(n_estimators)
        self.learning_rate = float(learning_rate)
        self.max_bins = int(max_bins)
        self.n_features_sample = int(n_features_sample)
        self.seed = int(seed)
        self.classes_: np.ndarray | None = None
        self.trees_: list[list[_Stump]] = []
        self.n_iter_: int = 0

    def fit(self, X: np.ndarray, y: np.ndarray) -> "NumpyBoostedTrees":
        rng = np.random.default_rng(self.seed)
        X = np.asarray(X, dtype=np.float64)
        y = np.asarray(y)
        if X.ndim != 2 or X.shape[0] != y.shape[0]:
            raise ValueError("X and y shape mismatch")
        self.classes_ = np.unique(y)
        n_classes = int(self.classes_.size)
        n, d = X.shape
        Y = np.zeros((n, n_classes), dtype=np.float64)
        for k, label in enumerate(self.classes_):
            Y[:, k] = (y == label).astype(np.float64)
        F = np.zeros((n, n_classes), dtype=np.float64)
        self.trees_ = []
        for _round in range(self.n_estimators):
            shift = F - np.max(F, axis=1, keepdims=True)
            expF = np.exp(np.clip(shift, -30.0, 30.0))
            P = expF / (expF.sum(axis=1, keepdims=True) + 1e-12)
            residual = Y - P
            round_trees: list[_Stump] = []
            for k in range(n_classes):
                stump = self._fit_stump(X, residual[:, k], rng)
                F[:, k] += self.learning_rate * stump.predict(X)
                round_trees.append(stump)
            self.trees_.append(round_trees)
        self.n_iter_ = self.n_estimators
        return self

    def _fit_stump(self, X: np.ndarray, residual: np.ndarray, rng: np.random.Generator) -> _Stump:
        n, d = X.shape
        mean_res = float(np.mean(residual))
        if n < 4 or d < 1:
            return _Stump(0, 0.0, mean_res, mean_res)
        k = min(self.n_features_sample, d)
        feats = rng.choice(d, size=k, replace=False)
        best_sse = float("inf")
        best = _Stump(int(feats[0]), 0.0, mean_res, mean_res)
        for j in feats:
            col = X[:, int(j)]
            if not np.isfinite(col).all():
                continue
            lo, hi = float(np.min(col)), float(np.max(col))
            if hi <= lo:
                continue
            qs = np.quantile(col, np.linspace(0.1, 0.9, self.max_bins))
            for thresh in np.unique(qs):
                left_mask = col <= thresh
                n_left = int(left_mask.sum())
                n_right = n - n_left
                if n_left < 2 or n_right < 2:
                    continue
                left_val = float(np.mean(residual[left_mask]))
                right_val = float(np.mean(residual[~left_mask]))
                pred = np.where(left_mask, left_val, right_val)
                sse = float(np.mean((residual - pred) ** 2))
                if sse < best_sse:
                    best_sse = sse
                    best = _Stump(int(j), float(thresh), left_val, right_val)
        return best

    def decision_function(self, X: np.ndarray) -> np.ndarray:
        if self.classes_ is None:
            raise RuntimeError("not fitted")
        X = np.asarray(X, dtype=np.float64)
        if X.ndim == 1:
            X = X[None, :]
        n = X.shape[0]
        F = np.zeros((n, int(self.classes_.size)), dtype=np.float64)
        lr = self.learning_rate
        for round_trees in self.trees_:
            for k, stump in enumerate(round_trees):
                F[:, k] += lr * stump.predict(X)
        return F

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        F = self.decision_function(X)
        shift = F - np.max(F, axis=1, keepdims=True)
        expF = np.exp(np.clip(shift, -30.0, 30.0))
        return expF / (expF.sum(axis=1, keepdims=True) + 1e-12)

    def predict(self, X: np.ndarray) -> np.ndarray:
        if self.classes_ is None:
            raise RuntimeError("not fitted")
        idx = np.argmax(self.predict_proba(X), axis=1)
        return self.classes_[idx]
