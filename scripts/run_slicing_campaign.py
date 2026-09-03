"""Resumable bulk slicing campaign: raw library on D: -> ``corpus_4s``.

Discovers raw source trees under ``D:\\MusicDatasets``, records every source
file in the ledger (``scripts.slicing_campaign_ledger``), then slices whatever
is still PENDING. Re-running skips DONE and SKIPPED rows, so a crash, a reboot
or a Ctrl-C costs at most the files that were in flight.

The cuts themselves come from ``engine.smart_transient_slicer.slice_one_source``,
which delegates to ``dsp.smart_transient_slicer`` (RMS trough +/-250 ms, zero
crossing +/-15 ms, 3.2-4.8 s, -50 dBFS floor) and routes into
``corpus_4s/{rhythm,harmonic,lead,vocal}``. No second slicing algorithm exists
here.

Dry-run is the default. ``--execute`` is required to write audio. One-shots
(duration < ~1.5 s, Kick/Snare/Hats/Perc) are copied into
``D:\\MusicDatasets\\oneshots`` — sources are never deleted and never 4s-sliced.
Incoming zips: one reserved worker extracts ``incoming_zips`` into
``raw_packs`` (never ``fma_full.zip``, never D:\\ root). The rest of the pool
slices. Dry-run still lists the inbox only.
"""
from __future__ import annotations

import argparse
import hashlib
import logging
import multiprocessing as mp
import os
import random
import re
import shutil
import sys
import time
from typing import Any, Iterable

import numpy as np
import soundfile as sf

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from dsp.smart_transient_slicer import (  # noqa: E402
    MAX_DUR,
    MIN_DUR,
    NOMINAL_DUR,
    slugify,
    unique_base_name,
)
from engine.smart_transient_slicer import (  # noqa: E402
    DEFAULT_TARGET_SR,
    DriveRootError,
    layer_output_dir,
    slice_one_source,
)

try:  # scripts/ is deployed flat to D:\MusicDatasets\scripts
    from scripts import slicing_campaign_ledger as ledger
except ImportError:  # pragma: no cover - exercised only on the flat deploy
    import slicing_campaign_ledger as ledger  # type: ignore[no-redef]

DEFAULT_ROOT = r"D:\MusicDatasets"
DEFAULT_OUTPUT = r"D:\MusicDatasets\corpus_4s"
DEFAULT_ONESHOTS = r"D:\MusicDatasets\oneshots"
DEFAULT_INCOMING_ZIPS = r"D:\MusicDatasets\incoming_zips"
DEFAULT_RAW_PACKS = r"D:\MusicDatasets\raw_packs"
DEFAULT_LOG_DIR = r"D:\MusicDatasets\logs"
DEFAULT_DB = ledger.DEFAULT_DB
DEFAULT_CAMPAIGN = ledger.DEFAULT_CAMPAIGN
# Hits shorter than this are one-shots: copy to the oneshots library, never 4s-slice.
ONESHOT_MAX_DUR = 1.5
REFUSED_ZIP_PREFIXES = ("fma_full",)

# libsndfile 1.2.2 reads all of these directly, MP3 included, so no ffmpeg
# transcode step is needed. Anything outside this set is left untouched.
AUDIO_EXTENSIONS = frozenset(
    {".wav", ".wave", ".mp3", ".flac", ".ogg", ".oga", ".aif", ".aiff", ".aifc", ".w64"}
)

# Never slice these trees: live 1.0s library, already-sliced output, code,
# state, and packaging areas.
DENY_DIR_NAMES = frozenset(
    {
        "uploaded_slices",
        "uploaded_slice",
        "corpus_4s",
        "scratch",
        "renders",
        "releases",
        "archive",
        "logs",
        "database",
        "db",
        "dsp",
        "engine",
        "scripts",
        "api",
        "monitoring",
        "config",
        ".git",
        "node_modules",
        "server",
        "src",
        "tests",
        "models",
        "venv",
        ".venv",
        "__pycache__",
        "distribution_exports",
        "job_payloads",
        "oneshots",
        # Zipped material only. Default is skip unzip; DryRun may list
        # incoming_zips. fma_full.zip is never extracted.
        "incoming_zips",
        # Inbound downloads (Freesound CC0, etc). Slice later with -Root on
        # that folder; do not walk it during a live MusicDatasets campaign.
        "raw",
    }
)

# Directory names that usually hold sub-second one-shots rather than phrases.
ONESHOT_DIR_HINTS = (
    "kick",
    "snare",
    "hat",
    "hihat",
    "perc",
    "clap",
    "tom",
    "cymbal",
    "808",
    "one shot",
    "one_shot",
    "oneshot",
    "accents & fx",
    "accents and fx",
    "fx",
)

# Category folders under D:\MusicDatasets\oneshots. First match wins.
ONESHOT_CATEGORIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("kick", ("kick", "808")),
    ("snare", ("snare", "clap")),
    ("hat", ("hat", "hihat", "hi-hat", "hats")),
    ("perc", ("perc", "tom", "cymbal")),
    ("fx", ("fx", "accent")),
)

_ALREADY_SLICED_RE = re.compile(r"(_phrase_|_slice_)", re.I)

# Worker budget. The box has 8 logical CPUs. Auto/idle uses all 8; drop to 2
# only while the corpus indexer is running (unless --allow-contention).
WORKERS_WITH_INDEXER = 2
WORKERS_IDLE = 8
UNZIP_RESERVE = 1
UNZIP_POLL_SEC = 30.0
INDEXER_MARKER = "index_578gb_corpus"

SAMPLE_PROBE_FILES = 24
ONESHOT_SAMPLE_RATIO = 0.6
PCM24_BYTES_PER_SAMPLE = 3
FREE_SPACE_MARGIN = 1.15
DEFAULT_STALE_SEC = 900.0

