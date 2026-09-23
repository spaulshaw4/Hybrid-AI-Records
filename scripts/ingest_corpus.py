"""Standalone corpus ingester: unpack archives, slice, backfill features, relabel.

Runs natively (``python scripts\\ingest_corpus.py``) for as long as it takes.
Every phase is resumable: Ctrl-C, a crash or a reboot costs at most the batch
in flight, and a re-run picks up where the ledgers say it stopped.

Phases (``--phases``, default all, in this order):

``unpack``
    Archives under ``incoming_zips`` / ``incoming``: .zip and .tar(.gz/.bz2/.xz)
    natively, .rar / .7z via 7-Zip when ``7z.exe`` is installed (else SKIPPED).
    Only audio members are extracted, into ``raw_packs\\<archive>``. Archives
    are never deleted. Ledger: ``ingest_archives`` (a changed size/mtime re-runs).
``slice``
    ``scripts/run_slicing_campaign.py --execute --no-unzip`` (its own resumable
    ledger), then ``scripts/index_corpus_4s.py --headers`` to register new wavs.
``features``
    ``slice_index`` rows missing BPM, duration or key are measured with the same
    detectors as ``db/index_578gb_corpus`` (``detect_slice_key``, onset
    autocorrelation BPM) across ``--workers`` processes, written back in
    ``--batch`` row WAL transactions. Only NULL columns are filled; a value
    that cannot be measured stays NULL rather than defaulting to A / 120 BPM.
    Unreadable files go to ``ingest_feature_failures`` and are skipped.
``relabel``
    ``stem_type='vocal'`` rows stored under instrument folders move to that stem.

Writes the D: catalog (``D:\\MusicDatasets\\db\\corpus_index.sqlite``). The
live worker replica on C: re-copies it within six hours.
"""
from __future__ import annotations

import argparse
import multiprocessing as mp
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import zipfile
from typing import Any, Iterable

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

DEFAULT_DB = r"D:\MusicDatasets\db\corpus_index.sqlite"
DEFAULT_INBOXES = (r"D:\MusicDatasets\incoming_zips", r"D:\MusicDatasets\incoming")
DEFAULT_RAW_PACKS = r"D:\MusicDatasets\raw_packs"
DEFAULT_BATCH = 5000
DEFAULT_WORKERS = max(1, min(8, os.cpu_count() or 1))
BUSY_TIMEOUT_MS = 60_000
LOCK_RETRIES = 10
ALL_PHASES = ("unpack", "slice", "features", "relabel")

AUDIO_EXTENSIONS = frozenset(
    {".wav", ".wave", ".mp3", ".flac", ".ogg", ".oga", ".aif", ".aiff", ".aifc", ".w64"}
)
NATIVE_TAR_SUFFIXES = (".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz")
SEVEN_ZIP_SUFFIXES = (".rar", ".7z")
REFUSED_ARCHIVE_PREFIXES = ("fma_full",)
SEVEN_ZIP_CANDIDATES = (
    r"C:\Program Files\7-Zip\7z.exe",
    r"C:\Program Files (x86)\7-Zip\7z.exe",
)
# Below this RMS a slice is silence; key/BPM would be noise, so they stay NULL.
SILENT_RMS_DB = -60.0

ARCHIVES_DDL = """
CREATE TABLE IF NOT EXISTS ingest_archives (
    path TEXT PRIMARY KEY,
    size_bytes INTEGER,
    mtime REAL,
    status TEXT NOT NULL,
    dest_dir TEXT,
    files_out INTEGER DEFAULT 0,
    error TEXT,
    updated_at REAL
)
"""
FAILURES_DDL = """
CREATE TABLE IF NOT EXISTS ingest_feature_failures (
    id INTEGER PRIMARY KEY,
    file_path TEXT,
    error TEXT,
    failed_at REAL
)
"""


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def connect(db_path: str, *, read_only: bool = False) -> sqlite3.Connection:
    if read_only:
        uri = "file:" + os.path.abspath(db_path).replace("\\", "/") + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=BUSY_TIMEOUT_MS / 1000.0)
        conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        return conn
    conn = sqlite3.connect(db_path, timeout=BUSY_TIMEOUT_MS / 1000.0)
    conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(ARCHIVES_DDL)
    conn.execute(FAILURES_DDL)
    conn.commit()
    return conn


