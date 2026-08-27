#!/usr/bin/env python3
"""Per-stem gain envelopes: intro, drop, breakdown, outro."""
from __future__ import annotations

import numpy as np


def generate_gain_envelope(total_samples: int, pattern: str = "full") -> np.ndarray:
    env = np.ones(max(total_samples, 1), dtype=np.float32)
    if total_samples <= 0:
        return env

    fade_len = max(1, int(total_samples * 0.15))
    fade_len = min(fade_len, total_samples)
    quarter_len = int(total_samples * 0.25)

    if pattern == "intro_fade":
        env[:fade_len] = np.linspace(0.0, 1.0, fade_len, dtype=np.float32)
    elif pattern == "drop_entry":
        env[:quarter_len] = 0.0
        attack = min(1000, max(0, total_samples - quarter_len))
        if attack > 0:
            env[quarter_len : quarter_len + attack] = np.linspace(0.0, 1.0, attack, dtype=np.float32)
    elif pattern == "breakdown":
        env[:quarter_len] = 0.0
        env[int(total_samples * 0.75) :] = 0.0
    elif pattern == "outro_fade":
        env[-fade_len:] = np.linspace(1.0, 0.0, fade_len, dtype=np.float32)

    return env


def arrange_stem_layer(audio_layer: np.ndarray, stem_type: str) -> np.ndarray:
    if audio_layer.ndim == 1:
        audio_layer = np.vstack([audio_layer, audio_layer])

    _channels, samples = audio_layer.shape
    if stem_type == "drums":
        env = generate_gain_envelope(samples, pattern="drop_entry")
    elif stem_type == "bass":
        env = generate_gain_envelope(samples, pattern="drop_entry")
    elif stem_type == "other":
        env = generate_gain_envelope(samples, pattern="intro_fade")
    elif stem_type == "vocals":
        env = generate_gain_envelope(samples, pattern="breakdown")
    else:
        env = generate_gain_envelope(samples, pattern="full")

    arranged = audio_layer * env[np.newaxis, :]
    return arranged.astype(np.float32)