LOG = logging.getLogger("slicing_campaign")


# --------------------------------------------------------------------------
# Environment and concurrency
# --------------------------------------------------------------------------
def indexer_worker_count(marker: str = INDEXER_MARKER) -> int:
    """Count live corpus-index processes, including their Pool children.

    Returns 0 when psutil is unavailable; the caller then falls back to the
    conservative default rather than assuming the box is idle.
    """
    try:
        import psutil
    except Exception:
        return 0

    parents: set[int] = set()
    children = 0
    for proc in psutil.process_iter(["pid", "ppid", "cmdline"]):
        try:
            cmdline = " ".join(proc.info.get("cmdline") or [])
        except Exception:
            continue
        if marker in cmdline:
            parents.add(int(proc.info["pid"]))
    if not parents:
        return 0
    for proc in psutil.process_iter(["pid", "ppid"]):
        try:
            if int(proc.info.get("ppid") or -1) in parents:
                children += 1
        except Exception:
            continue
    return len(parents) + children


def resolve_campaign_workers(
    requested: int | None,
    *,
    cpu_count: int,
    indexer_running: bool,
    allow_contention: bool = False,
) -> int:
    """Pick a worker count that never exceeds ``cpu_count``.

    Idle default is ``WORKERS_IDLE`` (8 on this box). While the indexer is
    running the ceiling drops to ``WORKERS_WITH_INDEXER``; ``--allow-contention``
    raises it back to ``WORKERS_IDLE``. An explicit ``--workers`` is still
    clamped to that ceiling.
    """
    cpus = max(1, int(cpu_count))
    if indexer_running and not allow_contention:
        ceiling = min(cpus, WORKERS_WITH_INDEXER)
    else:
        ceiling = min(cpus, WORKERS_IDLE)
    want = int(requested) if requested else ceiling
    return max(1, min(want, ceiling))


def split_slice_and_unzip_workers(total: int) -> tuple[int, int]:
    """Reserve one worker for unzip when the pool is large enough.

    Indexer-capped runs (2 workers) stay all-slice. Never leave zero slicers.
    """
    pool = max(1, int(total))
    if pool <= 2:
        return pool, 0
    unzip = min(UNZIP_RESERVE, pool - 1)
    return pool - unzip, unzip


def run_unzip_inbox(
    incoming: str,
    raw_packs: str,
    db_path: str,
    stop_event: Any,
    poll_sec: float = UNZIP_POLL_SEC,
) -> None:
    """Single-process unzip of ``incoming_zips`` into ``raw_packs``.

    Uses ``db.pack_tracker.process_incoming_zips`` (skips ``fma_full.zip``,
    never extracts D:\\ root, never writes into corpus_4s / uploaded_slices).
    """
    repo = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    if repo not in sys.path:
        sys.path.insert(0, repo)
    from db.pack_tracker import process_incoming_zips

    log = logging.getLogger("slicing_campaign.unzip")
    if not log.handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    while True:
        if stop_event.is_set():
            return
        try:
            summary = process_incoming_zips(
                incoming,
                raw_packs,
                db_path,
                dry_run=False,
                also_scan_root=False,
            )
            extracted = len(summary.get("extracted") or [])
            failed = len(summary.get("failed") or [])
            if extracted or failed:
                log.info(
                    "[UNZIP] extracted=%d failed=%d inbox=%s",
                    extracted,
                    failed,
                    incoming,
                )
        except Exception as exc:
            log.warning("[UNZIP] pass failed: %s", exc)
        if stop_event.wait(float(poll_sec)):
            return


def wait_for_indexer(poll_sec: float = 60.0, timeout_sec: float = 0.0) -> bool:
    """Block until no indexer process remains. Returns True when it cleared."""
    started = time.time()
    while indexer_worker_count() > 0:
        if timeout_sec and (time.time() - started) > timeout_sec:
            return False
        LOG.info("Corpus indexer still running; waiting %.0fs", poll_sec)
        time.sleep(poll_sec)
    return True


def free_bytes(path: str) -> int:
    try:
        return int(shutil.disk_usage(path).free)
    except Exception:
        return 0


# --------------------------------------------------------------------------
# Discovery
# --------------------------------------------------------------------------
def is_denied_dir(name: str) -> bool:
    return name.strip().lower() in DENY_DIR_NAMES


def looks_already_sliced(name: str) -> bool:
    return bool(_ALREADY_SLICED_RE.search(name))


def assert_not_bare_drive(path: str) -> None:
    """Refuse ``D:\\`` as a walk root. ``D:\\MusicDatasets`` is allowed for discovery."""
    norm = os.path.normpath(os.path.abspath(path))
    _drive, tail = os.path.splitdrive(norm)
    if tail in ("", os.sep):
        raise DriveRootError(
            f"Refusing to use {path} as the campaign root. "
            "Pass D:\\MusicDatasets to discover its children, or one source tree. Never D:\\."
        )


def assert_allowed_campaign_root(path: str) -> None:
    """Discovery root may be the workstation, but never a denied tree or a bare drive."""
    assert_not_bare_drive(path)
    base = os.path.basename(os.path.normpath(path.rstrip("\\/")))
    if is_denied_dir(base):
        raise ValueError(
            f"Refusing to use {path} as the campaign root (denied tree). "
            "Never slice uploaded_slices, corpus_4s, scratch, or renders."
        )


def refused_zip_name(name: str) -> bool:
    lowered = os.path.basename(name).lower()
    return any(lowered.startswith(prefix) for prefix in REFUSED_ZIP_PREFIXES)


