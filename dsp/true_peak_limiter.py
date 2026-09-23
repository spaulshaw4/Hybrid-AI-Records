"""Lookahead true-peak brickwall limiter (4x polyphase ISP detection)."""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.signal import lfilter, resample_poly

try:
    from scipy.ndimage import maximum_filter1d
except Exception:  # pragma: no cover - ndimage missing / blocked
    maximum_filter1d = None

OVERSAMPLE = 4
DEFAULT_CEILING_DBTP = -0.50
# Keeps rc**-block_len inside float64 range for the scaled running min.
_MAX_BLOCK_LOG_SCALE = 40.0


def _channels(audio: np.ndarray) -> np.ndarray:
    data = np.asarray(audio, dtype=np.float64)
    return data[:, np.newaxis] if data.ndim == 1 else data


def oversampled_peak_envelope(audio: np.ndarray) -> np.ndarray:
    """``max_ch |x|`` after 4x polyphase oversampling; length ``n * OVERSAMPLE``."""
    data = _channels(audio)
    envelope: np.ndarray | None = None
    for ch in range(data.shape[1]):
        oversampled = resample_poly(np.ascontiguousarray(data[:, ch]), OVERSAMPLE, 1)
        np.abs(oversampled, out=oversampled)
        envelope = oversampled if envelope is None else np.maximum(envelope, oversampled, out=envelope)
    return envelope if envelope is not None else np.zeros(0, dtype=np.float64)


def measure_true_peak_dbtp(audio: np.ndarray) -> float:
    data = _channels(audio)
    peak = 0.0
    for ch in range(data.shape[1]):
        oversampled = resample_poly(np.ascontiguousarray(data[:, ch]), OVERSAMPLE, 1)
        if oversampled.size:
            peak = max(peak, float(oversampled.max()), float(-oversampled.min()))
    return float(20.0 * np.log10(peak + 1e-12))


