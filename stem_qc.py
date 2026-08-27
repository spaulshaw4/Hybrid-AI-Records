#!/usr/bin/env python3
"""Reject Demucs stems that are silent, watery, or phase-corrupted before R2 upload."""
from __future__ import annotations

import numpy as np
import librosa
import soundfile as sf

MIN_ENERGY_RMS = 0.005
MIN_SNR_DB = 8.0
MIN_PHASE_COHERENCE = 0.15


def calculate_spectral_snr(y: np.ndarray, sr: int = 44100) -> float:
    """HPSS residual as a proxy for coherent signal vs watery bleed."""
    if y.size == 0 or not np.any(np.isfinite(y)):
        return 0.0
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
    H, P = librosa.decompose.hpss(S, margin=2.0)
    signal_energy = float(np.sum(H**2 + P**2))
    noise_energy = float(np.sum((S - (H + P)) ** 2)) + 1e-10
    if signal_energy <= 0.0:
        return 0.0
    snr_db = 10.0 * np.log10(signal_energy / noise_energy)
    if not np.isfinite(snr_db):
        return 0.0
    return float(snr_db)


def calculate_phase_coherence(stereo_audio: np.ndarray) -> float:
    """Pearson correlation of L/R. Shape is (channels, samples)."""
    if stereo_audio.ndim < 2 or stereo_audio.shape[0] < 2:
        return 1.0
    left = stereo_audio[0]
    right = stereo_audio[1]
    std_prod = float(np.std(left) * np.std(right))
    if std_prod == 0.0:
        return 0.0
    coherence = float(
        np.mean((left - np.mean(left)) * (right - np.mean(right))) / std_prod
    )
    if not np.isfinite(coherence):
        return 0.0
    return coherence


def validate_stem_quality(stem_path: str) -> dict:
    data, sr = sf.read(stem_path, dtype="float32")
    if data.size == 0:
        return {
            "valid": False,
            "reason": "Empty audio buffer",
            "rms": 0.0,
            "snr_db": 0.0,
            "phase_coherence": 0.0,
        }

    if data.ndim == 1:
        channels = data[np.newaxis, :]
        mono = data
    else:
        channels = data.T
        mono = np.mean(data, axis=1)

    rms = float(np.sqrt(np.mean(mono**2)))
    if rms < MIN_ENERGY_RMS:
        return {
            "valid": False,
            "reason": f"Insufficient energy (RMS: {rms:.5f} < {MIN_ENERGY_RMS})",
            "rms": rms,
            "snr_db": 0.0,
            "phase_coherence": 0.0,
        }

    phase_coherence = calculate_phase_coherence(channels)
    if phase_coherence < MIN_PHASE_COHERENCE:
        return {
            "valid": False,
            "reason": (
                f"Severe phase cancellation "
                f"(Coherence: {phase_coherence:.3f} < {MIN_PHASE_COHERENCE})"
            ),
            "rms": rms,
            "snr_db": 0.0,
            "phase_coherence": phase_coherence,
        }

    snr_db = calculate_spectral_snr(mono, sr=sr)
    if snr_db < MIN_SNR_DB:
        return {
            "valid": False,
            "reason": (
                f"High separation noise/bleed "
                f"(SNR: {snr_db:.2f} dB < {MIN_SNR_DB} dB)"
            ),
            "rms": rms,
            "snr_db": snr_db,
            "phase_coherence": phase_coherence,
        }

    return {
        "valid": True,
        "reason": "OK",
        "rms": round(rms, 4),
        "snr_db": round(snr_db, 2),
        "phase_coherence": round(phase_coherence, 3),
    }