def list_incoming_zips(incoming_dir: str = DEFAULT_INCOMING_ZIPS) -> dict[str, Any]:
    """Dry-run listing of ``incoming_zips``. Never extracts. Never opens fma_full.zip."""
    census: dict[str, Any] = {
        "dir": incoming_dir,
        "zips": [],
        "refused": [],
        "extracted": 0,
        "note": "",
    }
    if not os.path.isdir(incoming_dir):
        census["note"] = f"{incoming_dir} is missing — nothing to list"
        return census
    for name in sorted(os.listdir(incoming_dir)):
        if not name.lower().endswith(".zip"):
            continue
        full = os.path.join(incoming_dir, name)
        if not os.path.isfile(full):
            continue
        try:
            size = os.path.getsize(full)
        except OSError:
            continue
        rec = {"name": name, "path": os.path.normpath(full), "bytes": int(size)}
        if refused_zip_name(name):
            rec["reason"] = "dataset archive (never extract fma_full.zip)"
            census["refused"].append(rec)
        else:
            census["zips"].append(rec)
    if not census["zips"] and not census["refused"]:
        census["note"] = "incoming_zips is empty — copy new zips here; default is skip unzip"
    return census


def print_zip_listing(census: dict[str, Any]) -> None:
    print("\n=== INCOMING ZIPS (listing only — nothing is extracted) ===")
    print(f"dir: {census['dir']}")
    if census.get("note"):
        print(f"  {census['note']}")
    for rec in census["zips"]:
        print(f"  [NEW]     {rec['name']:<40} {ledger.format_bytes(rec['bytes'])}")
    for rec in census["refused"]:
        print(f"  [REFUSED] {rec['name']:<40} {rec.get('reason', '')}")
    print(
        "Default is skip unzip. fma_full.zip is never extracted. "
        "Copy new LANDR zips into incoming_zips; do not unzip D:\\."
    )


def oneshot_category(path: str) -> str:
    blob = path.lower().replace("\\", "/").replace("_", " ").replace("-", " ")
    for category, hints in ONESHOT_CATEGORIES:
        if any(hint in blob for hint in hints):
            return category
    return "other"


def oneshot_dest_path(oneshot_root: str, source_path: str, category: str) -> str:
    """Stable destination under the oneshots library. Never the source path."""
    ext = os.path.splitext(source_path)[1].lower() or ".wav"
    parent = os.path.basename(os.path.dirname(source_path))
    base = unique_base_name(source_path)
    name = f"{slugify(parent)}__{base}{ext}"
    dest = os.path.join(oneshot_root, category, name)
    src_key = os.path.normcase(os.path.abspath(source_path))
    if os.path.isfile(dest) and os.path.normcase(os.path.abspath(dest)) != src_key:
        digest = hashlib.md5(src_key.encode("utf-8")).hexdigest()[:8]
        name = f"{slugify(parent)}__{base}_{digest}{ext}"
        dest = os.path.join(oneshot_root, category, name)
    return os.path.normpath(dest)


def analyze_oneshot(path: str) -> dict[str, float]:
    """Header + cheap spectral stats for ``oneshot_index``. Not a second slicer."""
    features = {
        "duration_sec": 0.0,
        "peak": 0.0,
        "rms_db": -120.0,
        "spectral_centroid": 0.0,
        "pitch_hz": 0.0,
    }
    try:
        data, sr = sf.read(path, always_2d=True)
    except Exception:
        try:
            features["duration_sec"] = float(sf.info(path).duration)
        except Exception:
            pass
        return features
    mono = np.mean(np.asarray(data, dtype=np.float64), axis=1)
    sr_i = max(1, int(sr))
    if mono.size == 0:
        return features
    features["duration_sec"] = float(mono.size / sr_i)
    peak = float(np.max(np.abs(mono)))
    features["peak"] = peak
    rms = float(np.sqrt(np.mean(np.square(mono)) + 1e-12))
    features["rms_db"] = float(20.0 * np.log10(rms))
    n_fft = min(2048, int(mono.size))
    if n_fft >= 16:
        window = np.hanning(n_fft)
        mag = np.abs(np.fft.rfft(mono[:n_fft] * window))
        freqs = np.fft.rfftfreq(n_fft, 1.0 / sr_i)
        denom = float(np.sum(mag)) + 1e-12
        features["spectral_centroid"] = float(np.sum(freqs * mag) / denom)
        band = (freqs >= 30.0) & (freqs <= 400.0)
        if np.any(band) and float(np.max(mag[band])) > 1e-9:
            features["pitch_hz"] = float(freqs[band][int(np.argmax(mag[band]))])
    return features


def copy_oneshot(
    source_path: str,
    oneshot_root: str,
    *,
    dry_run: bool,
) -> dict[str, Any]:
    """Copy a one-shot into the library. Never deletes or moves the source."""
    category = oneshot_category(source_path)
    dest = oneshot_dest_path(oneshot_root, source_path, category)
    result: dict[str, Any] = {
        "category": category,
        "dest": dest,
        "source_path": source_path,
        "copied": False,
        "duration_sec": 0.0,
        "peak": 0.0,
        "rms_db": -120.0,
        "spectral_centroid": 0.0,
        "pitch_hz": 0.0,
    }
    if dry_run:
        try:
            result["duration_sec"] = float(sf.info(source_path).duration)
        except Exception:
            pass
        return result
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if not os.path.isfile(dest):
        shutil.copy2(source_path, dest)
    if not os.path.isfile(source_path):
        raise RuntimeError(f"source missing after copy (never delete sources): {source_path}")
    result.update(analyze_oneshot(source_path))
    result["copied"] = True
    result["dest"] = dest
    result["category"] = category
    result["source_path"] = source_path
    return result


