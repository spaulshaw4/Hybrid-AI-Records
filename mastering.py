#!/usr/bin/env python3
"""EQ, mid-side spatial, glue, limiter, and EBU R128 loudness to -14 LUFS."""
from __future__ import annotations

import numpy as np
import pyloudnorm as pyln
from pedalboard import (
    Compressor,
    HighShelfFilter,
    HighpassFilter,
    Limiter,
    PeakFilter,
    Pedalboard,
)
from spatial_fx import process_stereo_field
from dsp.landr_vst_bridge import apply_landr_bus_with_fallback


def apply_mastering_chain(
    audio: np.ndarray,
    sr: int = 44100,
    target_lufs: float = -14.0,
    mono_bass_crossover_hz: float = 120.0,
    stereo_width: float = 1.30,
    landr_bus_type: str | None = None,
    landr_intensity: float = 0.5,
    landr_prefer_vst: bool = True,
) -> np.ndarray:
    """EQ, M/S bass-mono + high width, glue compress, limit, then LUFS normalize.

    Expects audio shape (channels, samples).
    """
    if audio.ndim == 1:
        audio = np.vstack([audio, audio])

    if landr_bus_type:
        audio = apply_landr_bus_with_fallback(
            audio,
            sr=int(sr),
            bus_type=landr_bus_type,
            intensity=float(landr_intensity),
            prefer_vst=bool(landr_prefer_vst),
        )

    pre_eq = Pedalboard(
        [
            HighpassFilter(cutoff_frequency_hz=30.0),
            PeakFilter(cutoff_frequency_hz=250.0, gain_db=-1.2, q=0.7),
            HighShelfFilter(cutoff_frequency_hz=10000.0, gain_db=1.5),
        ]
    )
    shaped = pre_eq(audio.astype(np.float32), sr)

    spatial = process_stereo_field(
        shaped,
        sr=sr,
        mono_bass_crossover_hz=mono_bass_crossover_hz,
        side_high_width=stereo_width,
    )

    dynamics = Pedalboard(
        [
            Compressor(threshold_db=-16.0, ratio=2.0, attack_ms=30.0, release_ms=100.0),
            Limiter(threshold_db=-1.0, release_ms=50.0),
        ]
    )
    processed = dynamics(spatial.astype(np.float32), sr)

    meter = pyln.Meter(sr)
    transposed = processed.T
    current_lufs = meter.integrated_loudness(transposed)

    if not np.isinf(current_lufs) and not np.isnan(current_lufs):
        gain_db = target_lufs - current_lufs
        gain_linear = 10.0 ** (gain_db / 20.0)
        normalized = transposed * gain_linear
        peak = np.max(np.abs(normalized))
        if peak > 0.944:
            normalized = (normalized / peak) * 0.944
        processed = normalized.T

    return processed.astype(np.float32)