def with_retry(conn: sqlite3.Connection, fn) -> Any:
    """Run ``fn`` in one transaction, backing off while another writer holds the lock."""
    delay = 0.5
    for attempt in range(LOCK_RETRIES):
        try:
            conn.execute("BEGIN IMMEDIATE")
            result = fn()
            conn.execute("COMMIT")
            return result
        except sqlite3.OperationalError as exc:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            if "locked" not in str(exc).lower() or attempt == LOCK_RETRIES - 1:
                raise
            time.sleep(delay)
            delay = min(delay * 2.0, 30.0)
    return None


# --------------------------------------------------------------------------
# unpack
# --------------------------------------------------------------------------


def _pack_name(path: str) -> str:
    """Same folder naming as ``db.pack_tracker.pack_name_from_zip`` (raw_packs\\<name>)."""
    return re.sub(r"[\s\-]+", "_", _archive_stem(path)).strip("_") or "unnamed_pack"


def _already_unpacked(conn: sqlite3.Connection, path: str, dest: str) -> bool:
    """A zip the campaign's pack tracker already extracted, or a populated dest."""
    try:
        row = conn.execute(
            "SELECT status FROM pack_manifest WHERE pack_name = ?", (_pack_name(path),)
        ).fetchone()
    except sqlite3.OperationalError:
        row = None
    if row and str(row[0] or "").upper() in {"UNZIPPED", "SLICED", "READY_TO_GO"}:
        return True
    if os.path.isdir(dest):
        for _dirpath, _dirs, files in os.walk(dest):
            if any(_is_audio(name) for name in files):
                return True
    return False


def _archive_kind(path: str) -> str | None:
    lower = path.lower()
    if lower.endswith(".zip"):
        return "zip"
    if lower.endswith(NATIVE_TAR_SUFFIXES):
        return "tar"
    if lower.endswith(SEVEN_ZIP_SUFFIXES):
        return "7z"
    return None


def _archive_stem(path: str) -> str:
    base = os.path.basename(path)
    lower = base.lower()
    for suffix in sorted(NATIVE_TAR_SUFFIXES + SEVEN_ZIP_SUFFIXES + (".zip",), key=len, reverse=True):
        if lower.endswith(suffix):
            return base[: -len(suffix)]
    return os.path.splitext(base)[0]


def find_seven_zip() -> str | None:
    on_path = shutil.which("7z") or shutil.which("7z.exe")
    if on_path:
        return on_path
    return next((p for p in SEVEN_ZIP_CANDIDATES if os.path.isfile(p)), None)


def discover_archives(inboxes: Iterable[str]) -> list[str]:
    found: list[str] = []
    for root in inboxes:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                path = os.path.join(dirpath, name)
                if _archive_kind(path) is None:
                    continue
                if name.lower().startswith(REFUSED_ARCHIVE_PREFIXES):
                    continue
                found.append(path)
    return sorted(found)


def _inside(dest: str, member: str) -> str | None:
    """Resolved extraction path, or ``None`` when the member escapes ``dest``."""
    target = os.path.realpath(os.path.join(dest, member))
    root = os.path.realpath(dest)
    if os.path.commonpath([root, target]) != root:
        return None
    return target


def _is_audio(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in AUDIO_EXTENSIONS


def extract_zip(path: str, dest: str) -> int:
    written = 0
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if info.is_dir() or not _is_audio(info.filename):
                continue
            target = _inside(dest, info.filename)
            if target is None:
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with archive.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out, length=1 << 20)
            written += 1
    return written


def extract_tar(path: str, dest: str) -> int:
    written = 0
    with tarfile.open(path) as archive:
        for member in archive.getmembers():
            if not member.isfile() or not _is_audio(member.name):
                continue
            target = _inside(dest, member.name)
            if target is None:
                continue
            src = archive.extractfile(member)
            if src is None:
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with src, open(target, "wb") as out:
                shutil.copyfileobj(src, out, length=1 << 20)
            written += 1
    return written


