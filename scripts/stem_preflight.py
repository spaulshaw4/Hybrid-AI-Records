"""Normalize incoming stems: 44.1 kHz, DC high-pass, trim silence, PCM_24."""
from __future__ import annotations

import argparse
import os
import sys
from math import gcd

import numpy as np
import soundfile as sf
from scipy.signal import butter, resample_poly, sosfilt

TARGET_SR = 44100
DC_CUTOFF_HZ = 10.0
SILENCE_DB = -60.0


def remove_dc_offset(audio_data: np.ndarray, cutoff_hz: float = DC_CUTOFF_HZ, sr: int = TARGET_SR) -> np.ndarray:
    sos = butter(2, cutoff_hz, btype="highpass", fs=sr, output="sos")
    return sosfilt(sos, audio_data, axis=0)


def resample_to_target(data: np.ndarray, sr: int, target_sr: int = TARGET_SR) -> np.ndarray:
    if sr == target_sr:
        return data
    divisor = gcd(int(sr), int(target_sr))
    up = int(target_sr) // divisor
    down = int(sr) // divisor
    return resample_poly(data, up, down, axis=0).astype(np.float64)


def trim_silence(data: np.ndarray, sr: int, floor_db: float = SILENCE_DB) -> np.ndarray:
    if data.size == 0:
        return data
    mono = np.mean(data, axis=1)
    floor = 10.0 ** (floor_db / 20.0)
    window = max(1, int(sr * 0.01))
    energy = np.convolve(mono * mono, np.ones(window) / window, mode="same")
    audible = energy > (floor * floor)
    if not np.any(audible):
        return data
    start = int(np.argmax(audible))
    end = int(len(audible) - np.argmax(audible[::-1]))
    return data[start:end, :]


def sanitize_stem(input_path: str, output_path: str) -> None:
    data, sr = sf.read(input_path, always_2d=True)
    if sr != TARGET_SR:
        print(f"[*] Resampling {input_path} from {sr}Hz to {TARGET_SR}Hz...")
        data = resample_to_target(data, sr, TARGET_SR)
    cleaned = remove_dc_offset(data, cutoff_hz=DC_CUTOFF_HZ, sr=TARGET_SR)
    cleaned = trim_silence(cleaned, TARGET_SR, SILENCE_DB)
    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    sf.write(output_path, cleaned, TARGET_SR, subtype="PCM_24")
    print(f"[PREFLIGHT OK] Sanitized stem written to {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input_stem")
    parser.add_argument("output_stem")
    args = parser.parse_args()
    try:
        sanitize_stem(args.input_stem, args.output_stem)
    except Exception as exc:
        print(f"[PREFLIGHT ERROR] Processing failed for {args.input_stem}: {exc}", file=sys.stderr)
        sys.exit(1)