def discover_sources(root: str) -> list[tuple[str, str]]:
    """Top-level source trees under ``root``, denied names removed.

    Returns ``(source_name, absolute_path)``. Discovery is by walking the
    drive, not from a hardcoded list, so newly extracted packs appear on the
    next scan.
    """
    if not os.path.isdir(root):
        return []
    found: list[tuple[str, str]] = []
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if not os.path.isdir(path) or is_denied_dir(name):
            continue
        found.append((name, os.path.normpath(path)))
    return found


def collect_source_files(source_dir: str) -> list[tuple[str, str, int]]:
    """Walk one source tree for readable audio: ``(path, ext, size_bytes)``."""
    entries: list[tuple[str, str, int]] = []
    for dirpath, dirnames, filenames in os.walk(source_dir):
        dirnames[:] = [d for d in dirnames if not is_denied_dir(d)]
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if ext not in AUDIO_EXTENSIONS or looks_already_sliced(name):
                continue
            full = os.path.join(dirpath, name)
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            entries.append((os.path.normpath(full), ext.lstrip("."), int(size)))
    entries.sort()
    return entries


def probe_sample(
    entries: list[tuple[str, str, int]],
    sample_size: int = SAMPLE_PROBE_FILES,
) -> dict[str, Any]:
    """Header-only probe of a random sample to estimate the whole tree.

    ``sf.info`` reads metadata, not audio, so this stays fast even on ``mtg``.
    """
    stats = {
        "probed": 0,
        "unreadable": 0,
        "short": 0,
        "mean_duration": 0.0,
        "mean_channels": 2.0,
        "seconds_per_byte": 0.0,
    }
    if not entries:
        return stats
    rng = random.Random(1729)
    pool = entries if len(entries) <= sample_size else rng.sample(entries, sample_size)
    durations: list[float] = []
    channels: list[int] = []
    sampled_bytes = 0
    for path, _ext, size in pool:
        try:
            info = sf.info(path)
        except Exception:
            stats["unreadable"] += 1
            continue
        stats["probed"] += 1
        durations.append(float(info.duration))
        channels.append(int(info.channels))
        sampled_bytes += int(size)
        if float(info.duration) < ONESHOT_MAX_DUR:
            stats["short"] += 1
    if durations:
        stats["mean_duration"] = sum(durations) / len(durations)
        stats["mean_channels"] = sum(channels) / len(channels)
        if sampled_bytes > 0:
            stats["seconds_per_byte"] = sum(durations) / float(sampled_bytes)
    return stats


def classify_source(source_name: str, stats: dict[str, Any]) -> tuple[str, str]:
    """Decide ``phrase`` vs ``oneshot`` from the name and the probe.

    Duration under ``ONESHOT_MAX_DUR`` (1.5 s) is the real test so one-shots
    scattered inside sample packs are caught too. Folder names (Kick / Snare /
    Hats / Perc) are only a hint. One-shots are copied, never 4s-sliced.
    """
    lowered = source_name.lower()
    name_hint = any(hint in lowered for hint in ONESHOT_DIR_HINTS)
    probed = int(stats.get("probed") or 0)
    short_ratio = (float(stats.get("short") or 0) / probed) if probed else 0.0

    if probed >= 3 and short_ratio >= ONESHOT_SAMPLE_RATIO:
        return (
            ledger.KIND_ONESHOT,
            f"{short_ratio:.0%} of {probed} probed files are shorter than "
            f"{ONESHOT_MAX_DUR}s - copy to oneshots library, do not 4s-slice",
        )
    if name_hint and probed == 0:
        return (
            ledger.KIND_ONESHOT,
            "directory name indicates one-shots and nothing could be probed",
        )
    if name_hint and short_ratio >= 0.5:
        return (
            ledger.KIND_ONESHOT,
            f"one-shot directory name and {short_ratio:.0%} of {probed} probed "
            f"files are under {ONESHOT_MAX_DUR}s - copy, do not 4s-slice",
        )
    return (ledger.KIND_PHRASE, "")


def estimate_source(
    entries: list[tuple[str, str, int]],
    stats: dict[str, Any],
    *,
    nominal_dur: float = NOMINAL_DUR,
    target_sr: int = DEFAULT_TARGET_SR,
) -> tuple[int, int]:
    """Extrapolate ``(slices, output_bytes)`` from the sampled duration."""
    bytes_total = sum(size for _p, _e, size in entries)
    sec_per_byte = float(stats.get("seconds_per_byte") or 0.0)
    if sec_per_byte <= 0.0 or bytes_total <= 0:
        return (0, 0)
    total_seconds = sec_per_byte * bytes_total
    slices = int(total_seconds / max(0.1, float(nominal_dur)))
    channels = max(1.0, float(stats.get("mean_channels") or 2.0))
    out_bytes = int(total_seconds * target_sr * channels * PCM24_BYTES_PER_SAMPLE)
    return (slices, out_bytes)


