"""Lookahead true-peak brickwall limiter (4x polyphase ISP detection)."""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.signal import resample_poly

OVERSAMPLE = 4
DEFAULT_CEILING_DBTP = -0.50


def measure_true_peak_dbtp(audio: np.ndarray) -> float:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        data = data[:, np.newaxis]
    peak = 0.0
    for ch in range(data.shape[1]):
        oversampled = resample_poly(data[:, ch], OVERSAMPLE, 1)
        peak = max(peak, float(np.max(np.abs(oversampled))))
    return float(20.0 * np.log10(peak + 1e-12))


def _forward_window_max(envelope: np.ndarray, window: int) -> np.ndarray:
    if window <= 1:
        return envelope
    padded = np.pad(envelope, (0, window - 1), mode="edge")
    return np.max(sliding_window_view(padded, window), axis=1)[: envelope.shape[0]]


def _follow_gain(target: np.ndarray, release_coeff: float) -> np.ndarray:
    gain = np.empty_like(target)
    current = 1.0
    for i, wanted in enumerate(target):
        if wanted < current:
            current = wanted
        else:
            current = wanted + release_coeff * (current - wanted)
        gain[i] = current
    return gain


def apply_true_peak_limiter(
    audio: np.ndarray,
    sr: int = 44100,
    ceiling_dbtp: float = DEFAULT_CEILING_DBTP,
    lookahead_ms: float = 5.0,
    release_ms: float = 50.0,
) -> np.ndarray:
    """
    Lookahead brickwall limiter with 4x sinc oversampling for inter-sample peaks.
    Instant attack, exponential release. Output length matches the input.
    """
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        data = data[:, np.newaxis]
    num_samples, _num_channels = data.shape
    if num_samples == 0:
        return data.astype(audio.dtype, copy=False)

    ceiling_linear = 10.0 ** (ceiling_dbtp / 20.0)
    lookahead_samples = max(1, int(sr * OVERSAMPLE * (lookahead_ms / 1000.0)))
    release_coeff = float(np.exp(-1.0 / max(1.0, sr * OVERSAMPLE * (release_ms / 1000.0))))

    oversampled = resample_poly(data, OVERSAMPLE, 1, axis=0)
    peak_env = np.max(np.abs(oversampled), axis=1)
    local_max = _forward_window_max(peak_env, lookahead_samples)
    target_gain = np.ones(peak_env.shape[0], dtype=np.float64)
    over = local_max > ceiling_linear
    target_gain[over] = ceiling_linear / local_max[over]
    gain_reduction = _follow_gain(target_gain, release_coeff)

    os_limited = oversampled * gain_reduction[:, np.newaxis]
    os_limited = np.clip(os_limited, -ceiling_linear, ceiling_linear)
    limited = resample_poly(os_limited, 1, OVERSAMPLE, axis=0)
    if limited.shape[0] < num_samples:
        limited = np.pad(limited, ((0, num_samples - limited.shape[0]), (0, 0)), mode="edge")
    else:
        limited = limited[:num_samples]

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
