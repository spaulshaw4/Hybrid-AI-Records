"""Psychoacoustic 2nd/3rd harmonics from a 35–80 Hz fundamental.

The generated body is band-passed to 90–250 Hz (where the ear still
reads it as 'more bass') and mixed under a peak-match so the output
cannot exceed the input peak.

Causal ``sosfilt`` on the extract and harmonic body. ``mix <= 0`` is a
passthrough. Mono and stereo: harmonics are derived from the mid (or the
single channel) and added equally so the image does not smear.
"""
from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfilt

FUND_LOW_HZ = 35.0
FUND_HIGH_HZ = 80.0
BODY_LOW_HZ = 90.0
BODY_HIGH_HZ = 250.0
_NYQUIST_GUARD = 0.98


def _as_frames(audio: np.ndarray) -> tuple[np.ndarray, bool]:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return data[:, np.newaxis], True
    return data, False


def _restore_shape(frames: np.ndarray, was_1d: bool, dtype: np.dtype) -> np.ndarray:
    out = frames[:, 0] if was_1d else frames
    return out.astype(dtype, copy=False)


def _band_edges(low_cut: float, high_cut: float, sr: int) -> tuple[float, float] | None:
    if sr <= 0:
        return None
    nyquist = float(sr) / 2.0
    ceiling = nyquist * _NYQUIST_GUARD
    low = max(float(low_cut), 1.0)
    high = min(float(high_cut), ceiling)
    if high >= nyquist or high <= low:
        return None
    return low, high


def _bandpass(signal: np.ndarray, sr: int, low_hz: float, high_hz: float) -> np.ndarray:
    edges = _band_edges(low_hz, high_hz, sr)
    if edges is None or signal.size < 16:
        return np.zeros_like(signal)
    sos = butter(2, edges, btype="bandpass", fs=sr, output="sos")
    return sosfilt(sos, signal)


def apply_sub_harmonic_synth(
    audio: np.ndarray,
    mix: float = 0.18,
    sr: int = 44100,
    fund_low_hz: float = FUND_LOW_HZ,
    fund_high_hz: float = FUND_HIGH_HZ,
    body_low_hz: float = BODY_LOW_HZ,
    body_high_hz: float = BODY_HIGH_HZ,
) -> np.ndarray:
    """
    Add 2nd/3rd harmonics of the 35–80 Hz band, filtered to 90–250 Hz.

    ``mix <= 0`` returns the input unchanged. Output peak is clamped to
    the input peak. No NaNs are introduced for finite input.
    """
    amount = float(mix)
    data, was_1d = _as_frames(audio)
    if amount <= 0.0 or data.size == 0:
        return np.asarray(audio)

    mid = data[:, 0] if data.shape[1] < 2 else 0.5 * (data[:, 0] + data[:, 1])
    fundamental = _bandpass(mid, int(sr), fund_low_hz, fund_high_hz)
    # Even / odd: square (2nd) and cube (3rd), then keep the 90–250 Hz body.
    second = _bandpass(fundamental * fundamental, int(sr), body_low_hz, body_high_hz)
    third = _bandpass(fundamental * fundamental * fundamental, int(sr), body_low_hz, body_high_hz)
    body = second + third
    body_peak = float(np.max(np.abs(body)))
    fund_peak = float(np.max(np.abs(fundamental)))
    if body_peak > 1e-12 and fund_peak > 1e-12:
        body = body * (fund_peak / body_peak)

    mixed = data + (amount * body)[:, np.newaxis]
    mixed = np.nan_to_num(mixed, nan=0.0, posinf=0.0, neginf=0.0)
    orig_peak = float(np.max(np.abs(data)))
    proc_peak = float(np.max(np.abs(mixed)))
    if proc_peak > 1e-12 and orig_peak >= 0 and proc_peak > orig_peak:
        mixed = mixed * (orig_peak / proc_peak)
    return _restore_shape(mixed, was_1d, audio.dtype)
