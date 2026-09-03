"""Multi-core 4.0s re-slicer with zero-crossing snap and 5ms micro-fades."""
from __future__ import annotations

import argparse
import glob
import multiprocessing as mp
import os
import sys

import numpy as np
import soundfile as sf

RAW_STEMS_DIR = r"D:\MusicDatasets\raw_stems"
DSD100_DIR = r"D:\MusicDatasets\dsd100"
OUTPUT_CORPUS_DIR = r"D:\MusicDatasets\corpus_4s"
TARGET_SLICE_DURATION = 4.0
SAMPLE_RATE = 44100
FADE_SAMPLES = int(SAMPLE_RATE * 0.005)
SKIP_ROOTS = ("uploaded_slices", "renders", "scratch", "releases", "corpus_4s")


def find_zero_crossings(signal: np.ndarray, target_idx: int, window: int = 441) -> int:
    start = max(0, target_idx - window)
    end = min(len(signal) - 1, target_idx + window)
    region = signal[start:end]
    crossings = np.where(np.diff(np.signbit(region)))[0] + start
    if len(crossings) > 0:
        return int(crossings[np.argmin(np.abs(crossings - target_idx))])
    return target_idx


def discover_stems(raw_dir: str) -> list[str]:
    roots = []
    if raw_dir and os.path.isdir(raw_dir):
        roots.append(raw_dir)
    elif os.path.isdir(RAW_STEMS_DIR):
        roots.append(RAW_STEMS_DIR)
    if os.path.isdir(DSD100_DIR) and DSD100_DIR not in roots:
        roots.append(DSD100_DIR)

    stems = []
    for root in roots:
        for path in glob.glob(os.path.join(root, "**", "*.wav"), recursive=True):
            lowered = path.lower()
            if any(token in lowered for token in SKIP_ROOTS):
                continue
            stems.append(path)
    stems.sort()
    return stems


def process_stem_file(stem_path: str) -> int:
    try:
        info = sf.info(stem_path)
        if info.samplerate != SAMPLE_RATE:
            return 0
        if info.duration < TARGET_SLICE_DURATION:
            return 0

        data, sr = sf.read(stem_path, always_2d=True)
        num_channels = data.shape[1]
        total_samples = data.shape[0]
        slice_samples = int(TARGET_SLICE_DURATION * SAMPLE_RATE)
        mono_ref = np.mean(data, axis=1)
        stem_basename = os.path.splitext(os.path.basename(stem_path))[0]
        genre_folder = os.path.basename(os.path.dirname(stem_path))
        target_dir = os.path.join(OUTPUT_CORPUS_DIR, genre_folder)
        os.makedirs(target_dir, exist_ok=True)

        fade_in = np.linspace(0.0, 1.0, FADE_SAMPLES)
        fade_out = np.linspace(1.0, 0.0, FADE_SAMPLES)
        pos = 0
        slice_idx = 0
        generated = 0

        while pos + slice_samples <= total_samples:
            raw_end = pos + slice_samples
            end_pos = find_zero_crossings(mono_ref, min(raw_end, total_samples))
            if end_pos <= pos:
                end_pos = min(pos + slice_samples, total_samples)
            chunk = data[pos:end_pos, :].copy()
            if chunk.shape[0] >= (FADE_SAMPLES * 2):
                for ch in range(num_channels):
                    chunk[:FADE_SAMPLES, ch] *= fade_in
                    chunk[-FADE_SAMPLES:, ch] *= fade_out

            out_filename = f"{stem_basename}_s4_{slice_idx:05d}.wav"
            out_path = os.path.join(target_dir, out_filename)
            if not os.path.exists(out_path):
                sf.write(out_path, chunk, SAMPLE_RATE, subtype="PCM_24")
                generated += 1
            slice_idx += 1
            pos = end_pos
        return generated
    except Exception as exc:
        print(f"[ERROR] Failed processing {stem_path}: {exc}", file=sys.stderr)
        return 0


def run_reslice_pool(raw_dir: str = RAW_STEMS_DIR) -> int:
    os.makedirs(OUTPUT_CORPUS_DIR, exist_ok=True)
    all_stems = discover_stems(raw_dir)
    total_files = len(all_stems)
    print(f"[*] Found {total_files} raw stems to process into 4.0s slices...")
    if total_files == 0:
        print("[WARN] No eligible master stems found. Point --raw at dsd100 or raw_stems.")
        return 0

    cores = max(1, mp.cpu_count() - 2)
    with mp.Pool(processes=cores) as pool:
        results = pool.map(process_stem_file, all_stems)
    total_slices = sum(results)
    print(f"[COMPLETE] Generated {total_slices} phase-aligned 4.0-second slices across {cores} threads.")
    return total_slices


if __name__ == "__main__":
    mp.freeze_support()
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", default=RAW_STEMS_DIR)
    parser.add_argument("--corpus", default=OUTPUT_CORPUS_DIR)
    args = parser.parse_args()
    OUTPUT_CORPUS_DIR = args.corpus
    sys.exit(0 if run_reslice_pool(args.raw) >= 0 else 1)
