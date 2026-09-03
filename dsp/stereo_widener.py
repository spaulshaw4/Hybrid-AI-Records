"""Frequency-split M/S widener with a phase-correlation safety clamp.

This is the HF expander: bass/side below the crossover is left alone.
``dsp.midside_processor`` already does the mono-sub + global side gain;
do not stack that sculpt here.

Offline crossover uses ``sosfiltfilt`` (zero-phase) so the split does not
smear the mid. Complementary LF is the residual (``side - side_hf``) so
width=1.0 is an identity before the peak-safety scale.

Correlation is measured on the reconstructed L/R once; width is then
binary-searched on the already-split bands (no re-filter in the loop).
"""
from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfiltfilt

DEFAULT_CROSSOVER_HZ = 2000.0
DEFAULT_MIN_CORRELATION = 0.80
DEFAULT_WIDTH = 1.25
_SEARCH_ITERS = 20


def _as_stereo(audio: np.ndarray) -> tuple[np.ndarray, bool]:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1 or data.shape[-1] < 2:
        return data, False
    return data, True


def phase_correlation(left: np.ndarray, right: np.ndarray) -> float:
    """Pearson correlation of two channels. Silent / identical -> 1.0."""
    left = np.asarray(left, dtype=np.float64).reshape(-1)
    right = np.asarray(right, dtype=np.float64).reshape(-1)
    n = min(left.size, right.size)
    if n < 8:
        return 1.0
    left = left[:n] - left[:n].mean()
    right = right[:n] - right[:n].mean()
    denom = float(np.sqrt(np.dot(left, left) * np.dot(right, right)))
    if denom < 1e-12:
        return 1.0
    return float(np.clip(np.dot(left, right) / denom, -1.0, 1.0))


def _encode_ms(left: np.ndarray, right: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mid = 0.5 * (left + right)
    side = 0.5 * (left - right)
    return mid, side


def _decode_ms(mid: np.ndarray, side: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return mid + side, mid - side


def _split_side_hf(side: np.ndarray, sr: int, crossover_hz: float) -> tuple[np.ndarray, np.ndarray]:
    """Zero-phase HF extract; LF is complementary residual (perfect reconstruct)."""
    nyquist = float(sr) / 2.0
    cutoff = min(float(crossover_hz), nyquist * 0.45)
    if cutoff <= 20.0 or side.size < 16:
        return np.zeros_like(side), side
    sos_hp = butter(4, cutoff, btype="highpass", fs=sr, output="sos")
    side_hf = sosfiltfilt(sos_hp, side)
    return side_hf, side - side_hf


def _peak_match(processed: np.ndarray, reference: np.ndarray) -> np.ndarray:
    orig_peak = float(np.max(np.abs(reference)))
    proc_peak = float(np.max(np.abs(processed)))
    if proc_peak > 1e-12 and orig_peak > 0 and proc_peak > orig_peak:
        processed = processed * (orig_peak / proc_peak)
    return processed


def apply_stereo_widener_report(
    audio: np.ndarray,
    width: float = DEFAULT_WIDTH,
    sr: int = 44100,
    crossover_hz: float = DEFAULT_CROSSOVER_HZ,
    min_correlation: float = DEFAULT_MIN_CORRELATION,
) -> tuple[np.ndarray, float]:
    """
    Widen HF Side until ``min_correlation`` would be violated, then back off.

    Returns ``(audio, width_used)``. Mono (or single-channel) is a passthrough
    with ``width_used=1.0``.
    """
    data, is_stereo = _as_stereo(audio)
    if not is_stereo:
        return data.astype(audio.dtype, copy=False), 1.0

    left = data[:, 0]
    right = data[:, 1]
    requested = max(0.0, float(width))
    floor = float(min_correlation)

    mid, side = _encode_ms(left, right)
    side_hf, side_lf = _split_side_hf(side, int(sr), crossover_hz)

    def at_width(amount: float) -> tuple[np.ndarray, np.ndarray]:
        return _decode_ms(mid, side_lf + side_hf * amount)

    trial_l, trial_r = at_width(requested)
    if phase_correlation(trial_l, trial_r) >= floor:
        stacked = np.column_stack((trial_l, trial_r))
        stacked = _peak_match(stacked, data)
        return stacked.astype(audio.dtype, copy=False), requested

    lo = 0.0
    hi = requested
    best_w = 0.0
    best_l, best_r = at_width(0.0)
    for _ in range(_SEARCH_ITERS):
        mid_w = 0.5 * (lo + hi)
        cand_l, cand_r = at_width(mid_w)
        if phase_correlation(cand_l, cand_r) >= floor:
            best_w = mid_w
            best_l, best_r = cand_l, cand_r
            lo = mid_w
        else:
            hi = mid_w

    stacked = np.column_stack((best_l, best_r))
    stacked = _peak_match(stacked, data)
    return stacked.astype(audio.dtype, copy=False), float(best_w)


def apply_stereo_widener(
    audio: np.ndarray,
    width: float = DEFAULT_WIDTH,
    sr: int = 44100,
    crossover_hz: float = DEFAULT_CROSSOVER_HZ,
    min_correlation: float = DEFAULT_MIN_CORRELATION,
) -> np.ndarray:
    """Same as ``apply_stereo_widener_report`` but returns audio only."""
    processed, _used = apply_stereo_widener_report(
        audio,
        width=width,
        sr=sr,
        crossover_hz=crossover_hz,
        min_correlation=min_correlation,
    )
    return processed
