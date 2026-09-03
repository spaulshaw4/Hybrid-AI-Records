"""TPDF dither + optional 1st-order error feedback before integer quantization."""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np

LEGAL_BITS = frozenset({16, 24})


def _as_2d(audio: np.ndarray) -> tuple[np.ndarray, bool]:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return data[:, np.newaxis], True
    if data.ndim == 2:
        return data, False
    raise ValueError("audio must be shape (N,) or (N, ch)")


def quantize_to_bits(audio: np.ndarray, target_bits: int) -> np.ndarray:
    """Quantize to the target PCM grid and clip to the legal float range."""
    if target_bits not in LEGAL_BITS:
        raise ValueError(f"target_bits must be one of {sorted(LEGAL_BITS)}")
    scale = float(1 << (target_bits - 1))
    peak = scale - 1.0
    data, was_mono = _as_2d(audio)
    codes = np.rint(data * scale)
    codes = np.clip(codes, -scale, peak)
    out = codes / scale
    return out[:, 0] if was_mono else out


def _tpdf_noise(shape: tuple[int, ...], lsb: float, rng: np.random.Generator) -> np.ndarray:
    # Two independent uniforms in [-0.5, 0.5) give a triangular PDF of width 1 LSB.
    return (rng.random(shape) - rng.random(shape)) * lsb


def _shape_channel(samples: np.ndarray, dither: np.ndarray, scale: float, peak: float) -> np.ndarray:
    """1st-order error feedback.

    Recursive in time, so this is a tight per-channel sample loop (numba-free).
    Do not nest a Python loop over channels *and* samples at the call site —
    callers iterate channels once and this function owns the time axis.
    """
    out = np.empty_like(samples)
    error = 0.0
    inv_scale = 1.0 / scale
    for i, sample in enumerate(samples):
        shaped = float(sample) + float(dither[i]) - error
        code = float(np.rint(shaped * scale))
        if code > peak:
            code = peak
        elif code < -scale:
            code = -scale
        quantized = code * inv_scale
        error = quantized - shaped
        out[i] = quantized
    return out


def apply_tpdf_dither(
    audio: np.ndarray,
    target_bits: int = 24,
    seed: int | None = None,
    noise_shape: bool = True,
) -> np.ndarray:
    """Add TPDF dither, optionally 1st-order shape, then quantize and clip.

    ``target_bits`` is 16 or 24. ``seed`` is optional so tests can replay noise.
    Without noise shaping the path is fully vectorized. With shaping, TPDF is
    still vectorized and only the error-feedback recurrence loops per channel.
    """
    if target_bits not in LEGAL_BITS:
        raise ValueError(f"target_bits must be one of {sorted(LEGAL_BITS)}")
    data, was_mono = _as_2d(audio)
    scale = float(1 << (target_bits - 1))
    peak = scale - 1.0
    lsb = 1.0 / scale
    rng = np.random.default_rng(seed)
    dither = _tpdf_noise(data.shape, lsb, rng)

    if not noise_shape:
        quantized = quantize_to_bits(data + dither, target_bits)
        return quantized if not was_mono else np.asarray(quantized)

    shaped = np.empty_like(data)
    for channel in range(data.shape[1]):
        shaped[:, channel] = _shape_channel(data[:, channel], dither[:, channel], scale, peak)
    return shaped[:, 0] if was_mono else shaped


def main() -> int:
    parser = argparse.ArgumentParser(description="TPDF dither a wav to 16- or 24-bit PCM.")
    parser.add_argument("-i", "--input", required=True)
    parser.add_argument("-o", "--output", required=True)
    parser.add_argument("--bits", type=int, default=24, choices=sorted(LEGAL_BITS))
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--no-shape", action="store_true")
    args = parser.parse_args()
    import soundfile as sf

    data, sr = sf.read(args.input, always_2d=False)
    dithered = apply_tpdf_dither(data, target_bits=args.bits, seed=args.seed, noise_shape=not args.no_shape)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    subtype = "PCM_16" if args.bits == 16 else "PCM_24"
    sf.write(args.output, dithered, sr, subtype=subtype)
    print(f"[DITHER] bits={args.bits} -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
