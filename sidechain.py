#!/usr/bin/env python3
"""Amplitude-follower vocal ducking for bass and other layers."""
from __future__ import annotations

import numpy as np
import soundfile as sf


def extract_envelope(
    audio: np.ndarray,
    sr: int = 44100,
    attack_ms: float = 15.0,
    release_ms: float = 150.0,
) -> np.ndarray:
    """Smooth gain-reduction envelope from a sidechain control signal."""
    mono = np.mean(audio, axis=0) if audio.ndim > 1 else audio
    rectified = np.abs(mono.astype(np.float64, copy=False))
    attack_samples = max(1.0, sr * (attack_ms / 1000.0))
    release_samples = max(1.0, sr * (release_ms / 1000.0))
    alpha_attack = float(np.exp(-1.0 / attack_samples))
    alpha_release = float(np.exp(-1.0 / release_samples))

    envelope = np.empty_like(rectified)
    current = 0.0
    for i, val in enumerate(rectified):
        if val > current:
            current = alpha_attack * current + (1.0 - alpha_attack) * val
        else:
            current = alpha_release * current + (1.0 - alpha_release) * val
        envelope[i] = current
    return envelope.astype(np.float32)


def duck_backing_array(
    backing: np.ndarray,
    vocals: np.ndarray,
    sr: int = 44100,
    max_ducking_db: float = -3.5,
    threshold: float = 0.05,
    attack_ms: float = 10.0,
    release_ms: float = 200.0,
) -> np.ndarray:
    """Duck backing (channels, samples) from a vocal control signal."""
    b_chan = backing if backing.ndim > 1 else backing[np.newaxis, :]
    v_chan = vocals if vocals.ndim > 1 else vocals[np.newaxis, :]
    min_len = min(b_chan.shape[1], v_chan.shape[1])
    if min_len <= 0:
        return backing.astype(np.float32, copy=False)

    b_chan = b_chan[:, :min_len]
    v_chan = v_chan[:, :min_len]
    env = extract_envelope(v_chan, sr=sr, attack_ms=attack_ms, release_ms=release_ms)
    if float(np.max(env)) <= threshold:
        return b_chan.astype(np.float32)

    gain_curve = np.ones(min_len, dtype=np.float32)
    mask = env > threshold
    peak = float(np.max(env))
    normalized = (env[mask] - threshold) / (peak - threshold + 1e-6)
    normalized = np.clip(normalized, 0.0, 1.0)
    duck_factor = 10.0 ** (max_ducking_db / 20.0)
    gain_curve[mask] = 1.0 - (normalized * (1.0 - duck_factor))
    return (b_chan * gain_curve).astype(np.float32)


def apply_dynamic_vocal_ducking(
    backing_path: str,
    vocal_path: str,
    output_path: str,
    max_ducking_db: float = -3.5,
    threshold: float = 0.05,
    attack_ms: float = 10.0,
    release_ms: float = 200.0,
) -> str:
    backing, sr = sf.read(backing_path, dtype="float32")
    vocals, _sr_v = sf.read(vocal_path, dtype="float32")
    b_chan = backing.T if backing.ndim > 1 else backing[np.newaxis, :]
    v_chan = vocals.T if vocals.ndim > 1 else vocals[np.newaxis, :]
    ducked = duck_backing_array(
        b_chan,
        v_chan,
        sr=sr,
        max_ducking_db=max_ducking_db,
        threshold=threshold,
        attack_ms=attack_ms,
        release_ms=release_ms,
    )
    sf.write(output_path, ducked.T, sr, subtype="PCM_24")
    return output_path
