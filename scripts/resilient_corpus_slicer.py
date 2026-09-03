"""
Sleep-proof 4.0s corpus slicer.

Keeps the Windows sleep lock up for the whole batch, isolates decode errors
per file, and skips slices that already exist so a crash or reboot can resume.

Default sources: D:\\MusicDatasets\\raw_stems
Fallback master root (when raw_stems is missing): D:\\MusicDatasets\\dsd100

NEVER deletes or moves originals. Writes PCM_24 copies only.
"""
from __future__ import annotations

import argparse
import ctypes
import glob
import os
import re
import sys
import time

import numpy as np
import soundfile as sf

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001

DEFAULT_RAW = r"D:\MusicDatasets\raw_stems"
DEFAULT_DSD100 = r"D:\MusicDatasets\dsd100"
DEFAULT_CORPUS = r"D:\MusicDatasets\corpus_4s"
SILENCE_FLOOR_DBFS = -50.0
GENERIC_STEM_NAMES = {
    "bass", "drums", "vocals", "other", "mixture", "mix", "accompaniment",
}
STRUCTURAL_DIRS = {
    "dsd100", "mixtures", "sources", "dev", "test", "train", "valid",
    "stems", "raw", "wav", "audio", "mixes", "mixture", "source",
    "raw_stems", "incoming", "uploaded_slices", "musicdatasets",
}
LOCK_NAME = ".slicer.lock"


def prevent_sleep():
    try:
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
    except AttributeError:
        pass


def allow_sleep():
    try:
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
    except AttributeError:
        pass


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")


def unique_base_name(input_path: str) -> str:
    """Avoid DSD100 collisions (every track has bass.wav / drums.wav / ...)."""
    stem = os.path.splitext(os.path.basename(input_path))[0]
    if stem.lower() in GENERIC_STEM_NAMES:
        parent = os.path.basename(os.path.dirname(input_path))
        return f"{slugify(parent)}__{slugify(stem)}"
    return slugify(stem) or stem


def infer_genre(input_path: str, raw_root: str, known_genres: set[str]) -> str | None:
    """Return a genre folder when sources are genre-organized; else None (flat)."""
    try:
        rel = os.path.relpath(input_path, raw_root)
    except ValueError:
        rel = input_path
    parts = [p for p in os.path.normpath(rel).split(os.sep) if p and p not in (".", "..")]
    parts = parts[:-1]  # drop filename

    for part in parts:
        slug = slugify(part)
        if slug in known_genres:
            return slug

    for part in parts:
        slug = slugify(part)
        if not slug or slug in STRUCTURAL_DIRS:
            continue
        if " - " in part or re.match(r"^\d{2,3}\b", part):
            continue
        return slug
    return None


def discover_known_genres() -> set[str]:
    known = {
        "alt_rock", "alternativerock", "alternative_rock", "heavy_alternative_rock",
        "bluesrock", "classicrock", "nu_metal", "rap_rock",
    }
    for root in (
        r"D:\MusicDatasets\incoming",
        r"D:\MusicDatasets\uploaded_slices",
        r"D:\MusicDatasets\raw_stems",
    ):
        if not os.path.isdir(root):
            continue
        for name in os.listdir(root):
            path = os.path.join(root, name)
            if os.path.isdir(path) and not name.startswith("."):
                known.add(slugify(name))
                known.add(name)
    return known


def resolve_raw_root(raw_dir: str) -> str:
    if os.path.isdir(raw_dir):
        return raw_dir
    if os.path.isdir(DEFAULT_DSD100):
        print(
            f"[INFO] {raw_dir} is missing. Using DSD100 master root: {DEFAULT_DSD100}"
        )
        print("       (originals stay in place; this slicer never deletes or moves them)")
        return DEFAULT_DSD100
    print(f"[WARN] Neither {raw_dir} nor {DEFAULT_DSD100} exists.")
    return raw_dir


def _lock_path(corpus_dir: str) -> str:
    return os.path.join(corpus_dir, LOCK_NAME)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _read_lock_pid(lock_path: str) -> int | None:
    try:
        with open(lock_path, "r", encoding="utf-8") as handle:
            return int(handle.read().strip().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def other_corpus_writer_active(corpus_dir: str) -> str | None:
    """Return a reason string if another process is already filling corpus_4s."""
    lock_path = _lock_path(corpus_dir)
    if os.path.isfile(lock_path):
        pid = _read_lock_pid(lock_path)
        if pid is not None and pid != os.getpid() and _pid_alive(pid):
            return f"lock {lock_path} held by PID {pid}"

    needles = ("resilient_corpus_slicer", "corpus_4s")
    try:
        import subprocess

        cmd = (
            "Get-CimInstance Win32_Process | "
            "Where-Object { $_.CommandLine -and "
            "($_.CommandLine -match 'resilient_corpus_slicer' "
            "-or ($_.CommandLine -match 'corpus_4s' "
            "-and $_.CommandLine -match 'python')) } | "
            "Select-Object ProcessId, CommandLine"
        )
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", cmd],
            capture_output=True,
            text=True,
            timeout=15,
        )
        me = str(os.getpid())
        for line in (result.stdout or "").splitlines():
            if me in line:
                continue
            if any(n in line for n in needles) and "python" in line.lower():
                return f"existing process: {line.strip()[:200]}"
    except Exception:
        pass

    newest = None
    newest_mtime = 0.0
    if os.path.isdir(corpus_dir):
        for root, dirs, files in os.walk(corpus_dir):
            dirs[:] = [d for d in dirs if d not in {".index", ".git"}]
            for name in files:
                if not name.lower().endswith(".wav"):
                    continue
                path = os.path.join(root, name)
                try:
                    mtime = os.path.getmtime(path)
                except OSError:
                    continue
                if mtime > newest_mtime:
                    newest_mtime = mtime
                    newest = path
    if newest and (time.time() - newest_mtime) < 8.0:
        return f"recent write {newest} ({time.time() - newest_mtime:.1f}s ago)"
    return None


