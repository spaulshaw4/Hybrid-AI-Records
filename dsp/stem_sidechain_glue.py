"""Duck harmonic/bass against a lowpassed kick/rhythm envelope.

Not a full mix bus. The detector is a Butterworth lowpass (~80–120 Hz) on the
rhythm stem — preemphasis would emphasize hats, which is the wrong sidechain.
Envelope is block peak-hold + lfilter (same approach as transient_shaper).
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Any

import numpy as np
from scipy.signal import butter, lfilter, sosfilt

_HERE = os.path.dirname(os.path.abspath(__file__))
_PARENT = os.path.abspath(os.path.join(_HERE, ".."))
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)

from dsp.transient_shaper import _peak_hold_exp, _time_const_coeff  # noqa: E402

DEFAULT_LP_HZ = 100.0
DEFAULT_ATTACK_MS = 8.0
DEFAULT_RELEASE_MS = 120.0
DEFAULT_DUCKING_RATIO = 0.35
ENV_GATE = 1e-4
EPS = 1e-12


def _as_frames(audio: np.ndarray) -> tuple[np.ndarray, bool]:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return data[:, np.newaxis], True
    return data, False


def _restore(frames: np.ndarray, was_1d: bool, dtype: np.dtype) -> np.ndarray:
    out = frames[:, 0] if was_1d else frames
    return out.astype(dtype, copy=False)


def _one_pole(signal: np.ndarray, coeff: float) -> np.ndarray:
    coeff = float(np.clip(coeff, 0.0, 1.0 - 1e-12))
    return lfilter([1.0 - coeff], [1.0, -coeff], signal)


def _align_length(a: np.ndarray, n: int) -> np.ndarray:
    frames, was_1d = _as_frames(a)
    if frames.shape[0] == n:
        return a if a.ndim == frames.ndim and (was_1d == (a.ndim == 1)) else (
            frames[:, 0] if was_1d else frames
        )
    if frames.shape[0] > n:
        frames = frames[:n]
    elif frames.shape[0] < n:
        pad = ((0, n - frames.shape[0]), (0, 0))
        frames = np.pad(frames, pad, mode="constant")
    return frames[:, 0] if was_1d else frames


def _lowpass_mono(mono: np.ndarray, sr: int, cutoff_hz: float = DEFAULT_LP_HZ) -> np.ndarray:
    if mono.size == 0 or sr <= 0:
        return mono
    nyquist = float(sr) / 2.0
    cut = float(np.clip(cutoff_hz, 80.0, 120.0))
    cut = min(cut, nyquist * 0.45)
    if cut < 20.0:
        return mono
    sos = butter(2, cut / nyquist, btype="lowpass", output="sos")
    return sosfilt(sos, mono)


def _kick_envelope(rhythm: np.ndarray, sr: int, attack_ms: float, release_ms: float) -> np.ndarray:
    frames, _ = _as_frames(rhythm)
    if frames.shape[0] == 0:
        return np.zeros(0, dtype=np.float64)
    mono = np.mean(frames, axis=1)
    detector = np.abs(_lowpass_mono(mono, sr))
    held = _peak_hold_exp(detector, _time_const_coeff(sr, release_ms))
    attack_c = _time_const_coeff(sr, attack_ms)
    if attack_c <= 1e-9:
        return held
    return _one_pole(held, attack_c)


def apply_sidechain_glue(
    harmonic: np.ndarray,
    rhythm: np.ndarray,
    sr: int = 44100,
    ducking_ratio: float = DEFAULT_DUCKING_RATIO,
    attack_ms: float = DEFAULT_ATTACK_MS,
    release_ms: float = DEFAULT_RELEASE_MS,
    cutoff_hz: float = DEFAULT_LP_HZ,
    **_: Any,
) -> np.ndarray:
    """Duck ``harmonic`` by the lowpassed rhythm envelope. Empty → passthrough."""
    harm = np.asarray(harmonic)
    if harm.size == 0:
        return harm
    frames, was_1d = _as_frames(harm)
    n = frames.shape[0]
    if n == 0:
        return _restore(frames, was_1d, harm.dtype)

    rhythm = _align_length(np.asarray(rhythm), n)
    env = _kick_envelope(rhythm, int(sr), attack_ms, release_ms)
    if env.size != n:
        env = _align_length(env, n)
        if env.ndim > 1:
            env = np.mean(np.asarray(env, dtype=np.float64), axis=1)

    peak = float(np.max(env)) if env.size else 0.0
    if peak < ENV_GATE:
        return _restore(frames, was_1d, harm.dtype)

    floor = float(np.clip(ducking_ratio, 0.0, 1.0))
    amount = np.clip(env / (peak + EPS), 0.0, 1.0)
    gain = np.clip(1.0 - amount * (1.0 - floor), floor, 1.0)
    ducked = frames * gain[:, np.newaxis]
    return _restore(ducked, was_1d, harm.dtype)


def main() -> int:
    parser = argparse.ArgumentParser(description="Duck a harmonic/bass WAV against a rhythm/kick WAV")
    parser.add_argument("--harmonic", required=True)
    parser.add_argument("--rhythm", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ratio", type=float, default=DEFAULT_DUCKING_RATIO)
    args = parser.parse_args()
    try:
        import soundfile as sf
    except ImportError:
        print("[ERROR] soundfile is required for CLI use", file=sys.stderr)
        return 1
    if not os.path.isfile(args.harmonic):
        raise FileNotFoundError(args.harmonic)
    if not os.path.isfile(args.rhythm):
        raise FileNotFoundError(args.rhythm)
    harmonic, sr = sf.read(args.harmonic, always_2d=True)
    rhythm, _ = sf.read(args.rhythm, always_2d=True)
    out = apply_sidechain_glue(harmonic, rhythm, sr=int(sr), ducking_ratio=args.ratio)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    sf.write(args.out, out, int(sr), subtype="PCM_24")
    print(f"[GLUE] wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
