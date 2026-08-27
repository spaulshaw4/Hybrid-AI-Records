#!/usr/bin/env python3
"""Sum isolated stems to a stereo pre-master with headroom protection.

Does not run the Pedalboard mastering chain. After summing, call `master_audio`
(or `apply_mastering_chain`) exactly once.
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

STEM_WEIGHTS = {
    "drums": 1.0,
    "bass": 1.0,
    "vocals": 1.1,
    "other": 0.9,
}


def _to_stereo(data: np.ndarray) -> np.ndarray:
    if data.ndim == 1:
        return np.stack((data, data), axis=-1)
    if data.shape[1] == 1:
        return np.repeat(data, 2, axis=1)
    return data[:, :2]


def _resample(data: np.ndarray, src_sr: int, target_sr: int) -> np.ndarray:
    if src_sr == target_sr or data.shape[0] == 0:
        return data.astype(np.float32, copy=False)
    g = np.gcd(src_sr, target_sr)
    up, down = target_sr // g, src_sr // g
    resampled = signal.resample_poly(data, up, down, axis=0)
    return np.asarray(resampled, dtype=np.float32)


def sum_and_master_stems(
    stem_paths: dict,
    output_path: str,
    target_sr: int = 44100,
) -> str:
    combined: np.ndarray | None = None
    for name, path in stem_paths.items():
        if not path or not os.path.exists(path):
            continue
        data, sr = sf.read(path, dtype="float32")
        data = _to_stereo(data)
        data = _resample(data, int(sr), target_sr)
        data = data * float(STEM_WEIGHTS.get(name, 1.0))
        if combined is None:
            combined = np.zeros_like(data)
        if data.shape[0] > combined.shape[0]:
            pad = np.zeros((data.shape[0] - combined.shape[0], 2), dtype=np.float32)
            combined = np.vstack([combined, pad])
        elif data.shape[0] < combined.shape[0]:
            pad = np.zeros((combined.shape[0] - data.shape[0], 2), dtype=np.float32)
            data = np.vstack([data, pad])
        combined += data

    if combined is None:
        raise ValueError("No valid stems provided for summing.")

    peak = float(np.max(np.abs(combined)))
    if peak > 0.95:
        combined = combined / (peak / 0.95)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(output_path, combined.astype(np.float32), target_sr, subtype="PCM_24")
    print(f"Summed stems into: {output_path}")
    return output_path


if __name__ == "__main__":
    workspace = Path("/workspace/scratch") if Path("/workspace").is_dir() else Path("scratch")
    workspace.mkdir(parents=True, exist_ok=True)
    example = {
        "drums": str(workspace / "drums.wav"),
        "bass": str(workspace / "bass.wav"),
        "vocals": str(workspace / "vocals.wav"),
        "other": str(workspace / "other.wav"),
    }
    sum_and_master_stems(example, str(workspace / "pre_master.wav"))
