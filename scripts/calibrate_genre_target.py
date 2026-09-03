"""Measure a finished master and write a genre drive-trim overlay."""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

CONFIG_DIR = os.environ.get(
    "HYBRID_CALIBRATION_DIR",
    r"D:\MusicDatasets\config\genre_calibrations",
)


def compute_spectral_metrics(audio_path: str) -> dict:
    data, sr = sf.read(audio_path, always_2d=True)
    mono = np.mean(data, axis=1)
    rms = 20.0 * np.log10(np.sqrt(np.mean(mono**2)) + 1e-12)
    oversampled = resample_poly(mono, 4, 1)
    true_peak_dbtp = 20.0 * np.log10(np.max(np.abs(oversampled)) + 1e-12)
    fft_vals = np.abs(np.fft.rfft(mono))
    freqs = np.fft.rfftfreq(len(mono), 1.0 / float(sr))
    sub_energy = np.sum(fft_vals[(freqs >= 30) & (freqs <= 120)])
    air_energy = np.sum(fft_vals[(freqs >= 8000) & (freqs <= 16000)])
    sub_air_ratio = float(sub_energy / (air_energy + 1e-12))
    return {
        "rms_dbfs": round(float(rms), 2),
        "true_peak_dbtp": round(float(true_peak_dbtp), 2),
        "sub_air_ratio": round(sub_air_ratio, 2),
        "sample_rate": int(sr),
        "duration_sec": round(len(mono) / float(sr), 3),
    }


def drive_trim_for(rms_dbfs: float) -> float:
    if rms_dbfs < -12.5:
        return 0.02
    if rms_dbfs > -11.5:
        return -0.02
    return 0.0


def calibrate_genre_profile(genre_name: str, audio_path: str, apply: bool) -> dict:
    metrics = compute_spectral_metrics(audio_path)
    drive_trim = drive_trim_for(float(metrics["rms_dbfs"]))
    payload = {
        "genre": genre_name,
        "source": os.path.abspath(audio_path),
        "measured_at": datetime.now(timezone.utc).isoformat(),
        "metrics": metrics,
        "recommended": {
            "saturation_drive_trim": drive_trim,
            "true_peak_ceiling_dbtp": -0.50,
            "target_rms_dbfs": -12.0,
        },
    }
    print(f"[*] Calibration metrics for '{genre_name}':")
    print(json.dumps(metrics, indent=2))
    print(f"[RECOMMENDED ADJUSTMENT] Saturation Drive trim: {drive_trim:+.2f}")
    if apply:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        out = os.path.join(CONFIG_DIR, f"{genre_name}.json")
        with open(out, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        print(f"[WROTE] {out}")
    return payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--genre", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--apply", action="store_true", help="Write overlay JSON under config/genre_calibrations")
    args = parser.parse_args()
    if not os.path.isfile(args.audio):
        print(f"[ERROR] missing audio: {args.audio}", file=sys.stderr)
        sys.exit(1)
    calibrate_genre_profile(args.genre, args.audio, args.apply)
