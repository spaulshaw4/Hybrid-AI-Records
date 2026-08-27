#!/usr/bin/env python3
"""Polish a user vocal take before hybrid mix."""
from __future__ import annotations

import numpy as np
import soundfile as sf
from pedalboard import (
    Compressor,
    HighShelfFilter,
    HighpassFilter,
    NoiseGate,
    Pedalboard,
    Reverb,
)


def polish_user_vocal(input_path: str, output_path: str, sr: int = 44100) -> str:
    data, file_sr = sf.read(input_path, dtype="float32")
    use_sr = int(file_sr) if file_sr else int(sr)

    if data.ndim == 1:
        channels_first = np.vstack([data, data])
    else:
        channels_first = data.T

    board = Pedalboard(
        [
            NoiseGate(threshold_db=-45.0, ratio=10.0, release_ms=250.0),
            HighpassFilter(cutoff_frequency_hz=100.0),
            Compressor(threshold_db=-18.0, ratio=4.0, attack_ms=5.0, release_ms=100.0),
            HighShelfFilter(cutoff_frequency_hz=8000.0, gain_db=3.0),
            Reverb(room_size=0.3, damping=0.5, wet_level=0.15, dry_level=0.85),
        ]
    )
    processed = board(channels_first.astype(np.float32), use_sr)
    sf.write(output_path, processed.T, use_sr, subtype="PCM_24")
    return output_path