# --------------------------------------------------------------------------
# Scan phase
# --------------------------------------------------------------------------
def scan_into_ledger(
    conn: Any,
    *,
    root: str,
    campaign: str,
    only_source: str = "",
) -> dict[str, Any]:
    """Discover sources and enqueue their files. Idempotent and re-runnable."""
    assert_allowed_campaign_root(root)
    sources = discover_sources(root)
    if only_source:
        wanted = only_source.strip().lower()
        sources = [s for s in sources if s[0].lower() == wanted]
        if not sources:
            raise ValueError(
                f"No source tree named {only_source!r} under {root}. "
                f"Run --plan to list what was discovered."
            )

    summary: dict[str, Any] = {
        "sources": [],
        "total_files": 0,
        "new_files": 0,
        "bytes_total": 0,
        "est_slices": 0,
        "est_output_bytes": 0,
        "skipped_sources": [],
        "oneshot_sources": [],
        "oneshot_files": 0,
        "oneshot_bytes": 0,
    }

    for name, path in sources:
        entries = collect_source_files(path)
        if not entries:
            continue
        stats = probe_sample(entries)
        kind, reason = classify_source(name, stats)
        est_slices, est_bytes = estimate_source(entries, stats)
        bytes_total = sum(size for _p, _e, size in entries)

        ledger.register_source(
            conn,
            campaign=campaign,
            source_name=name,
            source_path=path,
            kind=kind,
            total_files=len(entries),
            bytes_total=bytes_total,
            est_slices=0 if kind == ledger.KIND_ONESHOT else est_slices,
            est_output_bytes=0 if kind == ledger.KIND_ONESHOT else est_bytes,
            status=ledger.STATUS_PENDING,
            note=reason,
        )

        new_rows = ledger.register_files(conn, campaign, name, entries)
        if kind == ledger.KIND_ONESHOT:
            summary["oneshot_sources"].append(
                {
                    "name": name,
                    "path": path,
                    "files": len(entries),
                    "new": new_rows,
                    "bytes": bytes_total,
                    "reason": reason,
                }
            )
            summary["oneshot_files"] += len(entries)
            summary["oneshot_bytes"] += bytes_total
            LOG.info(
                "[ONESHOT] %-28s files=%-7d new=%-7d in=%s (copy, do not 4s-slice)",
                name,
                len(entries),
                new_rows,
                ledger.format_bytes(bytes_total),
            )
            continue

        summary["sources"].append(
            {
                "name": name,
                "path": path,
                "files": len(entries),
                "new": new_rows,
                "bytes": bytes_total,
                "est_slices": est_slices,
                "est_output_bytes": est_bytes,
                "mean_duration": stats["mean_duration"],
                "unreadable_sample": stats["unreadable"],
            }
        )
        summary["total_files"] += len(entries)
        summary["new_files"] += new_rows
        summary["bytes_total"] += bytes_total
        summary["est_slices"] += est_slices
        summary["est_output_bytes"] += est_bytes
        LOG.info(
            "[SCAN] %-28s files=%-7d new=%-7d in=%s est_out=%s est_slices=%d",
            name,
            len(entries),
            new_rows,
            ledger.format_bytes(bytes_total),
            ledger.format_bytes(est_bytes),
            est_slices,
        )
    return summary


# --------------------------------------------------------------------------
# Slicing worker
# --------------------------------------------------------------------------
def slice_campaign_file(job: tuple[Any, ...]) -> dict[str, Any]:
    """Top-level picklable worker: probe, then copy one-shots or phrase-slice.

    One-shots (duration < ~1.5 s) are copied into the oneshots library. The
    4 s cuts come from ``engine.smart_transient_slicer.slice_one_source``.
    """
    (
        path,
        output_root,
        oneshot_root,
        target_sr,
        nominal_dur,
        min_dur,
        max_dur,
        oneshot_max_dur,
        dry_run,
    ) = job
    path = str(path)
    result: dict[str, Any] = {
        "file_path": path,
        "status": ledger.STATUS_DONE,
        "slices_written": 0,
        "layer": "",
        "error": "",
        "oneshot": None,
    }
    try:
        info = sf.info(path)
    except Exception as exc:
        result["status"] = ledger.STATUS_FAILED
        result["error"] = f"unreadable: {exc}"
        return result

    duration = float(info.duration)
    if duration < float(oneshot_max_dur):
        try:
            copied = copy_oneshot(path, str(oneshot_root), dry_run=bool(dry_run))
        except Exception as exc:
            result["status"] = ledger.STATUS_FAILED
            result["error"] = f"oneshot copy failed: {exc}"
            return result
        result["layer"] = f"oneshot/{copied['category']}"
        result["oneshot"] = copied
        return result

    if duration < float(min_dur):
        result["status"] = ledger.STATUS_SKIPPED
        result["error"] = (
            f"too short for 4s phrases: {duration:.2f}s < {float(min_dur)}s "
            f"(and longer than the {float(oneshot_max_dur)}s one-shot cutoff)"
        )
        return result

    try:
        outcome = slice_one_source(
            path,
            str(output_root),
            target_sr=int(target_sr),
            nominal_dur=float(nominal_dur),
            min_dur=float(min_dur),
            max_dur=float(max_dur),
            dry_run=bool(dry_run),
        )
    except Exception as exc:
        result["status"] = ledger.STATUS_FAILED
        result["error"] = str(exc)
        result["layer"] = os.path.basename(layer_output_dir(str(output_root), path))
        return result

    written = len(outcome.get("written") or [])
    result["slices_written"] = int(outcome.get("would_write") or 0) if dry_run else written
    result["layer"] = str(outcome.get("layer") or "")
    if not dry_run and written == 0:
        result["status"] = ledger.STATUS_SKIPPED
        result["error"] = "no phrase survived the -50 dBFS gate"
    return result


# --------------------------------------------------------------------------
# Run phase
# --------------------------------------------------------------------------
def reclaim_abandoned(conn: Any, campaign: str, *, stale_sec: float) -> int:
    """Return work claimed by dead runs to PENDING so a resume can pick it up."""
    reclaimed = ledger.requeue_stale(conn, campaign, max_age_sec=stale_sec)

    try:
        import psutil
    except Exception:
        return reclaimed

    rows = conn.execute(
        "SELECT id, pid FROM campaign_runs WHERE campaign = ? AND finished_at = 0",
        (campaign,),
    ).fetchall()
    dead = [
        int(row["id"])
        for row in rows
        if int(row["pid"] or 0) != os.getpid() and not psutil.pid_exists(int(row["pid"] or 0))
    ]
    if dead:
        reclaimed += ledger.requeue_stale(conn, campaign, max_age_sec=0.0)
        conn.executemany(
            "UPDATE campaign_runs SET finished_at = ?, note = 'reclaimed: process gone' "
            "WHERE id = ?",
            [(time.time(), run_id) for run_id in dead],
        )
        conn.commit()
    return reclaimed


