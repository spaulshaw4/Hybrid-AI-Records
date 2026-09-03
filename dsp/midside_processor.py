"""Mid/Side mono-sub and stereo width sculpt."""
from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfiltfilt


def apply_midside_stereo_sculpt(
    stereo_audio: np.ndarray,
    mono_cutoff_hz: float = 120.0,
    side_gain_factor: float = 1.05,
    sr: int = 44100,
) -> np.ndarray:
    """
    Encode L/R to Mid/Side, high-pass Side so energy below cutoff is mono,
    scale Side for width, then decode. Offline zero-phase HPF (sosfiltfilt).
    """
    data = np.asarray(stereo_audio, dtype=np.float64)
    if data.ndim == 1:
        return data.astype(stereo_audio.dtype, copy=False)
    if data.shape[1] < 2:
        return data.astype(stereo_audio.dtype, copy=False)

    left = data[:, 0]
    right = data[:, 1]
    mid = 0.5 * (left + right)
    side = 0.5 * (left - right)

    nyquist = sr / 2.0
    cutoff = min(float(mono_cutoff_hz), nyquist * 0.45)
    if cutoff > 20.0:
        sos_hp = butter(4, cutoff, btype="highpass", fs=sr, output="sos")
        side_processed = sosfiltfilt(sos_hp, side)
    else:
        side_processed = side

    side_processed *= float(side_gain_factor)
    left_out = mid + side_processed
    right_out = mid - side_processed
    processed = np.column_stack((left_out, right_out))

    orig_peak = float(np.max(np.abs(data)))
    proc_peak = float(np.max(np.abs(processed)))
    if proc_peak > 1e-12 and orig_peak > 0:
        processed *= orig_peak / proc_peak
    return processed.astype(stereo_audio.dtype, copy=False)
