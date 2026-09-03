"""Zero-phase HF harmonic exciter (cubic + asymmetric) with peak match."""
from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfiltfilt

DEFAULT_AIR_HZ = 7000.0
DEFAULT_DRIVE = 0.35
DEFAULT_MIX = 0.22
_NYQUIST_GUARD = 0.45


def _as_frames(audio: np.ndarray) -> tuple[np.ndarray, bool]:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return data[:, np.newaxis], True
    return data, False


def _restore_shape(frames: np.ndarray, was_1d: bool, dtype: np.dtype) -> np.ndarray:
    out = frames[:, 0] if was_1d else frames
    return out.astype(dtype, copy=False)


def apply_harmonic_exciter(
    audio: np.ndarray,
    sr: int = 44100,
    air_freq_hz: float = DEFAULT_AIR_HZ,
    drive: float = DEFAULT_DRIVE,
    mix: float = DEFAULT_MIX,
) -> np.ndarray:
    """
    Extract the air band, add cubic (odd) and asymmetric (even) harmonics,
    blend, then peak-match so the output never exceeds the input peak.

    Offline masters use ``sosfiltfilt`` on the HPF and again after the
    nonlinearity so the excite path stays linear-phase. Causal ``sosfilt``
    would smear transients. ``air_freq_hz`` is clamped below
    ``sr/2 * 0.45``. ``drive <= 0`` or ``mix <= 0`` is a pass-through.
    """
    frames, was_1d = _as_frames(audio)
    if frames.shape[0] == 0 or sr <= 0:
        return _restore_shape(frames, was_1d, audio.dtype)
    if float(drive) <= 0.0 or float(mix) <= 0.0:
        return np.asarray(audio)

    nyquist = float(sr) / 2.0
    cutoff = min(float(air_freq_hz), nyquist * _NYQUIST_GUARD)
    if cutoff <= 80.0:
        return np.asarray(audio)

    sos = butter(2, cutoff, btype="highpass", fs=sr, output="sos")
    hf = sosfiltfilt(sos, frames, axis=0)

    cubic = np.power(hf, 3)
    asymmetric = np.where(hf >= 0.0, np.square(hf), 0.35 * np.square(hf))
    excited = hf + float(drive) * (cubic + 0.5 * asymmetric)
    excited = sosfiltfilt(sos, excited, axis=0)

    blended = frames + float(mix) * (excited - hf)

    in_peak = float(np.max(np.abs(frames)))
    out_peak = float(np.max(np.abs(blended)))
    if out_peak > in_peak and out_peak > 1e-12:
        blended *= in_peak / out_peak
    return _restore_shape(blended, was_1d, audio.dtype)
