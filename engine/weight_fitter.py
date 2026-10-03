"""Fit the selection weights to the picks that actually landed well.

``SCORE_WEIGHTS_MUSICAL`` is six hand-set constants. The mix ledger records
every candidate the picker scored, which of them it staged, and how the
finished track was treated — enough to replace judgement with evidence.

Formulated as learning-to-rank rather than regression: within one render and
one role, a staged stem should outrank the stems it beat. Each comparison is a
pairwise difference of component fits, so the fit learns *which components
matter*, not what an absolute score should be. Comparisons from a well-received
track are positive examples; a skipped track inverts them.

numpy only — no sklearn. The model is six coefficients; anything heavier would
overfit this much data long before it helped.
"""
from __future__ import annotations

import math
from typing import Any, Mapping, Sequence

import numpy as np

#: Order is fixed — it defines the coefficient vector everywhere in this module.
COMPONENTS = ("key", "chord", "bpm", "centroid", "level", "groove")

#: Below this many comparisons the result is noise wearing a number's clothes.
#: Six free parameters need considerably more than six observations before a
#: fit beats a considered guess.
MIN_COMPARISONS = 200
#: Separate renders, so the fit is not one session's quirks.
MIN_SESSIONS = 8


class InsufficientEvidence(RuntimeError):
    """Raised instead of returning weights that only look authoritative."""

    def __init__(self, comparisons: int, sessions: int) -> None:
        super().__init__(
            f"not enough evidence to fit: {comparisons} comparisons across "
            f"{sessions} sessions (need >= {MIN_COMPARISONS} and >= {MIN_SESSIONS}). "
            "Render and listen to more tracks; the ledger collects automatically."
        )
        self.comparisons = comparisons
        self.sessions = sessions


def _vector(row: Mapping[str, Any]) -> np.ndarray:
    """Component fits in COMPONENTS order. Unmeasured reads as the neutral 0.5."""
    out = np.empty(len(COMPONENTS), dtype=np.float64)
    for i, name in enumerate(COMPONENTS):
        value = row.get(f"fit_{name}")
        try:
            out[i] = 0.5 if value is None else float(value)
        except (TypeError, ValueError):
            out[i] = 0.5
    return out


def build_comparisons(
    decisions: Sequence[Mapping[str, Any]],
    labels: Mapping[str, float],
    *,
    max_per_group: int = 40,
) -> tuple[np.ndarray, np.ndarray]:
    """Pairwise (chosen - rejected) differences and their signed weights.

    ``decisions`` are ledger rows; ``labels`` maps session_id to its verdict in
    ``[-1, 1]``. A positive label means the staged stem deserved to win, a
    negative one means it did not, so the same pair flips sign rather than
    being thrown away — rejections are information.

    Rejected stems are sampled evenly across the ranking instead of taking the
    top ``n``: the losers ranked just below the winner look almost identical to
    it, and a fit trained only on those learns nothing.
    """
    groups: dict[tuple[str, str], dict[str, list[Mapping[str, Any]]]] = {}
    for row in decisions:
        session = str(row.get("session_id") or "")
        label = labels.get(session)
        if label is None or abs(float(label)) < 1e-9:
            continue  # no verdict, or a neutral one: carries no direction
        key = (session, str(row.get("role") or ""))
        bucket = groups.setdefault(key, {"chosen": [], "rejected": []})
        bucket["chosen" if row.get("chosen") else "rejected"].append(row)

    diffs: list[np.ndarray] = []
    weights: list[float] = []
    for (session, _role), bucket in groups.items():
        chosen, rejected = bucket["chosen"], bucket["rejected"]
        if not chosen or not rejected:
            continue
        if len(rejected) > max_per_group:
            idx = np.linspace(0, len(rejected) - 1, max_per_group).astype(int)
            rejected = [rejected[i] for i in idx]
        label = float(labels[session])
        for win in chosen:
            win_vec = _vector(win)
            for lose in rejected:
                diffs.append(win_vec - _vector(lose))
                weights.append(label)
    if not diffs:
        return np.zeros((0, len(COMPONENTS))), np.zeros(0)
    return np.asarray(diffs, dtype=np.float64), np.asarray(weights, dtype=np.float64)