def _forward_window_max(envelope: np.ndarray, window: int) -> np.ndarray:
    """``out[i] = max(envelope[i : i + window])`` (edge-extended), O(n)."""
    if window <= 1:
        return envelope
    if maximum_filter1d is not None:
        # origin=-(window // 2) aligns the window to start at i.
        return maximum_filter1d(
            np.asarray(envelope, dtype=np.float64),
            size=int(window),
            origin=-(int(window) // 2),
            mode="nearest",
        )
    padded = np.pad(envelope, (0, window - 1), mode="edge")
    return np.max(sliding_window_view(padded, window), axis=1)[: envelope.shape[0]]


def _decaying_running_min(values: np.ndarray, rc: float, init: float) -> np.ndarray:
    """``m[i] = min(rc * m[i-1], values[i])`` with ``m[-1] = init``, vectorised.

    Within a block starting at ``s``: ``m[s+t] = rc**t * min(rc * m[s-1],
    cummin_u(values[s+u] * rc**-u))``. Blocks are sized so ``rc**-t`` stays
    finite.
    """
    x = np.asarray(values, dtype=np.float64)
    out = np.empty_like(x)
    if x.size == 0:
        return out
    decay = -float(np.log(rc))
    block = x.size if decay <= 0.0 else max(1, int(_MAX_BLOCK_LOG_SCALE / decay))
    prev = float(init)
    for start in range(0, x.size, block):
        seg = x[start : start + block]
        t = np.arange(seg.size, dtype=np.float64)
        grow = np.exp(decay * t)
        scaled = np.minimum.accumulate(seg * grow)
        np.minimum(scaled, rc * prev, out=scaled)
        out[start : start + seg.size] = scaled / grow
        prev = float(out[start + seg.size - 1])
    return out


def _lookahead_ramp(target: np.ndarray, window: int) -> np.ndarray:
    """Backward moving average of the look-ahead gain target (O(n) cumsum).

    ``target`` is already the forward-window minimum gain, so every sample in
    the ``window`` before a peak carries that peak's reduction; averaging over
    them reaches the full reduction exactly at the peak while turning the
    step into a linear ramp (and ramps back out the same way).
    """
    if window <= 1 or target.size == 0:
        return target
    padded = np.concatenate((np.full(window, target[0]), target))
    csum = np.cumsum(padded, dtype=np.float64)
    return (csum[window:] - csum[:-window]) / float(window)


def _follow_gain(target: np.ndarray, release_coeff: float) -> np.ndarray:
    """Instant attack, one-pole release toward ``target`` (starts at unity).

    Exact vectorised form of the per-sample recursion
    ``c[i] = min(w[i], rc * c[i-1] + (1 - rc) * w[i])``, ``c[-1] = 1``.
    Because each step is ``min`` of an increasing affine map, the recursion
    unrolls to ``c = L + M`` where ``L`` is the zero-state one-pole of ``w``
    (``scipy.signal.lfilter``) and ``M`` is a decaying running minimum of
    ``w - L``.
    """
    w = np.asarray(target, dtype=np.float64)
    rc = float(np.clip(release_coeff, 0.0, 1.0))
    if w.size == 0 or rc <= 0.0:
        return w.copy()
    if rc >= 1.0:
        return np.minimum.accumulate(np.minimum(w, 1.0))
    smoothed = lfilter([1.0 - rc], [1.0, -rc], w)
    return smoothed + _decaying_running_min(w - smoothed, rc, init=1.0)


def lookahead_samples_for(sr: int, lookahead_ms: float) -> int:
    return max(1, int(sr * OVERSAMPLE * (lookahead_ms / 1000.0)))


def peak_limiter_gain(
    window_max: np.ndarray,
    num_samples: int,
    *,
    sr: int = 44100,
    ceiling_dbtp: float = DEFAULT_CEILING_DBTP,
    lookahead_ms: float = 5.0,
    release_ms: float = 50.0,
    input_gain: float = 1.0,
) -> np.ndarray:
    """Base-rate gain curve (length ``num_samples``) for ``audio * input_gain``.

    ``window_max`` is ``_forward_window_max(oversampled_peak_envelope(audio),
    lookahead)``. The detector is linear in ``input_gain``, so callers can reuse
    one oversampled analysis while iterating the drive level. The 4x gain
    curve (look-ahead ramp in, one-pole release out) is decimated by taking
    the minimum of each group of ``OVERSAMPLE`` values, so every inter-sample
    peak of a base-rate sample is covered.
    """
    ceiling_linear = 10.0 ** (ceiling_dbtp / 20.0)
    lookahead = lookahead_samples_for(sr, lookahead_ms)
    release_coeff = float(np.exp(-1.0 / max(1.0, sr * OVERSAMPLE * (release_ms / 1000.0))))
    local_max = np.asarray(window_max, dtype=np.float64) * float(input_gain)
    target_gain = np.ones(local_max.shape[0], dtype=np.float64)
    over = local_max > ceiling_linear
    target_gain[over] = ceiling_linear / local_max[over]
    gain = _follow_gain(_lookahead_ramp(target_gain, lookahead), release_coeff)
    n_os = int(num_samples) * OVERSAMPLE
    if gain.shape[0] < n_os:
        gain = np.pad(gain, (0, n_os - gain.shape[0]), mode="edge")
    return gain[:n_os].reshape(int(num_samples), OVERSAMPLE).min(axis=1)


def apply_true_peak_limiter(
    audio: np.ndarray,
    sr: int = 44100,
    ceiling_dbtp: float = DEFAULT_CEILING_DBTP,
    lookahead_ms: float = 5.0,
    release_ms: float = 50.0,
) -> np.ndarray:
    """
    Lookahead brickwall limiter with 4x sinc oversampling for inter-sample peaks.

    Peaks are detected on the 4x oversampled signal; the smoothed gain curve
    (linear look-ahead ramp in, exponential release out) is applied at the
    base rate, then a final 4x true-peak measurement trims any residual
    overshoot. Output length matches the input.
    """
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        data = data[:, np.newaxis]
    num_samples, _num_channels = data.shape
    if num_samples == 0:
        return data.astype(audio.dtype, copy=False)

    envelope = oversampled_peak_envelope(data)
    window_max = _forward_window_max(envelope, lookahead_samples_for(sr, lookahead_ms))
    gain = peak_limiter_gain(
        window_max,
        num_samples,
        sr=sr,
        ceiling_dbtp=ceiling_dbtp,
        lookahead_ms=lookahead_ms,
        release_ms=release_ms,
    )
    limited = data * gain[:, np.newaxis]
    measured = measure_true_peak_dbtp(limited)
    if measured > ceiling_dbtp:
        limited *= 10.0 ** ((ceiling_dbtp - measured) / 20.0)
    return limited.astype(audio.dtype, copy=False)


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply -0.50 dBTP lookahead limiter")
    parser.add_argument("-i", "--input", required=True)
    parser.add_argument("-o", "--output", required=True)
    parser.add_argument("--ceiling", type=float, default=DEFAULT_CEILING_DBTP)
    args = parser.parse_args()
    import soundfile as sf

    data, sr = sf.read(args.input, always_2d=True)
    limited = apply_true_peak_limiter(data, sr=sr, ceiling_dbtp=args.ceiling)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    sf.write(args.output, limited, sr, subtype="PCM_24")
    print(f"[LIMITED] {measure_true_peak_dbtp(limited):.3f} dBTP -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
