"""Causal multi-band dynamic EQ for resonance (mud / harshness) suppression."""
from __future__ import annotations

import numpy as np
from scipy.signal import butter, lfilter, sosfilt

# Low-mid mud (~300 Hz) and high-mid harshness (~3.5 kHz). Edges are
# clamped against Nyquist in apply_dynamic_eq before the SOS is built.
MUD_LOW_HZ = 180.0
MUD_HIGH_HZ = 450.0
HARSH_LOW_HZ = 2500.0
HARSH_HIGH_HZ = 5000.0

DEFAULT_MUD_THRESHOLD_DB = -18.0
DEFAULT_HARSH_THRESHOLD_DB = -16.0
DEFAULT_MUD_RATIO = 3.0
DEFAULT_HARSH_RATIO = 4.0

# Bandpass order 2 (not 4): causal sosfilt rings; a gentler slope avoids
# the pre-echo filtfilt would have cancelled. Isolation is still tight
# enough for a one-band duck.
_BANDPASS_ORDER = 2
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
    """Return usable (low, high) Hz, or None if the band is past Nyquist."""
    if sr <= 0:
        return None
    nyquist = float(sr) / 2.0
    ceiling = nyquist * _NYQUIST_GUARD
    low = max(float(low_cut), 1.0)
    high = min(float(high_cut), ceiling)
    if high >= nyquist or high <= low:
        return None
    return low, high


def _one_pole(signal: np.ndarray, coeff: float) -> np.ndarray:
    """Causal one-pole: y[n] = (1-c)*x[n] + c*y[n-1], C-backed via lfilter."""
    coeff = float(np.clip(coeff, 0.0, 1.0 - 1e-12))
    return lfilter([1.0 - coeff], [1.0, -coeff], signal)


def _time_const_coeff(sr: int, time_ms: float) -> float:
    samples = max(1.0, float(sr) * (max(time_ms, 0.0) / 1000.0))
    return float(np.exp(-1.0 / samples))


def _follow_envelope(
    detector: np.ndarray,
    sr: int,
    attack_ms: float,
    release_ms: float,
) -> np.ndarray:
    """
    Sample-accurate causal envelope without a Python sample loop.

    A branched follower (attack if |x| > env else release) is sequential:
    each sample depends on the previous envelope, so a ``for i in range(N)``
    over a 4-minute 48 kHz master is tens of millions of interpreter steps.
    Numba is intentionally not used here.

    Parallel one-poles + max is LTI-per-path and C-backed (``lfilter``):
    the faster pole wins on rises, the slower pole wins on falls. That is
    not bit-identical to a classic peak GR, but it is causal, stable, and
    fast enough for offline masters. Cascade (attack then release) would
    slow the attack down to the release time-constant; the max avoids that.
    """
    if detector.size == 0:
        return detector
    attack_c = _time_const_coeff(sr, attack_ms)
    release_c = _time_const_coeff(sr, release_ms)
    risen = _one_pole(detector, attack_c)
    if release_ms <= attack_ms:
        return risen
    return np.maximum(risen, _one_pole(detector, release_c))


def _gain_from_envelope(env: np.ndarray, threshold_db: float, ratio: float) -> np.ndarray:
    threshold_lin = 10.0 ** (float(threshold_db) / 20.0)
    ratio = max(float(ratio), 1.0)
    over_db = np.maximum(0.0, 20.0 * np.log10(np.maximum(env, 1e-12) / max(threshold_lin, 1e-12)))
    reduction_db = over_db * (1.0 - 1.0 / ratio)
    return 10.0 ** (-reduction_db / 20.0)


def apply_dynamic_eq(
    audio: np.ndarray,
    sr: int,
    low_cut: float,
    high_cut: float,
    threshold_db: float = DEFAULT_MUD_THRESHOLD_DB,
    ratio: float = DEFAULT_MUD_RATIO,
    attack_ms: float = 8.0,
    release_ms: float = 80.0,
) -> np.ndarray:
    """
    Isolate one Butterworth band (causal ``sosfilt``), duck only that band,
    and sum back into dry. Linked stereo: one envelope from max(|L|, |R|).

    ``sosfiltfilt`` is intentionally not used — a compressor must not see
    the future. Lookahead is not requested.
    """
    frames, was_1d = _as_frames(audio)
    if frames.shape[0] == 0:
        return _restore_shape(frames, was_1d, audio.dtype)

    edges = _band_edges(low_cut, high_cut, sr)
    if edges is None:
        return _restore_shape(frames.copy(), was_1d, audio.dtype)

    sos = butter(_BANDPASS_ORDER, edges, btype="bandpass", fs=sr, output="sos")
    band = sosfilt(sos, frames, axis=0)
    detector = np.max(np.abs(band), axis=1)
    env = _follow_envelope(detector, sr, attack_ms, release_ms)
    gain = _gain_from_envelope(env, threshold_db, ratio)
    processed = frames + band * (gain[:, np.newaxis] - 1.0)
    return _restore_shape(processed, was_1d, audio.dtype)


def apply_dynamic_master_eq(
    audio: np.ndarray,
    sr: int = 44100,
    *,
    mud_threshold_db: float = DEFAULT_MUD_THRESHOLD_DB,
    harsh_threshold_db: float = DEFAULT_HARSH_THRESHOLD_DB,
    mud_ratio: float = DEFAULT_MUD_RATIO,
    harsh_ratio: float = DEFAULT_HARSH_RATIO,
) -> np.ndarray:
    """Low-mid mud (~300 Hz) then high-mid harshness (~3.5 kHz)."""
    ducked = apply_dynamic_eq(
        audio,
        sr,
        MUD_LOW_HZ,
        MUD_HIGH_HZ,
        threshold_db=mud_threshold_db,
        ratio=mud_ratio,
        attack_ms=15.0,
        release_ms=120.0,
    )
    return apply_dynamic_eq(
        ducked,
        sr,
        HARSH_LOW_HZ,
        HARSH_HIGH_HZ,
        threshold_db=harsh_threshold_db,
        ratio=harsh_ratio,
        attack_ms=6.0,
        release_ms=70.0,
    )
