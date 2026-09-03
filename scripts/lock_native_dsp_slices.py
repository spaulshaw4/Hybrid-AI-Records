"""Batch-process corpus slices through NativeAudioEngine and write locked WAVs."""

from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import soundfile as sf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.native_audio_engine import NativeAudioEngine

BUS_SETTINGS = {
    "acoustic": 0.50,
    "voice": 0.60,
    "electric": 0.70,
    "beats": 0.65,
    "bass": 0.55,
}


def detect_bus_type(filename: str) -> str:
    fn = filename.lower()
    if any(k in fn for k in ("vocal", "vox", "voice", "lead_dry")):
        return "voice"
    if any(k in fn for k in ("acoustic", "guitar_ac", "strum", "pluck")):
        return "acoustic"
    if any(k in fn for k in ("electric", "dist", "riff", "cab")):
        return "electric"
    if any(k in fn for k in ("beat", "drum", "percussion", "snap", "snare", "kick")):
        return "beats"
    if any(k in fn for k in ("bass", "sub", "808")):
        return "bass"
    return "acoustic"


def process_single_slice(payload: tuple[str, str, str]) -> int:
    slice_path, output_dir, source_root = payload
    try:
        bus_type = detect_bus_type(os.path.basename(slice_path))
        intensity = float(BUS_SETTINGS.get(bus_type, 0.50))

        rel = os.path.relpath(slice_path, source_root)
        rel_dir = os.path.dirname(rel)
        base = os.path.splitext(os.path.basename(rel))[0]
        out_dir = os.path.join(output_dir, rel_dir)
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, f"{base}_{bus_type}_locked.wav")

        # Skip already-locked files to avoid reprocessing collisions.
        if os.path.exists(out_path):
            return 1

        data, sr = sf.read(slice_path, dtype="float32")
        if data.ndim > 1:
            data = np.mean(data, axis=1)

        engine = NativeAudioEngine(sample_rate=int(sr))
        processed = engine.process_bus(data, bus_type=bus_type, intensity=intensity)

        sf.write(out_path, processed, int(sr), subtype="PCM_24")
        return 1
    except Exception:
        return 0


def discover_slices(primary: str, fallback: str) -> tuple[str, list[str]]:
    src = primary if os.path.isdir(primary) else fallback
    files: list[str] = []
    for root, _, names in os.walk(src):
        for n in names:
            if n.lower().endswith(".wav"):
                files.append(os.path.join(root, n))
    files.sort()
    return src, files


def main() -> int:
    parser = argparse.ArgumentParser(description="Lock corpus slices with NativeAudioEngine.")
    parser.add_argument(
        "--slices-dir",
        default=r"D:\MusicDatasets\mtg\corpus_4s_bulk",
        help="Primary input slice tree",
    )
    parser.add_argument(
        "--fallback-slices-dir",
        default=r"D:\MusicDatasets\corpus_4s",
        help="Fallback input tree if primary is missing",
    )
    parser.add_argument(
        "--output-dir",
        default=r"D:\MusicDatasets\mtg\corpus_4s_dsp_locked",
        help="Output root",
    )
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--chunksize", type=int, default=128)
    parser.add_argument("--progress-every", type=int, default=5000)
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    source_root, slice_files = discover_slices(args.slices_dir, args.fallback_slices_dir)
    total = len(slice_files)
    print(f"Source root: {source_root}")
    print(f"Found {total:,} slices ready for DSP lock-in.")
    if total == 0:
        return 1

    jobs = [(path, args.output_dir, source_root) for path in slice_files]
    locked_count = 0
    with ProcessPoolExecutor(max_workers=max(1, int(args.workers))) as executor:
        for idx, result in enumerate(executor.map(process_single_slice, jobs, chunksize=args.chunksize), start=1):
            locked_count += int(result)
            if locked_count and locked_count % max(1, int(args.progress_every)) == 0:
                pct = 100.0 * locked_count / total
                print(f"Locked {locked_count:,}/{total:,} slices ({pct:.1f}%)")
            if idx % 25000 == 0:
                pct = 100.0 * idx / total
                print(f"Scanned {idx:,}/{total:,} jobs ({pct:.1f}%), successful={locked_count:,}")

    print(f"Completed: {locked_count:,} slices written to {args.output_dir}")
    return 0 if locked_count > 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
