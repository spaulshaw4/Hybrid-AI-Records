"""The slice BPM callers use the continuous grid, not the integer-lag comb."""
from __future__ import annotations

import os
import sys

import numpy as np

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from dsp.tempo_time_stretch import (  # noqa: E402
    estimate_slice_bpm,
    estimate_slice_bpm_or_none,
)


def _click_train(sr: int, bpm: float, seconds: float) -> np.ndarray:
    n = int(sr * seconds)
    clicks = np.zeros(n, dtype=np.float64)
    interval = max(1, int(round(sr * 60.0 / bpm)))
    width = max(1, int(sr * 0.01))
    for i in range(0, n, interval):
        end = min(n, i + width)
        clicks[i:end] = np.linspace(0.95, 0.0, end - i)
    return clicks


def _folded_error(est: float, truth: float) -> float:
    return min(abs(est * factor - truth) / truth for factor in (0.5, 1.0, 2.0))


def test_click_train_lands_inside_three_percent():
    sr = 44100
    truth = 124.0
    est = estimate_slice_bpm_or_none(_click_train(sr, truth, seconds=8.0), sr=sr)
    assert est is not None
    assert _folded_error(est, truth) <= 0.03


def test_silence_and_a_blip_have_no_tempo():
    sr = 22050
    assert estimate_slice_bpm_or_none(np.zeros(sr * 4), sr=sr) is None
    assert estimate_slice_bpm_or_none(np.zeros(int(sr * 0.05)), sr=sr) is None
    assert estimate_slice_bpm(np.zeros(sr), sr=sr) == 120.0
