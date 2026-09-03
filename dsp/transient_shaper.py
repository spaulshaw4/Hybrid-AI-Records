"""Dual-envelope transient / sustain shaper."""
from __future__ import annotations

import numpy as np
from scipy.signal import lfilter

EPS = 1e-12


def _as_frames(audio: np.ndarray) -> tuple[np.ndarray, bool]:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return data[:, np.newaxis], True
    return data, False


def _restore_shape(frames: np.ndarray, was_1d: bool, dtype: np.dtype) -> np.ndarray:
    out = frames[:, 0] if was_1d else frames
    return out.astype(dtype, copy=False)


def _time_const_coeff(sr: int, time_ms: float) -> float:
    samples = max(1.0, float(sr) * (max(time_ms, 0.0) / 1000.0))
    return float(np.exp(-1.0 / samples))


_HOLD_BLOCK = 4096


def _one_pole(signal: np.ndarray, coeff: float) -> np.ndarray:
    """Causal one-pole: y[n] = (1-c)*x[n] + c*y[n-1], C-backed via lfilter."""
    coeff = float(np.clip(coeff, 0.0, 1.0 - 1e-12))
    return lfilter([1.0 - coeff], [1.0, -coeff], signal)


def _peak_hold_exp(abs_x: np.ndarray, release_coeff: float) -> np.ndarray:
    """
    Instant-attack peak hold with exponential release: y[i] = max(x[i], α y[i-1]).

    Equivalent to α^i * prefixmax(x[j] α^{-j}). Evaluated in blocks so the
    scale factors stay finite; no per-sample Python loop.
    """
    x = np.asarray(abs_x, dtype=np.float64).reshape(-1)
    n = int(x.size)
    if n == 0:
        return x
    alpha = float(np.clip(release_coeff, 1e-12, 1.0 - 1e-15))
    log_a = float(np.log(alpha))
    out = np.empty(n, dtype=np.float64)
    carry = 0.0
    for start in range(0, n, _HOLD_BLOCK):
        chunk = x[start : start + _HOLD_BLOCK]
        idx = np.arange(chunk.shape[0], dtype=np.float64)
        scale = np.exp(idx * log_a)
        prefix = np.maximum.accumulate(chunk * np.exp(-idx * log_a))
        local = prefix * scale
        from_prev = carry * np.exp((idx + 1.0) * log_a)
        held = np.maximum(local, from_prev)
        out[start : start + chunk.shape[0]] = held
        carry = float(held[-1])
    return out


def _envelope_follow(
    abs_x: np.ndarray,
    attack_coeff: float,
    release_coeff: float,
) -> np.ndarray:
    """
    Causal envelope without a per-sample (or per-channel) Python loop.

    Instant-attack peak hold plus optional one-pole lag. ``attack_coeff`` near 0
    keeps the hold (fast path); near 1 lags it so a slow envelope cannot jump
    with a click. Release is the hold coefficient.
    """
    if abs_x.size == 0:
        return abs_x
    held = _peak_hold_exp(abs_x, release_coeff)
    attack_coeff = float(np.clip(attack_coeff, 0.0, 1.0 - 1e-12))
    if attack_coeff <= 1e-9:
        return held
    return _one_pole(held, attack_coeff)


def apply_transient_shaper(
    audio: np.ndarray,
    sr: int = 44100,
    attack: float = 1.0,
    sustain: float = 1.0,
    attack_ms: float = 1.0,
    release_ms: float = 40.0,
    sustain_ms: float = 180.0,
) -> np.ndarray:
    """
    Split a linked-stereo envelope into transient vs sustain and scale each.

    Mono ``(N,)`` and multi-channel ``(N, ch)`` are accepted. Peak is matched
    back to the input peak after shaping so a quiet file cannot explode.
    """
    frames, was_1d = _as_frames(audio)
    if frames.shape[0] == 0:
        return _restore_shape(frames, was_1d, audio.dtype)

    detector = np.max(np.abs(frames), axis=1)
    # Fast: instant attack + short release so clicks sit in the transient mask.
    # Slow: lagged hold so a steady tone is treated as sustain.
    fast = _envelope_follow(detector, 0.0, _time_const_coeff(sr, release_ms))
    slow_attack_ms = max(float(sustain_ms) * 0.35, float(attack_ms) * 8.0)
    slow = _envelope_follow(
        detector,
        _time_const_coeff(sr, slow_attack_ms),
        _time_const_coeff(sr, sustain_ms),
    )
    transient = np.clip((fast - slow) / (fast + EPS), 0.0, 1.0)
    gain = float(attack) * transient + float(sustain) * (1.0 - transient)
    processed = frames * gain[:, np.newaxis]

    orig_peak = float(np.max(np.abs(frames)))
    proc_peak = float(np.max(np.abs(processed)))
    if proc_peak > EPS and orig_peak > 0.0:
        processed *= orig_peak / proc_peak
    return _restore_shape(processed, was_1d, audio.dtype)