def acquire_slicer_lock(corpus_dir: str) -> bool:
    os.makedirs(corpus_dir, exist_ok=True)
    lock_path = _lock_path(corpus_dir)
    if os.path.isfile(lock_path):
        pid = _read_lock_pid(lock_path)
        if pid is not None and pid != os.getpid() and _pid_alive(pid):
            return False
    with open(lock_path, "w", encoding="utf-8") as handle:
        handle.write(f"{os.getpid()}\n")
    return True


def release_slicer_lock(corpus_dir: str) -> None:
    lock_path = _lock_path(corpus_dir)
    pid = _read_lock_pid(lock_path)
    if pid is None or pid == os.getpid():
        try:
            os.remove(lock_path)
        except OSError:
            pass


def slice_file_4s(
    input_path: str,
    output_dir: str,
    slice_dur: float = 4.0,
    sr_target: int = 44100,
) -> int:
    """Cut fixed-length slices. sr_target is accepted for compatibility; writes keep source rate."""
    _ = sr_target
    try:
        data, sr = sf.read(input_path, always_2d=True)
    except Exception as e:
        print(f"  [SKIP] Unreadable file {os.path.basename(input_path)}: {e}")
        return 0

    samples_per_slice = int(slice_dur * sr)
    total_samples = data.shape[0]
    num_slices = total_samples // samples_per_slice
    if num_slices == 0:
        return 0

    os.makedirs(output_dir, exist_ok=True)
    base_name = unique_base_name(input_path)
    saved_count = 0
    for i in range(num_slices):
        start = i * samples_per_slice
        end = start + samples_per_slice
        chunk = data[start:end, :]
        # Skip slices that are pure digital silence
        rms = np.sqrt(np.mean(chunk**2) + 1e-12)
        if 20 * np.log10(rms) < SILENCE_FLOOR_DBFS:
            continue
        out_name = f"{base_name}_slice_{i:04d}.wav"
        out_path = os.path.join(output_dir, out_name)
        if not os.path.exists(out_path):
            sf.write(out_path, chunk, sr, subtype="PCM_24")
            saved_count += 1
    return saved_count


def run_resilient_batch(
    raw_dir: str,
    corpus_dir: str,
    slice_dur: float = 4.0,
    limit: int = 0,
    force: bool = False,
) -> int:
    raw_dir = resolve_raw_root(raw_dir)
    if not os.path.isdir(raw_dir):
        print(f"[ERROR] Raw input directory does not exist: {raw_dir}")
        return 0

    reason = other_corpus_writer_active(corpus_dir)
    if reason and not force:
        print(f"[ABORT] Another process is already filling {corpus_dir}: {reason}")
        print("        Not starting a second full-disk slice walk.")
        return 0

    if not acquire_slicer_lock(corpus_dir):
        print(f"[ABORT] Could not acquire slicer lock under {corpus_dir}.")
        return 0

    prevent_sleep()
    total_slices_saved = 0
    try:
        os.makedirs(corpus_dir, exist_ok=True)
        files = sorted(glob.glob(os.path.join(raw_dir, "**", "*.wav"), recursive=True))
        files = [f for f in files if os.path.isfile(f)]
        if limit and limit > 0:
            files = files[:limit]
        total = len(files)
        print(f"[*] Slicing Queue: {total} files found. Windows sleep lock active.")
        print(f"    raw={raw_dir}")
        print(f"    corpus={corpus_dir}  slice_dur={slice_dur}s")
        print("    originals are never deleted or moved")

        known_genres = discover_known_genres()
        for idx, f in enumerate(files, 1):
            genre = infer_genre(f, raw_dir, known_genres)
            out_dir = os.path.join(corpus_dir, genre) if genre else corpus_dir
            count = slice_file_4s(f, out_dir, slice_dur=slice_dur)
            total_slices_saved += count
            if idx % 10 == 0 or idx == total:
                print(f"[{idx}/{total}] Processed. Total 4.0s slices created: {total_slices_saved}")
    finally:
        allow_sleep()
        release_slicer_lock(corpus_dir)

    print(f"[COMPLETE] Batch finished. Generated {total_slices_saved} slices in {corpus_dir}")
    return total_slices_saved


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Sleep-proof 4.0s WAV slicer with resume-safe writes."
    )
    parser.add_argument("--raw", default=DEFAULT_RAW, help=f"Source root (default {DEFAULT_RAW})")
    parser.add_argument("--corpus", default=DEFAULT_CORPUS, help=f"Output root (default {DEFAULT_CORPUS})")
    parser.add_argument("--slice-dur", type=float, default=4.0, help="Slice length in seconds (default 4.0)")
    parser.add_argument("--limit", type=int, default=0, help="Process at most N source files (0 = all)")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Start even if another writer looks active (still never deletes originals)",
    )
    return parser


if __name__ == "__main__":
    args = build_parser().parse_args()
    RAW_INPUT = args.raw
    CORPUS_OUTPUT = args.corpus
    run_resilient_batch(
        RAW_INPUT,
        CORPUS_OUTPUT,
        slice_dur=args.slice_dur,
        limit=args.limit,
        force=args.force,
    )
