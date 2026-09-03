"""2x-oversampled tanh tape saturation with HF warmth roll-off and RMS match."""
from __future__ import annotations

import numpy as np
from scipy.signal import butter, resample_poly, sosfilt

OVERSAMPLE = 2
DEFAULT_DRIVE = 2.5
DEFAULT_WARMTH_HZ = 18000.0
_NYQUIST_GUARD = 0.45


def _as_frames(audio: np.ndarray) -> tuple[np.ndarray, bool]:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return data[:, np.newaxis], True
    return data, False


def _restore_shape(frames: np.ndarray, was_1d: bool, dtype: np.dtype) -> np.ndarray:
    out = frames[:, 0] if was_1d else frames
    return out.astype(dtype, copy=False)


def _match_length(frames: np.ndarray, num_samples: int) -> np.ndarray:
    """resample_poly can drift by a few samples — trim or pad back to N."""
    if frames.shape[0] < num_samples:
        return np.pad(frames, ((0, num_samples - frames.shape[0]), (0, 0)), mode="edge")
    return frames[:num_samples]


def _rms(frames: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(frames))))


def apply_tape_saturation(
    audio: np.ndarray,
    sr: int = 44100,
    drive: float = DEFAULT_DRIVE,
    warmth_hz: float = DEFAULT_WARMTH_HZ,
) -> np.ndarray:
    """
    Soft-clip through ``tanh`` at 2x the source rate, then a causal warmth LPF
    on the oversampled path and an RMS match so loudness stays put.

    ``drive <= 0`` is a pass-through. Warmth defaults to 18 kHz and is clamped
    to 45% of the 2x-path Nyquist (``os_sr / 2 == sr``) so a 16 kHz master
    does not request 18 kHz past that limit. ``(sr * 2) / 2`` is just Nyquist
    of the oversampled path and is not a useful default cutoff.
    """
    frames, was_1d = _as_frames(audio)
    if frames.shape[0] == 0 or sr <= 0:
        return _restore_shape(frames, was_1d, audio.dtype)
    if float(drive) <= 0.0:
        return np.asarray(audio)

    num_samples = frames.shape[0]
    input_rms = _rms(frames)

    oversampled = resample_poly(frames, OVERSAMPLE, 1, axis=0)
    os_sr = float(sr) * OVERSAMPLE
    gain = 1.0 + float(drive)
    saturated = np.tanh(oversampled * gain) / max(float(np.tanh(gain)), 1e-12)

    os_nyquist = os_sr / 2.0
    cutoff = min(float(warmth_hz) if warmth_hz > 0.0 else DEFAULT_WARMTH_HZ, os_nyquist * _NYQUIST_GUARD)
    if cutoff > 20.0:
        sos = butter(2, cutoff, btype="lowpass", fs=os_sr, output="sos")
        saturated = sosfilt(sos, saturated, axis=0)

    down = resample_poly(saturated, 1, OVERSAMPLE, axis=0)
    down = _match_length(down, num_samples)

    out_rms = _rms(down)
    if out_rms > 1e-12 and input_rms > 1e-12:
        down *= input_rms / out_rms
    return _restore_shape(down, was_1d, audio.dtype)
