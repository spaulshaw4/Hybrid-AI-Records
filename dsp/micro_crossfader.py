"""Equal-power cosine/sine micro-crossfade for mono and stereo slices."""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np


def _as_2d(audio: np.ndarray) -> tuple[np.ndarray, bool]:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return data[:, np.newaxis], True
    if data.ndim == 2:
        return data, False
    raise ValueError("audio must be shape (N,) or (N, ch)")


def _restore(data: np.ndarray, was_mono: bool) -> np.ndarray:
    return data[:, 0] if was_mono else data


def apply_equal_power_crossfade(a: np.ndarray, b: np.ndarray, fade_samples: int) -> np.ndarray:
    """Crossfade A into B with cos/sin equal-power gains.

    Output length is ``len(A) + len(B) - fade``. Fade is clamped to the shorter
    input. ``fade_samples <= 0`` concatenates.
    """
    left, left_mono = _as_2d(a)
    right, right_mono = _as_2d(b)
    if left.shape[1] != right.shape[1]:
        raise ValueError("channel counts must match")
    fade = int(fade_samples)
    if fade <= 0:
        stacked = np.concatenate((left, right), axis=0)
        return _restore(stacked, left_mono and right_mono)

    fade = min(fade, left.shape[0], right.shape[0])
    theta = np.linspace(0.0, 0.5 * np.pi, fade, dtype=np.float64)
    gain_a = np.cos(theta)[:, np.newaxis]
    gain_b = np.sin(theta)[:, np.newaxis]
    overlap = left[-fade:] * gain_a + right[:fade] * gain_b
    head = left[:-fade] if left.shape[0] > fade else left[:0]
    tail = right[fade:] if right.shape[0] > fade else right[:0]
    out = np.concatenate((head, overlap, tail), axis=0)
    return _restore(out, left_mono and right_mono)


def crossfade_sequence(slices: list[np.ndarray], fade_samples: int) -> np.ndarray:
    """Equal-power fold of N slices. Empty input raises."""
    if not slices:
        raise ValueError("slices must be non-empty")
    current = np.asarray(slices[0], dtype=np.float64)
    for nxt in slices[1:]:
        current = apply_equal_power_crossfade(current, nxt, fade_samples)
    return current


def main() -> int:
    parser = argparse.ArgumentParser(description="Equal-power crossfade two wavs.")
    parser.add_argument("input_a")
    parser.add_argument("input_b")
    parser.add_argument("-o", "--output", required=True)
    parser.add_argument("--fade", type=int, default=128)
    args = parser.parse_args()
    import soundfile as sf

    a, sr_a = sf.read(args.input_a, always_2d=False)
    b, sr_b = sf.read(args.input_b, always_2d=False)
    if sr_a != sr_b:
        raise SystemExit("sample rates must match")
    out = apply_equal_power_crossfade(a, b, args.fade)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    sf.write(args.output, out, sr_a, subtype="PCM_24")
    print(f"[CROSSFADE] n={out.shape[0]} -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
