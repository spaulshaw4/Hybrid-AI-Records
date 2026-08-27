#!/usr/bin/env python3
"""Mid-side bass mono-sum and high-side stereo width."""
from __future__ import annotations

import numpy as np
from scipy import signal


def _linkwitz_riley4_sos(cutoff_hz: float, btype: str, sr: int) -> np.ndarray:
    """True LR4: two cascaded 2nd-order Butterworth sections."""
    sos = signal.butter(2, cutoff_hz, btype=btype, fs=sr, output="sos")
    return np.vstack([sos, sos])


def process_stereo_field(
    audio: np.ndarray,
    sr: int = 44100,
    mono_bass_crossover_hz: float = 120.0,
    side_high_width: float = 1.35,
) -> np.ndarray:
    """Mono-sum Side below crossover; widen Side above it. Shape (2, samples)."""
    if audio.ndim != 2 or audio.shape[0] != 2:
        return audio.astype(np.float32, copy=False)

    left = audio[0].astype(np.float64, copy=False)
    right = audio[1].astype(np.float64, copy=False)
    norm = np.sqrt(2.0)
    mid = (left + right) / norm
    side = (left - right) / norm

    cutoff = min(max(20.0, float(mono_bass_crossover_hz)), (sr / 2.0) - 1.0)
    sos_hp = _linkwitz_riley4_sos(cutoff, "highpass", sr)
    side_high = signal.sosfilt(sos_hp, side)
    side_widened = side_high * float(side_high_width)

    left_out = (mid + side_widened) / norm
    right_out = (mid - side_widened) / norm
    return np.stack([left_out, right_out], axis=0).astype(np.float32)
