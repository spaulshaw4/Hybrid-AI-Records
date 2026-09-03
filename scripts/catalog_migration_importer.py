"""Register existing master WAVs onto the workstation ledger.

Default is ``--register-only``: each accepted file becomes a QUEUED row
via ``queue_master_session.write_local_ledger`` (cloud off). That is what
``master_queue_worker`` consumes. Do not loop every WAV into
``run_master_pipeline.ps1`` — that saturates the workstation.

``--run-pipeline`` is explicit and capped by ``--limit`` (default 1).

Slice libraries (``uploaded_slices``, ``corpus_4s``, short 1s/4s dumps)
are refused unless ``--i-know-this-is-masters``.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from queue_master_session import write_local_ledger  # noqa: E402
from stem_preflight import TARGET_SR  # noqa: E402

AUDIO_EXT = {".wav", ".wave", ".flac"}
SLICE_DIR_MARKERS = ("uploaded_slices", "corpus_4s")
SKIP_DIR_NAMES = {"uploaded_slices", "corpus_4s", "uploads", "_processed", "_failed", "archive"}
SLICE_DURATION_MAX = 4.6
SLICE_FILE_HINT = 80
MASTER_MIN_SECONDS = 10.0
DEFAULT_DB = os.environ.get("MASTER_CATALOG_DB", r"D:\MusicDatasets\database\master_catalog.db")
BASE_DIR = os.environ.get("MUSICDATASETS_ROOT", r"D:\MusicDatasets")
POWERSHELL = os.environ.get(
    "HYBRID_POWERSHELL",
    r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
)
PIPELINE = os.path.join(BASE_DIR, "scripts", "run_master_pipeline.ps1")
if not os.path.isfile(PIPELINE):
    PIPELINE = os.path.join(SCRIPTS_DIR, "run_master_pipeline.ps1")

def path_is_slice_tree(root: str) -> bool:
    norm = os.path.normpath(root).replace("\\", "/").lower()
    return any(norm == marker or norm.endswith("/" + marker) or f"/{marker}/" in f"/{norm}/" for marker in SLICE_DIR_MARKERS)


def session_id_for(path: str) -> str:
    digest = hashlib.sha1(os.path.abspath(path).encode("utf-8")).hexdigest()[:10]
    stem = re.sub(r"[^A-Za-z0-9]+", "_", os.path.splitext(os.path.basename(path))[0]).strip("_")
    stem = (stem or "master")[:40]
    return f"import_{stem}_{digest}"


def probe_audio(path: str) -> tuple[int, int, float] | str:
    """Return (samplerate, channels, duration) or an error string."""
    try:
        import soundfile as sf
    except ImportError:
        return "soundfile is not installed"
    try:
        info = sf.info(path)
    except Exception as exc:
        return f"unreadable: {exc}"
    if info.samplerate <= 0 or info.frames < 0:
        return "invalid sample rate or frames"
    duration = float(info.frames) / float(info.samplerate) if info.samplerate else 0.0
    channels = int(info.channels or 0)
    if channels < 1:
        return "no channels"
    return int(info.samplerate), channels, duration


def looks_like_slice_dump(probes: list[tuple[str, int, int, float]]) -> bool:
    if len(probes) >= SLICE_FILE_HINT:
        durations = sorted(item[3] for item in probes)
        mid = durations[len(durations) // 2]
        if mid <= SLICE_DURATION_MAX:
            return True
    short = sum(1 for item in probes if item[3] <= SLICE_DURATION_MAX)
    return len(probes) >= 12 and short / max(1, len(probes)) >= 0.8


def walk_masters(source: str, allow_slice_tree: bool) -> list[str]:
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(source):
        if not allow_slice_tree:
            dirnames[:] = [name for name in dirnames if name.lower() not in SKIP_DIR_NAMES]
        for name in filenames:
            if os.path.splitext(name)[1].lower() in AUDIO_EXT:
                found.append(os.path.join(dirpath, name))
    found.sort()
    return found


def quarantine(path: str, dest_dir: str, reason: str) -> None:
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, os.path.basename(path))
    if os.path.exists(dest):
        stem, ext = os.path.splitext(os.path.basename(path))
        dest = os.path.join(dest_dir, f"{stem}_{hashlib.sha1(path.encode()).hexdigest()[:8]}{ext}")
    try:
        shutil.move(path, dest)
        print(f"[QUARANTINE] {path} -> {dest} ({reason})")
    except OSError as exc:
        print(f"[SKIP] could not quarantine {path}: {exc}", file=sys.stderr)


def dispatch_pipeline(session_id: str, genre: str) -> int:
    if not os.path.isfile(PIPELINE):
        print(f"[ERROR] Missing orchestrator: {PIPELINE}", file=sys.stderr)
        return 2
    cmd = [
        POWERSHELL,
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        PIPELINE,
        "-SessionId",
        session_id,
        "-GenreLock",
        genre,
    ]
    print(f"[PIPELINE] {session_id} (explicit --run-pipeline, limited)")
    return int(subprocess.run(cmd, check=False).returncode)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Queue existing master WAVs. Default register-only; never walks slice dumps."
    )
    parser.add_argument("--source", required=True, help="Folder of finished masters (not uploaded_slices / corpus_4s)")
    parser.add_argument("--genre", default="dark_techno")
    parser.add_argument("--user-id", default="00000000-0000-0000-0000-000000000001")
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--register-only", action="store_true", default=True, help="Queue QUEUED rows (default)")
    parser.add_argument("--run-pipeline", action="store_true", help="Also run run_master_pipeline.ps1 (capped by --limit)")
    parser.add_argument("--limit", type=int, default=1, help="Max files to send through --run-pipeline (default 1)")
    parser.add_argument("--quarantine-dir", default=os.path.join(BASE_DIR, "incoming_stems", "_failed", "catalog_import"))
    parser.add_argument("--i-know-this-is-masters", action="store_true")
    parser.add_argument("--move-quarantine", action="store_true", help="Move bad files into --quarantine-dir")
    args = parser.parse_args()

    source = os.path.abspath(args.source)
    if not os.path.isdir(source):
        print(f"[ERROR] Source is not a directory: {source}", file=sys.stderr)
        return 2
    if path_is_slice_tree(source) and not args.i_know_this_is_masters:
        print(
            f"[REFUSE] {source} looks like a slice library (uploaded_slices / corpus_4s). "
            "Pass --i-know-this-is-masters if these are really finished masters.",
            file=sys.stderr,
        )
        return 3

    paths = walk_masters(source, allow_slice_tree=args.i_know_this_is_masters)
    if not paths:
        print("[INFO] No WAV/FLAC files found.")
        return 0

    probes: list[tuple[str, int, int, float]] = []
    rejected = 0
    for path in paths:
        probed = probe_audio(path)
        if isinstance(probed, str):
            print(f"[SKIP] {path}: {probed}")
            if args.move_quarantine:
                quarantine(path, args.quarantine_dir, probed)
            rejected += 1
            continue
        sr, channels, duration = probed
        if sr not in (TARGET_SR, 48000, 88200, 96000):
            reason = f"unsupported sample rate {sr}"
            print(f"[SKIP] {path}: {reason}")
            if args.move_quarantine:
                quarantine(path, args.quarantine_dir, reason)
            rejected += 1
            continue
        if duration < MASTER_MIN_SECONDS and not args.i_know_this_is_masters:
            reason = f"too short for a master ({duration:.2f}s)"
            print(f"[SKIP] {path}: {reason}")
            if args.move_quarantine:
                quarantine(path, args.quarantine_dir, reason)
            rejected += 1
            continue
        probes.append((path, sr, channels, duration))

    if looks_like_slice_dump(probes) and not args.i_know_this_is_masters:
        print(
            f"[REFUSE] {len(probes)} files look like a 1s/4s slice dump (median duration short). "
            "Refusing unless --i-know-this-is-masters.",
            file=sys.stderr,
        )
        return 3

    queued = 0
    ran = 0
    pipeline_budget = max(0, int(args.limit)) if args.run_pipeline else 0
    for path, sr, _channels, duration in probes:
        session_id = session_id_for(path)
        write_local_ledger(args.db, session_id, args.genre, "QUEUED", 4.0)
        queued += 1
        print(f"[QUEUED] {session_id} sr={sr} dur={duration:.1f}s {path}")
        if args.run_pipeline and ran < pipeline_budget:
            code = dispatch_pipeline(session_id, args.genre)
            ran += 1
            if code != 0:
                print(f"[PIPELINE FAIL] {session_id} exit={code}", file=sys.stderr)

    print(
        f"[DONE] queued={queued} skipped={rejected} pipeline_runs={ran} "
        f"mode={'run-pipeline' if args.run_pipeline else 'register-only'}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