def extract_seven_zip(path: str, dest: str, seven_zip: str) -> int:
    patterns = [f"-ir!*{ext}" for ext in sorted(AUDIO_EXTENSIONS)]
    result = subprocess.run(
        [seven_zip, "x", "-y", "-bd", f"-o{dest}", path, *patterns],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode not in (0, 1):  # 1 = warnings (e.g. skipped members)
        raise RuntimeError((result.stderr or result.stdout or "7z failed").strip()[-400:])
    return sum(
        1
        for dirpath, _d, files in os.walk(dest)
        for name in files
        if _is_audio(name)
    )


def run_unpack(conn: sqlite3.Connection, inboxes: Iterable[str], raw_packs: str, dry_run: bool) -> dict[str, int]:
    archives = discover_archives(inboxes)
    seven_zip = find_seven_zip()
    stats = {"found": len(archives), "done": 0, "skipped": 0, "failed": 0, "unchanged": 0}
    log(f"[UNPACK] archives={len(archives)} 7z={'yes' if seven_zip else 'no'} dest={raw_packs}")
    for path in archives:
        try:
            st = os.stat(path)
        except OSError:
            continue
        try:
            row = conn.execute(
                "SELECT status, size_bytes, mtime FROM ingest_archives WHERE path = ?", (path,)
            ).fetchone()
        except sqlite3.OperationalError:  # read-only dry run before the ledger exists
            row = None
        if row and row[0] in ("DONE", "SKIPPED") and row[1] == st.st_size and abs(float(row[2] or 0) - st.st_mtime) < 1.0:
            stats["unchanged"] += 1
            continue
        kind = _archive_kind(path)
        dest = os.path.join(raw_packs, _pack_name(path))
        previously = _already_unpacked(conn, path, dest)
        if dry_run:
            verb = "already unpacked" if previously else f"would extract {kind}"
            log(f"[UNPACK] {verb}: {path} -> {dest}")
            if previously:
                stats["unchanged"] += 1
            continue
        status, files_out, error = "DONE", 0, None
        try:
            if previously:
                error = "already unpacked (pack_manifest or populated dest)"
            elif kind == "7z" and not seven_zip:
                status, error = "SKIPPED", "7-Zip not installed (needed for .rar/.7z)"
            else:
                os.makedirs(dest, exist_ok=True)
                if kind == "zip":
                    files_out = extract_zip(path, dest)
                elif kind == "tar":
                    files_out = extract_tar(path, dest)
                else:
                    files_out = extract_seven_zip(path, dest, str(seven_zip))
        except Exception as exc:  # noqa: BLE001 - one bad archive must not stop the run
            status, error = "FAILED", f"{type(exc).__name__}: {exc}"[:500]
        stats[{"DONE": "done", "SKIPPED": "skipped", "FAILED": "failed"}[status]] += 1
        with_retry(
            conn,
            lambda: conn.execute(
                "INSERT INTO ingest_archives (path, size_bytes, mtime, status, dest_dir, files_out, error, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET size_bytes=excluded.size_bytes, "
                "mtime=excluded.mtime, status=excluded.status, dest_dir=excluded.dest_dir, "
                "files_out=excluded.files_out, error=excluded.error, updated_at=excluded.updated_at",
                (path, st.st_size, st.st_mtime, status, dest, files_out, error, time.time()),
            ),
        )
        log(f"[UNPACK] {status} {os.path.basename(path)} audio_files={files_out}" + (f" ({error})" if error else ""))
    log(f"[UNPACK] {stats}")
    return stats


# --------------------------------------------------------------------------
# slice
# --------------------------------------------------------------------------


def run_slice(db_path: str, workers: int, dry_run: bool) -> int:
    python = sys.executable
    campaign = [python, os.path.join(_REPO, "scripts", "run_slicing_campaign.py"),
                "--db", db_path, "--no-unzip", "--workers", str(workers), "--execute"]
    if dry_run:
        # The campaign's own scan records files in its ledger, so don't run it here.
        log(f"[SLICE] would run: {' '.join(campaign)}")
        return 0
    log(f"[SLICE] {' '.join(campaign)}")
    code = subprocess.call(campaign, cwd=_REPO)
    if code != 0:
        log(f"[SLICE] campaign exited {code}; continuing to registration")
    register = [python, os.path.join(_REPO, "scripts", "index_corpus_4s.py"), "--db", db_path, "--headers"]
    log(f"[SLICE] {' '.join(register)}")
    return subprocess.call(register, cwd=_REPO) or code


# --------------------------------------------------------------------------
# features
# --------------------------------------------------------------------------


def _worker_init() -> None:
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("MKL_NUM_THREADS", "1")


def analyze_features(item: tuple[int, str]) -> tuple[int, dict[str, Any] | None, str | None]:
    """``(id, features, error)`` for one slice. Missing measurements stay ``None``."""
    row_id, path = item
    if not os.path.isfile(path):
        return row_id, None, "missing file"
    try:
        import numpy as np
        import soundfile as sf

        from db.index_578gb_corpus import _spectral_centroid_hz
        from dsp.pitch_key_aligner import detect_slice_key
        from dsp.tempo_time_stretch import estimate_slice_bpm_or_none

        data, sr = sf.read(path, always_2d=True)
        mono = np.mean(np.asarray(data, dtype=np.float64), axis=1)
        if mono.size == 0:
            return row_id, None, "empty audio"
        sr_i = int(sr)
        rms_db = float(20.0 * np.log10(float(np.sqrt(np.mean(np.square(mono)) + 1e-12))))
        features: dict[str, Any] = {
            "duration_sec": round(float(mono.size) / float(max(1, sr_i)), 2),
            "rms_db": round(rms_db, 2),
            "spectral_centroid": round(float(_spectral_centroid_hz(mono, sr_i)), 1),
            "detected_key": None,
            "estimated_bpm": None,
        }
        if rms_db > SILENT_RMS_DB:
            _idx, key = detect_slice_key(mono, sr=sr_i)
            features["detected_key"] = str(key)
            bpm = estimate_slice_bpm_or_none(mono, sr=sr_i)
            if bpm is not None:
                features["estimated_bpm"] = round(float(bpm), 1)
        return row_id, features, None
    except Exception as exc:  # noqa: BLE001
        return row_id, None, f"{type(exc).__name__}: {exc}"[:300]


UPDATE_FEATURES_SQL = """
UPDATE slice_index SET
    estimated_bpm = COALESCE(estimated_bpm, ?),
    duration_sec = COALESCE(duration_sec, ?),
    detected_key = CASE WHEN detected_key IS NULL OR detected_key = '' THEN ? ELSE detected_key END,
    rms_db = COALESCE(rms_db, ?),
    spectral_centroid = COALESCE(spectral_centroid, ?)
WHERE id = ?
"""

PENDING_SQL = """
SELECT si.id, si.file_path FROM slice_index AS si
WHERE si.id > ?
  AND (si.estimated_bpm IS NULL OR si.duration_sec IS NULL
       OR si.detected_key IS NULL OR si.detected_key = '')
  AND NOT EXISTS (SELECT 1 FROM ingest_feature_failures f WHERE f.id = si.id)
  AND NOT EXISTS (SELECT 1 FROM ingest_feature_measured m WHERE m.id = si.id)
ORDER BY si.id
LIMIT ?
"""

# Rows fully measured but with a value that genuinely has no reading (silence,
# no detectable tempo). Without this they would be re-read on every run.
MEASURED_DDL = "CREATE TABLE IF NOT EXISTS ingest_feature_measured (id INTEGER PRIMARY KEY)"


def run_features(
    conn: sqlite3.Connection,
    workers: int,
    batch: int,
    limit: int,
    dry_run: bool,
) -> dict[str, int]:
    if not dry_run:
        conn.execute(MEASURED_DDL)
        conn.commit()
    remaining = int(
        conn.execute(
            "SELECT COUNT(*) FROM slice_index WHERE estimated_bpm IS NULL OR duration_sec IS NULL "
            "OR detected_key IS NULL OR detected_key = ''"
        ).fetchone()[0]
    )
    log(f"[FEATURES] rows missing bpm/duration/key: {remaining} workers={workers} batch={batch}")
    stats = {"updated": 0, "failed": 0, "no_tempo": 0}
    if dry_run or remaining == 0:
        return stats
    pool = mp.Pool(workers, initializer=_worker_init) if workers > 1 else None
    last_id = 0
    started = time.time()
    processed = 0
    try:
        while True:
            take = batch if limit <= 0 else min(batch, limit - processed)
            if take <= 0:
                break
            rows = conn.execute(PENDING_SQL, (last_id, take)).fetchall()
            if not rows:
                break
            last_id = int(rows[-1][0])
            items = [(int(r[0]), str(r[1])) for r in rows]
            paths = dict(items)
            results = (
                list(pool.imap_unordered(analyze_features, items, chunksize=32))
                if pool is not None
                else [analyze_features(item) for item in items]
            )
            updates, failures, measured = [], [], []
            for row_id, feats, error in results:
                if feats is None:
                    failures.append((row_id, paths.get(row_id), error, time.time()))
                    continue
                updates.append(
                    (feats["estimated_bpm"], feats["duration_sec"], feats["detected_key"],
                     feats["rms_db"], feats["spectral_centroid"], row_id)
                )
                if feats["estimated_bpm"] is None or feats["detected_key"] is None:
                    measured.append((row_id,))
                    stats["no_tempo"] += feats["estimated_bpm"] is None

            def write() -> None:
                conn.executemany(UPDATE_FEATURES_SQL, updates)
                conn.executemany(
                    "INSERT OR REPLACE INTO ingest_feature_failures (id, file_path, error, failed_at) VALUES (?,?,?,?)",
                    failures,
                )
                conn.executemany("INSERT OR IGNORE INTO ingest_feature_measured (id) VALUES (?)", measured)

            with_retry(conn, write)
            processed += len(items)
            stats["updated"] += len(updates)
            stats["failed"] += len(failures)
            elapsed = max(1e-6, time.time() - started)
            rate = processed / elapsed
            eta_h = (remaining - processed) / rate / 3600.0 if rate > 0 else 0.0
            log(
                f"[FEATURES] {processed}/{remaining} updated={stats['updated']} failed={stats['failed']} "
                f"no_tempo={stats['no_tempo']} {rate:.0f} files/s ({1000.0 / rate:.1f} ms/file) "
                f"eta={eta_h:.1f} h last_id={last_id}"
            )
    finally:
        if pool is not None:
            pool.close()
            pool.join()
    log(f"[FEATURES] {stats}")
    return stats


# --------------------------------------------------------------------------
# relabel
# --------------------------------------------------------------------------


def run_relabel(conn: sqlite3.Connection, dry_run: bool) -> dict[str, int]:
    from engine.live_index import relabel_misfiled_vocals

    if dry_run:
        n = conn.execute(
            "SELECT COUNT(*) FROM slice_index WHERE stem_type='vocal' AND "
            "lower(replace(file_path, '/', '\\')) LIKE '%\\harmonic\\%'"
        ).fetchone()[0]
        log(f"[RELABEL] would move {n} vocal rows under \\harmonic\\ (plus rhythm/drums/bass folders)")
        return {}
    moved = with_retry(conn, lambda: relabel_misfiled_vocals(conn)) or {}
    log(f"[RELABEL] moved {moved or 'nothing'}")
    return moved


# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--phases", default=",".join(ALL_PHASES),
                        help=f"Comma list from {', '.join(ALL_PHASES)} (default: all)")
    parser.add_argument("--inbox", action="append", default=None,
                        help="Archive inbox directory (repeatable; default incoming_zips + incoming)")
    parser.add_argument("--raw-packs", default=DEFAULT_RAW_PACKS)
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--batch", type=int, default=DEFAULT_BATCH)
    parser.add_argument("--limit", type=int, default=0, help="Feature rows to process this run (0 = all)")
    parser.add_argument("--dry-run", action="store_true", help="Report what would happen; write nothing")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    phases = [p.strip().lower() for p in args.phases.split(",") if p.strip()]
    unknown = [p for p in phases if p not in ALL_PHASES]
    if unknown:
        print(f"[FATAL] unknown phase(s): {unknown}", file=sys.stderr)
        return 2
    if not os.path.isfile(args.db):
        print(f"[FATAL] catalog not found: {args.db}", file=sys.stderr)
        return 1
    log(f"[INGEST] db={args.db} phases={phases} dry_run={args.dry_run}")
    conn = connect(args.db, read_only=args.dry_run)
    try:
        for phase in ALL_PHASES:
            if phase not in phases:
                continue
            if phase == "unpack":
                run_unpack(conn, args.inbox or DEFAULT_INBOXES, args.raw_packs, args.dry_run)
            elif phase == "slice":
                run_slice(args.db, max(1, args.workers), args.dry_run)
            elif phase == "features":
                run_features(conn, max(1, args.workers), max(1, args.batch), args.limit, args.dry_run)
            elif phase == "relabel":
                run_relabel(conn, args.dry_run)
    except KeyboardInterrupt:
        log("[INGEST] interrupted; re-run to resume")
        return 130
    finally:
        conn.close()
    log("[INGEST] complete")
    return 0


if __name__ == "__main__":
    mp.freeze_support()
    raise SystemExit(main())