def _fit_logistic(
    diffs: np.ndarray,
    sample_weights: np.ndarray,
    *,
    iterations: int = 600,
    learning_rate: float = 0.5,
    l2: float = 0.02,
) -> np.ndarray:
    """Weighted pairwise logistic fit. Returns raw (unnormalised) coefficients.

    The sign of each sample weight carries the verdict, its magnitude how
    confident that verdict is.
    """
    signs = np.sign(sample_weights)
    magnitude = np.abs(sample_weights)
    total = float(magnitude.sum()) or 1.0
    coef = np.zeros(diffs.shape[1], dtype=np.float64)
    for _ in range(iterations):
        margin = signs * (diffs @ coef)
        # Stable sigmoid of the negative margin: the per-sample gradient scale.
        scale = np.where(
            margin >= 0,
            np.exp(-margin) / (1.0 + np.exp(-margin)),
            1.0 / (1.0 + np.exp(margin)),
        )
        grad = -(diffs * (signs * scale * magnitude)[:, None]).sum(axis=0) / total
        coef -= learning_rate * (grad + l2 * coef)
    return coef


def normalise(coef: np.ndarray, *, floor: float = 0.04) -> dict[str, float]:
    """Turn raw coefficients into weights that sum to 1.

    Negative coefficients are clamped to a small floor rather than dropped: a
    component the data dislikes should stop dominating, but zeroing it would
    let a single odd render permanently blind the picker to, say, tempo.
    """
    clipped = np.maximum(np.asarray(coef, dtype=np.float64), floor)
    total = float(clipped.sum())
    if total <= 0.0:
        even = 1.0 / len(COMPONENTS)
        return {name: round(even, 4) for name in COMPONENTS}
    weights = {name: float(clipped[i] / total) for i, name in enumerate(COMPONENTS)}
    # Round to 2dp and put any residue on the largest term so the sum stays 1.0.
    rounded = {k: round(v, 2) for k, v in weights.items()}
    drift = round(1.0 - sum(rounded.values()), 2)
    if abs(drift) >= 0.01:
        top = max(rounded, key=lambda k: rounded[k])
        rounded[top] = round(rounded[top] + drift, 2)
    return rounded


def ranking_accuracy(diffs: np.ndarray, sample_weights: np.ndarray, coef: np.ndarray) -> float:
    """Share of comparisons the coefficients order correctly."""
    if diffs.size == 0:
        return float("nan")
    predicted = diffs @ np.asarray(coef, dtype=np.float64)
    correct = (np.sign(predicted) == np.sign(sample_weights)) & (np.abs(predicted) > 0)
    return float(correct.mean())


def fit_selection_weights(
    decisions: Sequence[Mapping[str, Any]],
    labels: Mapping[str, float],
    *,
    holdout: float = 0.25,
    seed: int = 0,
) -> dict[str, Any]:
    """Fit weights and report how they score against a held-out split.

    Raises :class:`InsufficientEvidence` rather than returning a number that
    cannot be trusted.
    """
    sessions = sorted({str(r.get("session_id") or "") for r in decisions} & set(labels))
    diffs, weights = build_comparisons(decisions, labels)
    if diffs.shape[0] < MIN_COMPARISONS or len(sessions) < MIN_SESSIONS:
        raise InsufficientEvidence(int(diffs.shape[0]), len(sessions))

    rng = np.random.default_rng(seed)
    order = rng.permutation(diffs.shape[0])
    cut = max(1, int(diffs.shape[0] * (1.0 - holdout)))
    train, test = order[:cut], order[cut:]

    coef = _fit_logistic(diffs[train], weights[train])
    return {
        "weights": normalise(coef),
        "raw_coefficients": {name: round(float(coef[i]), 4) for i, name in enumerate(COMPONENTS)},
        "comparisons": int(diffs.shape[0]),
        "sessions": len(sessions),
        "train_accuracy": round(ranking_accuracy(diffs[train], weights[train], coef), 4),
        "holdout_accuracy": round(ranking_accuracy(diffs[test], weights[test], coef), 4)
        if test.size
        else float("nan"),
    }


def verdict_labels(rows: Sequence[Mapping[str, Any]]) -> dict[str, float]:
    """Average each session's verdicts into one label in ``[-1, 1]``."""
    totals: dict[str, list[float]] = {}
    for row in rows:
        session = str(row.get("session_id") or "")
        try:
            totals.setdefault(session, []).append(float(row.get("label")))
        except (TypeError, ValueError):
            continue
    return {
        session: max(-1.0, min(1.0, sum(values) / len(values)))
        for session, values in totals.items()
        if values and not math.isnan(sum(values))
    }