def run_campaign(
    conn: Any,
    *,
    campaign: str,
    output_root: str,
    oneshot_root: str = DEFAULT_ONESHOTS,
    workers: int,
    execute: bool,
    limit: int = 0,
    only_source: str = "",
    batch_size: int = 0,
    target_sr: int = DEFAULT_TARGET_SR,
    nominal_dur: float = NOMINAL_DUR,
    min_dur: float = MIN_DUR,
    max_dur: float = MAX_DUR,
    oneshot_max_dur: float = ONESHOT_MAX_DUR,
) -> dict[str, Any]:
    """Drain PENDING rows through the Pool, recording each outcome as it lands.

    Dry-run peeks at PENDING rows and does not mark them DONE, so ``-Execute``
    can follow a preview without being blocked.
    """
    mode = "execute" if execute else "dry-run"
    run_id = ledger.start_run(conn, campaign=campaign, mode=mode, workers=workers)
    chunk = int(batch_size) if batch_size else max(8, workers * 8)

    totals = {
        "files": 0,
        "slices": 0,
        "failed": 0,
        "skipped": 0,
        "done": 0,
        "oneshots": 0,
        "elapsed": 0.0,
    }
    started = time.time()
    outstanding: list[str] = []
    interrupted = False

    try:
        while True:
            remaining_budget = (limit - totals["files"]) if limit else chunk
            if limit and remaining_budget <= 0:
                break
            take = min(chunk, remaining_budget) if limit else chunk
            if execute:
                claimed = ledger.claim_batch(
                    conn, campaign, limit=take, source_name=only_source
                )
            else:
                claimed = ledger.peek_pending(
                    conn,
                    campaign,
                    limit=take,
                    source_name=only_source,
                    offset=totals["files"],
                )
            if not claimed:
                break
            outstanding = [str(row["file_path"]) for row in claimed] if execute else []

            jobs = [
                (
                    str(row["file_path"]),
                    output_root,
                    oneshot_root,
                    int(target_sr),
                    float(nominal_dur),
                    float(min_dur),
                    float(max_dur),
                    float(oneshot_max_dur),
                    not execute,
                )
                for row in claimed
            ]
            for result in _drain(jobs, workers):
                if execute:
                    ledger.record_result(
                        conn,
                        campaign=campaign,
                        file_path=str(result["file_path"]),
                        status=str(result["status"]),
                        slices_written=int(result["slices_written"]),
                        layer=str(result["layer"]),
                        error=str(result["error"]),
                    )
                    oneshot = result.get("oneshot") or None
                    if oneshot and str(result["status"]) == ledger.STATUS_DONE:
                        ledger.upsert_oneshot(
                            conn,
                            file_path=str(oneshot["dest"]),
                            source_path=str(oneshot["source_path"]),
                            category=str(oneshot["category"]),
                            duration_sec=float(oneshot.get("duration_sec") or 0.0),
                            peak=float(oneshot.get("peak") or 0.0),
                            rms_db=float(oneshot.get("rms_db") or 0.0),
                            spectral_centroid=float(oneshot.get("spectral_centroid") or 0.0),
                            pitch_hz=float(oneshot.get("pitch_hz") or 0.0),
                        )
                    if str(result["file_path"]) in outstanding:
                        outstanding.remove(str(result["file_path"]))
                totals["files"] += 1
                totals["slices"] += int(result["slices_written"])
                status = str(result["status"])
                if result.get("oneshot") is not None:
                    totals["oneshots"] += 1
                if status == ledger.STATUS_FAILED:
                    totals["failed"] += 1
                    LOG.warning("[FAIL] %s: %s", result["file_path"], result["error"])
                elif status == ledger.STATUS_SKIPPED:
                    totals["skipped"] += 1
                else:
                    totals["done"] += 1
                # Persist run progress as each file lands, not only after the
                # whole claim-batch drains. A hung worker must not freeze the
                # heartbeat behind the remaining 63.
                ledger.heartbeat_run(
                    conn,
                    run_id,
                    files_done=totals["files"],
                    slices_written=totals["slices"],
                )

            ledger.heartbeat_run(
                conn,
                run_id,
                files_done=totals["files"],
                slices_written=totals["slices"],
            )
            elapsed = max(1e-6, time.time() - started)
            LOG.info(
                "[PROGRESS] files=%d done=%d skipped=%d failed=%d oneshots=%d slices=%d "
                "rate=%.2f files/s",
                totals["files"],
                totals["done"],
                totals["skipped"],
                totals["failed"],
                totals["oneshots"],
                totals["slices"],
                totals["files"] / elapsed,
            )
    except KeyboardInterrupt:
        interrupted = True
        LOG.warning("[INTERRUPT] releasing %d claimed file(s) back to PENDING", len(outstanding))
    finally:
        # Whatever was claimed but never finished goes straight back to the
        # queue, so an interrupted run resumes without waiting out the stale
        # window.
        for path in outstanding:
            ledger.record_result(
                conn,
                campaign=campaign,
                file_path=path,
                status=ledger.STATUS_PENDING,
                error="",
            )
        totals["elapsed"] = time.time() - started
        ledger.finish_run(
            conn,
            run_id,
            files_done=totals["files"],
            slices_written=totals["slices"],
            note="interrupted" if interrupted else "",
        )
    totals["interrupted"] = interrupted
    return totals


