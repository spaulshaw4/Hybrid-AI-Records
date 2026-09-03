"""Leakage-safe train/validation splitting by source track.

Slices are ~4 s cuts of the same song. Two slices from one song share tempo,
key, mix bus, room, mic chain and instrument timbre, so if any song has slices
on both sides of a split the classifier can memorize the song rather than learn
the stem role, and held-out accuracy becomes meaningless.

Everything here splits on ``track_id`` (see ``ml.dataset_manifest``), never on
the slice, and :func:`assert_no_leakage` is called by the trainer so a
regression cannot pass silently.
"""
from __future__ import annotations

import numpy as np


class LeakageError(AssertionError):
    """Raised when a group appears in more than one split."""


def group_split(
    groups: np.ndarray | list[str],
    val_fraction: float = 0.25,
    seed: int = 1337,
) -> tuple[np.ndarray, np.ndarray]:
    """Split indices so that whole groups land on one side.

    Returns ``(train_idx, val_idx)`` as integer arrays.
    """
    groups = np.asarray(groups)
    unique = np.unique(groups)
    if unique.size < 2:
        raise ValueError("need at least 2 distinct groups to split")
    rng = np.random.default_rng(seed)
    shuffled = unique.copy()
    rng.shuffle(shuffled)
    n_val = max(1, int(round(val_fraction * shuffled.size)))
    n_val = min(n_val, shuffled.size - 1)
    val_groups = set(shuffled[:n_val].tolist())
    is_val = np.array([g in val_groups for g in groups], dtype=bool)
    return np.flatnonzero(~is_val), np.flatnonzero(is_val)


def assert_no_leakage(
    groups: np.ndarray | list[str],
    train_idx: np.ndarray,
    val_idx: np.ndarray,
) -> None:
    """Raise :class:`LeakageError` if any group spans both splits."""
    groups = np.asarray(groups)
    train_groups = set(groups[train_idx].tolist())
    val_groups = set(groups[val_idx].tolist())
    overlap = train_groups & val_groups
    if overlap:
        sample = sorted(overlap)[:5]
        raise LeakageError(
            f"{len(overlap)} group(s) appear in both train and val, e.g. {sample}"
        )
    if not train_groups or not val_groups:
        raise LeakageError("one side of the split is empty")


def group_folds(
    groups: np.ndarray | list[str],
    n_folds: int = 4,
    seed: int = 1337,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Group-wise K-fold indices, each fold verified leakage-free."""
    groups = np.asarray(groups)
    unique = np.unique(groups)
    if unique.size < n_folds:
        raise ValueError(f"need >= {n_folds} groups, have {unique.size}")
    rng = np.random.default_rng(seed)
    shuffled = unique.copy()
    rng.shuffle(shuffled)
    buckets = np.array_split(shuffled, n_folds)
    folds: list[tuple[np.ndarray, np.ndarray]] = []
    for bucket in buckets:
        held = set(bucket.tolist())
        is_val = np.array([g in held for g in groups], dtype=bool)
        train_idx = np.flatnonzero(~is_val)
        val_idx = np.flatnonzero(is_val)
        assert_no_leakage(groups, train_idx, val_idx)
        folds.append((train_idx, val_idx))
    return folds
