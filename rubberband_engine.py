#!/usr/bin/env python3
"""Rubber Band time-stretch and pitch-shift for stem alignment."""
from __future__ import annotations

import numpy as np
import pyrubberband as pyrb
import soundfile as sf

CHROMATIC_SCALE = {
    "C": 0,
    "C#": 1,
    "DB": 1,
    "D": 2,
    "D#": 3,
    "EB": 3,
    "E": 4,
    "F": 5,
    "F#": 6,
    "GB": 6,
    "G": 7,
    "G#": 8,
    "AB": 8,
    "A": 9,
    "A#": 10,
    "BB": 10,
    "B": 11,
}

CAMELOT_TO_KEY = {
    "1B": "B Major",
    "1A": "G# Minor",
    "2B": "F# Major",
    "2A": "D# Minor",
    "3B": "C# Major",
    "3A": "A# Minor",
    "4B": "G# Major",
    "4A": "F Minor",
    "5B": "D# Major",
    "5A": "C Minor",
    "6B": "A# Major",
    "6A": "G Minor",
    "7B": "F Major",
    "7A": "D Minor",
    "8B": "C Major",
    "8A": "A Minor",
    "9B": "G Major",
    "9A": "E Minor",
    "10B": "D Major",
    "10A": "B Minor",
    "11B": "A Major",
    "11A": "F# Minor",
    "12B": "E Major",
    "12A": "C# Minor",
}


def normalize_key_label(key: str) -> str:
    raw = (key or "").strip()
    if not raw:
        return ""
    compact = raw.upper().replace(" ", "")
    if compact[-1:] in {"A", "B"} and compact[:-1].isdigit():
        num = int(compact[:-1])
        if 1 <= num <= 12:
            return CAMELOT_TO_KEY.get(f"{num}{compact[-1]}", raw)
    return raw


def calculate_semitone_shift(source_key: str, target_key: str) -> int:
    """Shortest chromatic shift from source key root to target key root."""
    src_label = normalize_key_label(source_key)
    tgt_label = normalize_key_label(target_key)
    if not src_label or not tgt_label or src_label == tgt_label:
        return 0

    src_root = src_label.split()[0].replace("b", "B").upper()
    tgt_root = tgt_label.split()[0].replace("b", "B").upper()
    if src_root not in CHROMATIC_SCALE or tgt_root not in CHROMATIC_SCALE:
        return 0

    diff = CHROMATIC_SCALE[tgt_root] - CHROMATIC_SCALE[src_root]
    if diff > 6:
        diff -= 12
    elif diff < -6:
        diff += 12
    return int(diff)


def _as_channels_first(data: np.ndarray) -> np.ndarray:
    if data.ndim == 1:
        return data[np.newaxis, :]
    if data.shape[0] <= 8 and data.shape[0] < data.shape[-1]:
        return data
    return data.T


def apply_rubberband(
    audio: np.ndarray,
    sr: int,
    *,
    n_steps: int = 0,
    rate: float = 1.0,
) -> np.ndarray:
    """audio is (channels, samples). pyrubberband runs per channel."""

    def transform(channel: np.ndarray) -> np.ndarray:
        out = channel.astype(np.float32, copy=False)
        if n_steps != 0:
            out = pyrb.pitch_shift(out, sr, n_steps=n_steps)
        if abs(rate - 1.0) > 0.01:
            out = pyrb.time_stretch(out, sr, rate=rate)
        return np.asarray(out, dtype=np.float32)

    channels = _as_channels_first(audio)
    if channels.shape[0] == 1:
        return transform(channels[0])
    return np.vstack([transform(ch) for ch in channels])


def align_audio(
    audio: np.ndarray,
    sr: int,
    source_bpm: float,
    target_bpm: float,
    source_key: str,
    target_key: str,
    stem_type: str = "",
) -> tuple[np.ndarray, dict]:
    tempo_ratio = (target_bpm / source_bpm) if source_bpm and target_bpm else 1.0
    is_drum = str(stem_type).lower() == "drums"
    semitones = 0 if is_drum else calculate_semitone_shift(source_key, target_key)
    processed = apply_rubberband(audio, sr, n_steps=semitones, rate=tempo_ratio)
    return processed, {
        "tempo_ratio": round(float(tempo_ratio), 3),
        "semitone_shift": semitones,
        "is_drum": is_drum,
    }


def align_stem(
    input_path: str,
    output_path: str,
    source_bpm: float,
    target_bpm: float,
    source_key: str,
    target_key: str,
    stem_type: str = "",
) -> dict:
    data, sr = sf.read(input_path, dtype="float32")
    inferred = stem_type or ("drums" if "drums" in input_path.lower() else "")
    channels = data.T if data.ndim > 1 else data[np.newaxis, :]
    processed, metrics = align_audio(
        channels,
        sr,
        source_bpm,
        target_bpm,
        source_key,
        target_key,
        stem_type=inferred,
    )
    out = processed.T if processed.ndim > 1 else processed
    sf.write(output_path, out, sr, subtype="PCM_24")
    return metrics
