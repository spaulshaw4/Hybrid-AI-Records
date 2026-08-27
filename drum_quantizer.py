#!/usr/bin/env python3
"""Snap drum onsets to a BPM grid with localized micro-warping."""
from __future__ import annotations

import numpy as np
import librosa
import soundfile as sf


def detect_transient_onsets(y: np.ndarray, sr: int = 44100) -> np.ndarray:
    mono = np.mean(y, axis=0) if y.ndim > 1 else y
    hop_length = 256
    onset_env = librosa.onset.onset_strength(y=mono, sr=sr, hop_length=hop_length)
    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env,
        sr=sr,
        hop_length=hop_length,
        backtrack=True,
        pre_max=3,
        post_max=3,
        pre_avg=3,
        post_avg=5,
        delta=0.07,
        wait=4,
    )
    return librosa.frames_to_samples(onset_frames, hop_length=hop_length)


def quantize_drum_array(
    channels_first: np.ndarray,
    sr: int,
    target_bpm: float,
    subdivision: int = 16,
    strength: float = 0.85,
) -> tuple[np.ndarray, dict]:
    audio = channels_first if channels_first.ndim > 1 else channels_first[np.newaxis, :]
    num_channels, total_samples = audio.shape
    if target_bpm <= 0 or total_samples == 0:
        return audio.astype(np.float32), {"quantized": False, "transients_detected": 0}

    seconds_per_beat = 60.0 / target_bpm
    seconds_per_grid = seconds_per_beat / (subdivision / 4.0)
    samples_per_grid = int(round(seconds_per_grid * sr))
    if samples_per_grid <= 0:
        return audio.astype(np.float32), {"quantized": False, "transients_detected": 0}

    raw_onsets = detect_transient_onsets(audio, sr=sr)
    if len(raw_onsets) == 0:
        return audio.astype(np.float32), {"quantized": False, "transients_detected": 0}

    adjusted = []
    for onset in raw_onsets:
        nearest = int(round(onset / samples_per_grid)) * samples_per_grid
        target = int(round(onset + (nearest - onset) * strength))
        adjusted.append(max(0, min(total_samples - 1, target)))

    output = np.zeros_like(audio, dtype=np.float32)
    fade_len = max(1, int(sr * 0.005))
    src_markers = [0, *list(raw_onsets), total_samples]
    dst_markers = [0, *adjusted, total_samples]
    for i in range(len(src_markers) - 1):
        s_start, s_end = int(src_markers[i]), int(src_markers[i + 1])
        d_start, d_end = int(dst_markers[i]), int(dst_markers[i + 1])
        chunk = audio[:, s_start:s_end]
        target_len = d_end - d_start
        if target_len <= 0 or chunk.shape[1] == 0:
            continue
        indices = np.linspace(0, chunk.shape[1] - 1, target_len)
        resampled = np.zeros((num_channels, target_len), dtype=np.float32)
        src_idx = np.arange(chunk.shape[1])
        for c in range(num_channels):
            resampled[c] = np.interp(indices, src_idx, chunk[c])
        if target_len > fade_len * 2:
            fade_in = 0.5 * (1.0 - np.cos(np.linspace(0, np.pi, fade_len)))
            fade_out = 0.5 * (1.0 + np.cos(np.linspace(0, np.pi, fade_len)))
            resampled[:, :fade_len] *= fade_in
            resampled[:, -fade_len:] *= fade_out
        end_write = min(total_samples, d_start + target_len)
        if end_write > d_start:
            output[:, d_start:end_write] += resampled[:, : end_write - d_start]

    return output, {
        "quantized": True,
        "transients_detected": int(len(raw_onsets)),
        "target_bpm": target_bpm,
        "grid_subdivision": f"1/{subdivision}th",
    }


def quantize_drum_stem(
    audio_path: str,
    target_bpm: float,
    output_path: str,
    subdivision: int = 16,
    strength: float = 0.85,
) -> dict:
    data, sr = sf.read(audio_path, dtype="float32")
    channels_first = data.T if data.ndim > 1 else data[np.newaxis, :]
    quantized, meta = quantize_drum_array(
        channels_first,
        sr,
        target_bpm,
        subdivision=subdivision,
        strength=strength,
    )
    sf.write(output_path, quantized.T, sr, subtype="PCM_24")
    return meta
