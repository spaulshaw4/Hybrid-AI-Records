#!/usr/bin/env python3
"""File-path wrapper around the broadcast mastering chain."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

from mastering import apply_mastering_chain


def master_audio(input_path: str, output_path: str, target_lufs: float = -14.0) -> str:
    audio, sample_rate = sf.read(input_path, dtype="float32")
    if audio.ndim == 1:
        channels_first = np.vstack([audio, audio])
    else:
        channels_first = audio.T
    mastered = apply_mastering_chain(channels_first, sr=int(sample_rate), target_lufs=target_lufs)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(output_path, mastered.T, int(sample_rate), subtype="PCM_24")
    print(f"Mastering complete. Saved to: {output_path}")
    return output_path


if __name__ == "__main__":
    scratch = Path("/workspace/scratch") if Path("/workspace").is_dir() else Path("scratch")
    master_audio(str(scratch / "pre_master.wav"), str(scratch / "final_master.wav"))