def _drain(jobs: list[tuple[Any, ...]], workers: int) -> Iterable[dict[str, Any]]:
    if workers <= 1 or len(jobs) < 2:
        for job in jobs:
            yield slice_campaign_file(job)
        return
    with mp.Pool(processes=workers) as pool:
        for result in pool.imap_unordered(slice_campaign_file, jobs):
            yield result


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------
def status_line(conn: Any, campaign: str, source_name: str = "") -> str:
    progress = ledger.campaign_progress(conn, campaign, source_name)
    counts = progress["counts"]
    eta = (
        ledger.format_duration(progress["eta_sec"])
        if progress["eta_sec"] > 0
        else "unknown"
    )
    rate = progress["files_per_sec"]
    return (
        f"[{campaign}{'/' + source_name if source_name else ''}] "
        f"{progress['percent']:.2f}% "
        f"({progress['settled']}/{progress['total_files']} files) "
        f"done={counts['DONE']} skipped={counts['SKIPPED']} "
        f"failed={counts['FAILED']} pending={counts['PENDING']} "
        f"in_progress={counts['IN_PROGRESS']} "
        f"slices={progress['slices_written']} "
        f"rate={rate:.2f} files/s eta={eta}"
    )


def print_plan(summary: dict[str, Any], output_root: str) -> None:
    print("\n=== CAMPAIGN PLAN ===")
    print(f"{'SOURCE':<30}{'FILES':>9}{'NEW':>9}{'INPUT':>12}{'EST OUTPUT':>13}{'EST SLICES':>12}")
    for src in summary["sources"]:
        print(
            f"{src['name'][:29]:<30}{src['files']:>9}{src['new']:>9}"
            f"{ledger.format_bytes(src['bytes']):>12}"
            f"{ledger.format_bytes(src['est_output_bytes']):>13}"
            f"{src['est_slices']:>12}"
        )
    print("-" * 85)
    print(
        f"{'TOTAL':<30}{summary['total_files']:>9}{summary['new_files']:>9}"
        f"{ledger.format_bytes(summary['bytes_total']):>12}"
        f"{ledger.format_bytes(summary['est_output_bytes']):>13}"
        f"{summary['est_slices']:>12}"
    )
    if not summary["sources"] and summary.get("oneshot_sources"):
        print("(no phrase trees in this selection — oneshot copies are listed below)")

    if summary.get("oneshot_sources"):
        print("\nONESHOT SOURCES (COPY to oneshots library, sources kept, not 4s-sliced):")
        for src in summary["oneshot_sources"]:
            print(
                f"  {src['name']:<30} {src['files']:>7} files "
                f"{ledger.format_bytes(src['bytes']):>10} - {src['reason']}"
            )
        print(
            f"  total oneshot files={summary.get('oneshot_files', 0)} "
            f"bytes={ledger.format_bytes(summary.get('oneshot_bytes', 0))}"
        )

    if summary.get("skipped_sources"):
        print("\nSKIPPED SOURCES:")
        for src in summary["skipped_sources"]:
            print(f"  {src['name']:<30} {src['files']:>7} files - {src['reason']}")

    free = free_bytes(output_root if os.path.isdir(output_root) else os.path.splitdrive(output_root)[0] + os.sep)
    need = int(summary["est_output_bytes"] * FREE_SPACE_MARGIN)
    print(f"\nFree space on target : {ledger.format_bytes(free)}")
    print(f"Estimated need (x{FREE_SPACE_MARGIN:.2f}) : {ledger.format_bytes(need)}")
    if need > free:
        print("  [WARN] Estimated output exceeds free space. Slice source-by-source with --source.")
    else:
        print("  [OK] Estimated output fits with margin.")


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def configure_logging(log_dir: str, verbose: bool = False) -> str:
    LOG.setLevel(logging.DEBUG if verbose else logging.INFO)
    LOG.handlers.clear()
    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(logging.Formatter("%(message)s"))
    LOG.addHandler(stream)

    log_path = ""
    try:
        os.makedirs(log_dir, exist_ok=True)
        log_path = os.path.join(
            log_dir, f"slicing_campaign_{time.strftime('%Y%m%d_%H%M%S')}.log"
        )
        file_handler = logging.FileHandler(log_path, encoding="utf-8")
        file_handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(message)s")
        )
        LOG.addHandler(file_handler)
    except Exception as exc:  # logging must never take the campaign down
        LOG.warning("[WARN] file logging disabled: %s", exc)
    return log_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Resumable, ledger-tracked bulk 4s slicing campaign."
    )
    parser.add_argument("--root", default=DEFAULT_ROOT, help="Raw library root to discover")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="corpus_4s root")
    parser.add_argument(
        "--oneshot-output",
        default=DEFAULT_ONESHOTS,
        help="One-shot library root (copy destination)",
    )
    parser.add_argument(
        "--incoming-zips",
        default=DEFAULT_INCOMING_ZIPS,
        help="Zip inbox (listed on dry-run; never extracted by this campaign)",
    )
    parser.add_argument("--db", default=DEFAULT_DB, help="Ledger database")
    parser.add_argument("--campaign", default=DEFAULT_CAMPAIGN, help="Campaign name")
    parser.add_argument("--log-dir", default=DEFAULT_LOG_DIR)
    parser.add_argument("--source", default="", help="Restrict to one discovered source tree")
    parser.add_argument("--limit", type=int, default=0, help="Process at most N files (0 = all)")
    parser.add_argument("--workers", type=int, default=None, help="Pool size (auto by default)")
    parser.add_argument("--batch-size", type=int, default=0, help="Ledger claim size")
    parser.add_argument("--execute", action="store_true", help="Write audio (default is dry-run)")
    parser.add_argument("--plan", action="store_true", help="Scan and print the plan, then stop")
    parser.add_argument("--status", action="store_true", help="Print one status line and exit")
    parser.add_argument(
        "--list-zips",
        action="store_true",
        help="List incoming_zips (no extract). Included automatically on dry-run.",
    )
    parser.add_argument("--no-scan", action="store_true", help="Skip discovery; use the ledger as-is")
    parser.add_argument("--retry-failed", action="store_true", help="Requeue FAILED rows first")
    parser.add_argument(
        "--wait-for-indexer",
        action="store_true",
        help="Block until the corpus indexer exits, then use the idle worker ceiling",
    )
    parser.add_argument(
        "--allow-contention",
        action="store_true",
        help="Raise the worker ceiling even while the indexer runs",
    )
    parser.add_argument("--stale-sec", type=float, default=DEFAULT_STALE_SEC)
    parser.add_argument("--sr", type=int, default=DEFAULT_TARGET_SR)
    parser.add_argument("--nominal-dur", type=float, default=NOMINAL_DUR)
    parser.add_argument("--min-dur", type=float, default=MIN_DUR)
    parser.add_argument("--max-dur", type=float, default=MAX_DUR)
    parser.add_argument(
        "--no-unzip",
        action="store_true",
        help="Do not reserve a worker for incoming_zips (all workers slice)",
    )
    parser.add_argument("--verbose", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.status:
        conn = ledger.open_ledger(args.db)
        try:
            print(status_line(conn, args.campaign, args.source))
            for row in ledger.recent_failures(conn, args.campaign, limit=5):
                print(f"  [FAILED] {row['file_path']}: {row['error']}")
        finally:
            conn.close()
        return 0

    log_path = configure_logging(args.log_dir, args.verbose)

    try:
        assert_allowed_campaign_root(args.root)
    except Exception as exc:
        LOG.error("[REFUSED] %s", exc)
        return 2

    if args.wait_for_indexer:
        wait_for_indexer()

    indexer = indexer_worker_count()
    workers = resolve_campaign_workers(
        args.workers,
        cpu_count=os.cpu_count() or 4,
        indexer_running=indexer > 0,
        allow_contention=args.allow_contention,
    )
    slice_workers, unzip_workers = split_slice_and_unzip_workers(workers)
    if args.no_unzip:
        slice_workers, unzip_workers = workers, 0

    LOG.info("=" * 78)
    LOG.info("SLICING CAMPAIGN  campaign=%s  mode=%s", args.campaign, "EXECUTE" if args.execute else "DRY-RUN")
    LOG.info("root=%s  output=%s", args.root, args.output)
    LOG.info("oneshots=%s  incoming_zips=%s", args.oneshot_output, args.incoming_zips)
    LOG.info("db=%s", args.db)
    LOG.info(
        "cpus=%d  indexer_procs=%d  workers=%d  slice=%d  unzip=%d%s",
        os.cpu_count() or 0,
        indexer,
        workers,
        slice_workers,
        unzip_workers,
        "  (indexer active - reduced ceiling)" if indexer else "",
    )
    if log_path:
        LOG.info("log=%s", log_path)
    LOG.info("=" * 78)

    if args.list_zips or not args.execute:
        print_zip_listing(list_incoming_zips(args.incoming_zips))
        if args.list_zips and args.no_scan and not args.execute:
            return 0

    conn = ledger.open_ledger(args.db)
    try:
        reclaimed = reclaim_abandoned(conn, args.campaign, stale_sec=args.stale_sec)
        if reclaimed:
            LOG.info("[RESUME] returned %d abandoned claim(s) to PENDING", reclaimed)
        if args.retry_failed:
            requeued = ledger.reset_failed(conn, args.campaign, args.source)
            LOG.info("[RETRY] requeued %d failed file(s)", requeued)

        if not args.no_scan:
            summary = scan_into_ledger(
                conn, root=args.root, campaign=args.campaign, only_source=args.source
            )
            print_plan(summary, args.output)

        plan_only = args.plan or (not args.execute and not args.limit)
        if plan_only:
            print("\n" + status_line(conn, args.campaign, args.source))
            if not args.execute:
                LOG.info(
                    "Dry-run is plan-only (no audio writes, ledger stays PENDING). "
                    "Smoke: --execute --limit N --source NAME. "
                    "Full campaign: --execute (do not pass D:\\ as --root)."
                )
            return 0

        totals = run_campaign(
            conn,
            campaign=args.campaign,
            output_root=args.output,
            oneshot_root=args.oneshot_output,
            workers=workers,
            execute=args.execute,
            limit=args.limit,
            only_source=args.source,
            batch_size=args.batch_size,
            target_sr=args.sr,
            nominal_dur=args.nominal_dur,
            min_dur=args.min_dur,
            max_dur=args.max_dur,
        )

        elapsed = max(1e-6, float(totals["elapsed"]))
        LOG.info("-" * 78)
        LOG.info(
            "[COMPLETE] %s: files=%d done=%d skipped=%d failed=%d oneshots=%d slices=%d in %s "
            "(%.2f files/s)",
            "execute" if args.execute else "dry-run",
            totals["files"],
            totals["done"],
            totals["skipped"],
            totals["failed"],
            totals.get("oneshots", 0),
            totals["slices"],
            ledger.format_duration(elapsed),
            totals["files"] / elapsed,
        )
        LOG.info(status_line(conn, args.campaign, args.source))
        return 130 if totals.get("interrupted") else 0
    except ValueError as exc:
        LOG.error("[ERROR] %s", exc)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    mp.freeze_support()
    raise SystemExit(main())
