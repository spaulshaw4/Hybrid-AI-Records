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

# Per-worker engine cache (sample_rate -> NativeAudioEngine)
_ENGINE_CACHE: dict[int, NativeAudioEngine] = {}


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


def _dest_path(slice_path: str, output_dir: str, source_root: str) -> tuple[str, str]:
    bus_type = detect_bus_type(os.path.basename(slice_path))
    rel = os.path.relpath(slice_path, source_root)
    rel_dir = os.path.dirname(rel)
    base = os.path.splitext(os.path.basename(rel))[0]
    out_dir = os.path.join(output_dir, rel_dir)
    out_path = os.path.join(out_dir, f"{base}_{bus_type}_locked.wav")
    return bus_type, out_path


def _get_engine(sr: int) -> NativeAudioEngine:
    engine = _ENGINE_CACHE.get(sr)
    if engine is None:
        engine = NativeAudioEngine(sample_rate=sr)
        _ENGINE_CACHE[sr] = engine
        # Warm Numba VCA envelope once per worker
        try:
            engine._vca_compress(np.zeros(256, dtype=np.float32), threshold_db=-14.0)
        except Exception:
            pass
    return engine


def process_single_slice(payload: tuple[str, str, str]) -> int:
    slice_path, output_dir, source_root = payload
    try:
        bus_type, out_path = _dest_path(slice_path, output_dir, source_root)
        if os.path.exists(out_path):
            return 1

        intensity = float(BUS_SETTINGS.get(bus_type, 0.50))
        os.makedirs(os.path.dirname(out_path), exist_ok=True)

        data, sr = sf.read(slice_path, dtype="float32")
        if data.ndim > 1:
            data = np.mean(data, axis=1)

        engine = _get_engine(int(sr))
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


def pending_jobs(
    slice_files: list[str], output_dir: str, source_root: str
) -> list[tuple[str, str, str]]:
    """Filter to destinations that do not exist yet (skip in parent, not workers).

    Builds an in-memory set of existing locked basenames by walking the output
    tree once — much faster than ``os.path.exists`` per source file on Windows.
    """
    existing: set[str] = set()
    if os.path.isdir(output_dir):
        for root, _, names in os.walk(output_dir):
            for n in names:
                if n.lower().endswith("_locked.wav"):
                    existing.add(n.lower())

    jobs: list[tuple[str, str, str]] = []
    skipped = 0
    for path in slice_files:
        bus_type = detect_bus_type(os.path.basename(path))
        base = os.path.splitext(os.path.basename(path))[0]
        dest_name = f"{base}_{bus_type}_locked.wav"
        if dest_name.lower() in existing:
            skipped += 1
            continue
        jobs.append((path, output_dir, source_root))

    print(f"Already locked (skipped in parent): {skipped:,}")
    print(f"Pending for DSP: {len(jobs):,}")
    return jobs


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
    parser.add_argument(
        "--workers",
        type=int,
        default=max(1, (os.cpu_count() or 8)),
        help="Process pool size (default: CPU count)",
    )
    parser.add_argument("--chunksize", type=int, default=64)
    parser.add_argument("--progress-every", type=int, default=2000)
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    source_root, slice_files = discover_slices(args.slices_dir, args.fallback_slices_dir)
    total = len(slice_files)
    print(f"Source root: {source_root}")
    print(f"Found {total:,} slices in source tree.")
    if total == 0:
        return 1

    jobs = pending_jobs(slice_files, args.output_dir, source_root)
    pending = len(jobs)
    if pending == 0:
        print("Nothing pending — all destinations already exist.")
        return 0

    already = total - pending
    locked_count = already
    workers = max(1, int(args.workers))
    print(f"Workers: {workers}  chunksize: {args.chunksize}")

    with ProcessPoolExecutor(max_workers=workers) as executor:
        for idx, result in enumerate(
            executor.map(process_single_slice, jobs, chunksize=args.chunksize),
            start=1,
        ):
            locked_count += int(result)
            if idx % max(1, int(args.progress_every)) == 0:
                pct = 100.0 * locked_count / total
                rate_note = f"pending done {idx:,}/{pending:,}"
                print(
                    f"Locked {locked_count:,}/{total:,} slices ({pct:.1f}%) "
                    f"[{rate_note}]"
                )

    print(f"Completed: {locked_count:,} slices accounted in {args.output_dir}")
    return 0 if locked_count > 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
