"""Sanitize incoming stems and stage per-file 4.0s slices.

Watches both drop paths the repo actually uses:

  D:\\MusicDatasets\\incoming           legacy watchdog / local_slicer genre drop
  D:\\MusicDatasets\\scratch\\uploads   stem-upload.server.ts (STEM_UPLOAD_DIR)

Does NOT run local_slicer.py (1000 ms + archive). Does NOT invoke
batch_reslice_corpus.py on a raw/DSD100 root — that CLI also walks DSD100.
After stem_preflight succeeds, a single file is cut with
resilient_corpus_slicer.slice_file_4s (4.0 s). Full-corpus reslice remains
an operator step.

Python resolution matches master_queue_worker / Get-HybridPython:
HYBRID_PYTHON, then sys.executable, then known Python312 paths.
Never D:\\MusicDatasets\\venv.

Incoming files are moved to incoming_stems/_processed on success or
incoming_stems/_failed on sanitize failure. The original is never deleted
until a readable sanitized WAV exists.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import time

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

BASE_DIR = os.environ.get("MUSICDATASETS_ROOT", r"D:\MusicDatasets")
INCOMING_DIR = os.environ.get("HYBRID_INCOMING_DIR", os.path.join(BASE_DIR, "incoming"))
UPLOAD_DIR = os.environ.get(
    "STEM_UPLOAD_DIR",
    os.path.join(BASE_DIR, "scratch", "uploads"),
)
STAGING_ROOT = os.environ.get("HYBRID_INCOMING_STEMS", os.path.join(BASE_DIR, "incoming_stems"))
PROCESSED_DIR = os.path.join(STAGING_ROOT, "_processed")
FAILED_DIR = os.path.join(STAGING_ROOT, "_failed")
CORPUS_DIR = os.environ.get("HYBRID_CORPUS_4S", os.path.join(BASE_DIR, "corpus_4s"))
DEFAULT_GENRE = os.environ.get("HYBRID_DEFAULT_INGEST_GENRE", "heavy_alternative_rock")
INTERVAL_SEC = float(os.environ.get("HYBRID_CORPUS_SYNC_INTERVAL", "30"))
STABLE_AGE_SEC = 2.0
AUDIO_EXT = {".wav", ".flac", ".aiff", ".aif", ".ogg"}
SKIP_DIR_NAMES = {"_processed", "_failed", "_staging", "archive"}

_KNOWN_VENV = os.path.normcase(os.path.join(BASE_DIR, "venv"))


def resolve_python() -> str:
    """Same idea as Get-HybridPython / workstation-python.server.ts. No venv path."""
    env = (os.environ.get("HYBRID_PYTHON") or "").strip()
    local = os.environ.get("LOCALAPPDATA") or ""
    candidates = [
        env,
        sys.executable,
        os.path.join(local, "Programs", "Python", "Python312", "python.exe") if local else "",
        r"C:\Program Files\Python312\python.exe",
        r"C:\Program Files\Python311\python.exe",
    ]
    for path in candidates:
        if not path:
            continue
        normalized = os.path.normcase(os.path.abspath(path))
        if "windowsapps" in normalized or normalized.startswith(_KNOWN_VENV):
            continue
        if os.path.isfile(path):
            return path
    return sys.executable


def _safe_import_preflight():
    from stem_preflight import sanitize_stem  # noqa: WPS433

    return sanitize_stem


def _safe_import_slicer():
    from resilient_corpus_slicer import slice_file_4s  # noqa: WPS433

    return slice_file_4s


def infer_genre(path: str, watch_roots: list[str]) -> str:
    parent = os.path.basename(os.path.dirname(os.path.abspath(path)))
    lowered = parent.lower().replace("-", "_").replace(" ", "_")
    if not parent or parent.startswith("_"):
        return DEFAULT_GENRE
    watch_basenames = {os.path.basename(os.path.normpath(root)).lower() for root in watch_roots}
    if lowered in watch_basenames or lowered in {"uploads", "incoming", "scratch"}:
        return DEFAULT_GENRE
    if lowered.startswith("upload_"):
        return DEFAULT_GENRE
    return lowered


def watch_roots() -> list[str]:
    return [INCOMING_DIR, UPLOAD_DIR]


def iter_audio_files(roots: list[str]) -> list[str]:
    found: list[str] = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [name for name in dirnames if name not in SKIP_DIR_NAMES and not name.startswith(".")]
            rel = os.path.normpath(os.path.relpath(dirpath, root))
            parts = set(rel.split(os.sep)) if rel != "." else set()
            if parts & SKIP_DIR_NAMES:
                continue
            for name in filenames:
                ext = os.path.splitext(name)[1].lower()
                if ext not in AUDIO_EXT:
                    continue
                found.append(os.path.join(dirpath, name))
    found.sort()
    return found


def file_is_stable(path: str, prev_sizes: dict[str, int]) -> bool:
    try:
        stat = os.stat(path)
    except OSError:
        return False
    age = time.time() - stat.st_mtime
    size = int(stat.st_size)
    previous = prev_sizes.get(path)
    prev_sizes[path] = size
    if size < 44:
        return False
    if age >= STABLE_AGE_SEC:
        return True
    return previous is not None and previous == size


def unique_dest(folder: str, filename: str) -> str:
    os.makedirs(folder, exist_ok=True)
    dest = os.path.join(folder, filename)
    if not os.path.exists(dest):
        return dest
    stem, ext = os.path.splitext(filename)
    stamp = int(time.time())
    return os.path.join(folder, f"{stem}_{stamp}{ext}")


def move_aside(src: str, dest_dir: str) -> str | None:
    try:
        dest = unique_dest(dest_dir, os.path.basename(src))
        shutil.move(src, dest)
        return dest
    except OSError as exc:
        print(f"[CORPUS SYNC] move failed {src} -> {dest_dir}: {exc}", file=sys.stderr)
        return None


def sanitized_is_readable(path: str) -> bool:
    if not os.path.isfile(path) or os.path.getsize(path) < 44:
        return False
    try:
        import soundfile as sf

        info = sf.info(path)
        return info.frames > 0 and info.samplerate > 0
    except Exception:
        return False


def process_file(path: str, roots: list[str]) -> str:
    genre = infer_genre(path, roots)
    sanitized_dir = os.path.join(STAGING_ROOT, genre)
    os.makedirs(sanitized_dir, exist_ok=True)
    sanitized = unique_dest(sanitized_dir, os.path.splitext(os.path.basename(path))[0] + ".wav")

    try:
        sanitize_stem = _safe_import_preflight()
        sanitize_stem(path, sanitized)
    except Exception as exc:
        print(f"[PREFLIGHT ERROR] {path}: {exc}", file=sys.stderr)
        quarantined = move_aside(path, FAILED_DIR)
        print(f"[QUARANTINE] original kept at {quarantined or path}")
        return "failed"

    if not sanitized_is_readable(sanitized):
        print(f"[PREFLIGHT ERROR] sanitized output missing or unreadable: {sanitized}", file=sys.stderr)
        if os.path.isfile(sanitized):
            try:
                os.remove(sanitized)
            except OSError:
                pass
        quarantined = move_aside(path, FAILED_DIR)
        print(f"[QUARANTINE] original kept at {quarantined or path}")
        return "failed"

    try:
        slice_file_4s = _safe_import_slicer()
        out_dir = os.path.join(CORPUS_DIR, genre)
        made = slice_file_4s(sanitized, out_dir, slice_dur=4.0)
        if made:
            print(f"[SLICED] {made} x 4.0s -> {out_dir}")
        else:
            print(
                f"[STAGED] {sanitized} is shorter than 4.0s or silent; "
                "full corpus reslice remains a separate operator step "
                "(resilient_corpus_slicer.py / batch_reslice_corpus.py)."
            )
    except Exception as exc:
        print(f"[SLICE WARN] sanitized file kept, slice skipped: {exc}", file=sys.stderr)

    processed = move_aside(path, PROCESSED_DIR)
    print(f"[PROCESSED] original -> {processed or PROCESSED_DIR}")
    return "ok"


def run_once(prev_sizes: dict[str, int] | None = None) -> int:
    roots = watch_roots()
    missing = [root for root in roots if not os.path.isdir(root)]
    if missing:
        print(f"[CORPUS SYNC] watch dirs missing (skip): {', '.join(missing)}")
    if all(not os.path.isdir(root) for root in roots):
        print("[CORPUS SYNC] no ingest roots present; no-op")
        return 0

    sizes = prev_sizes if prev_sizes is not None else {}
    handled = 0
    for path in iter_audio_files(roots):
        if not file_is_stable(path, sizes):
            print(f"[SKIP] still writing: {path}")
            continue
        print(f"[INGEST] {path}")
        process_file(path, roots)
        handled += 1
        sizes.pop(path, None)
    if handled == 0:
        print("[CORPUS SYNC] idle - no stable audio in incoming or scratch/uploads")
    return handled


def main() -> int:
    parser = argparse.ArgumentParser(description="Incoming stem sanitize + per-file 4.0s stage")
    parser.add_argument("--once", action="store_true", help="Single scan then exit")
    args = parser.parse_args()

    python = resolve_python()
    print("[*] Corpus sync daemon")
    print(f"    python     {python}")
    print(f"    incoming   {INCOMING_DIR}")
    print(f"    uploads    {UPLOAD_DIR}  (stem-upload.server.ts)")
    print(f"    staging    {STAGING_ROOT}")
    print("    slicer     resilient_corpus_slicer.slice_file_4s (per file, 4.0s)")
    print("    not used   local_slicer.py, batch_reslice_corpus.py (whole-tree)")

    if args.once:
        run_once()
        return 0

    os.makedirs(STAGING_ROOT, exist_ok=True)
    os.makedirs(PROCESSED_DIR, exist_ok=True)
    os.makedirs(FAILED_DIR, exist_ok=True)
    sizes: dict[str, int] = {}
    while True:
        run_once(sizes)
        time.sleep(INTERVAL_SEC)


if __name__ == "__main__":
    sys.exit(main())
