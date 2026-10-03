"""Worker-only corpus index: static replica on C:, WAL, optional RAM clone.

The Learner and DSP lock pound D:\\. ``select_for_role`` must never open
``D:\\MusicDatasets\\db\\corpus_index.sqlite`` — that file lock is what hung
composition. The live API reads ``C:\\live_web_outputs\\db\\corpus_index_live.sqlite``
(or an in-memory clone of it) and never writes the Learner database.

Replica freshness is tracked by a ``.source`` stamp holding the fingerprint
of the D: catalog the replica was copied from. It cannot be inferred from the
replica's own mtime: ``ensure_role_indexes`` rewrites the replica on every
call, so its mtime measures the last render rather than the last ingest.
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import time
from typing import Any

SOURCE_INDEX = r"D:\MusicDatasets\db\corpus_index.sqlite"
FALLBACK_SOURCE = r"D:\MusicDatasets\database\corpus_index.sqlite"
DEFAULT_LIVE_INDEX = r"C:\live_web_outputs\db\corpus_index_live.sqlite"
# Import-time alias so existing callers (`from engine.live_index import LIVE_INDEX`)
# still resolve. Prefer live_index_path() — it re-reads CORPUS_INDEX_LIVE.
LIVE_INDEX = os.environ.get("CORPUS_INDEX_LIVE") or DEFAULT_LIVE_INDEX
# How long to wait before retrying a copy that failed. This is NOT a
# staleness test: whether the replica is current is decided by comparing the
# source fingerprint against the .source stamp, because the replica's own
# mtime is rewritten by ensure_role_indexes on every call.
REFRESH_EVERY_SEC = 6 * 60 * 60
COPY_TIMEOUT_SEC = 90
# Page batch between progress callbacks during the sqlite backup. 4096 pages
# is ~16 MB at the default page size: small enough to enforce the copy
# deadline promptly, large enough that the callback is not the bottleneck.
BACKUP_PAGES_PER_STEP = 4096
# select_for_role() filters slice_index.stem_type (there is no corpus.role table).
# idx_corpus_role is the covering map for that lookup plus the rms/path sort.
ROLE_INDEX_DDL = (
    "CREATE INDEX IF NOT EXISTS idx_corpus_role "
    "ON slice_index (stem_type, rms_db, file_path)",
    "CREATE INDEX IF NOT EXISTS idx_corpus_role_ml "
    "ON slice_index (stem_type_ml, rms_db)",
    "CREATE INDEX IF NOT EXISTS idx_corpus_role_filename "
    "ON slice_index (stem_type, filename)",
    # Tempo-window retrieval (engine.stem_retriever.build_stem_sql).
    "CREATE INDEX IF NOT EXISTS idx_slice_index_bpm "
    "ON slice_index (stem_type, estimated_bpm)",
)


def _as_uri(path: str, *, mode: str = "ro") -> str:
    posix = os.path.abspath(path).replace("\\", "/")
    if not posix.startswith("/"):
        posix = "/" + posix
    return f"file:{posix}?mode={mode}"


def live_index_path() -> str:
    return (os.environ.get("CORPUS_INDEX_LIVE") or "").strip() or DEFAULT_LIVE_INDEX


def _same_file(left: str, right: str) -> bool:
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(
        os.path.abspath(right)
    )


def is_source_index(path: str | None) -> bool:
    """True when ``path`` is the Learner/D: catalog the Worker must never open."""
    if not path:
        return False
    return any(_same_file(path, candidate) for candidate in (SOURCE_INDEX, FALLBACK_SOURCE))


def source_index_path() -> str:
    env = (os.environ.get("CORPUS_INDEX_DB") or "").strip()
    live = live_index_path()
    if env and os.path.isfile(env) and not _same_file(env, live) and not is_source_index(env):
        # A test / override catalog is fine. The D: source is never "the live DB".
        return env
    if os.path.isfile(SOURCE_INDEX):
        return SOURCE_INDEX
    if os.path.isfile(FALLBACK_SOURCE):
        return FALLBACK_SOURCE
    return SOURCE_INDEX


def resolve_worker_index(requested: str | None = None) -> str:
    """Worker catalog path. Never returns the D: source, even if asked."""
    if requested and os.path.isfile(requested) and not is_source_index(requested):
        return requested
    return refresh_live_index_replica()


def _enable_wal(path: str) -> None:
    conn = sqlite3.connect(path, timeout=5)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.commit()
    finally:
        conn.close()


# The D: catalog files corpus_4s\harmonic\ phrases as stem_type='vocal'. Every
# replica copy re-imports that, so the relabel runs on the C: replica each time.
FOLDER_STEM_RELABELS = (
    ("harmonic", "harmonic"),
    ("rhythm", "rhythm"),
    ("drums", "rhythm"),
    ("bass", "bass"),
)


def relabel_misfiled_vocals(conn: sqlite3.Connection) -> dict[str, int]:
    """Move ``stem_type='vocal'`` rows stored under instrument folders to that stem."""
    norm = "lower(replace(file_path, '/', '\\'))"
    moved: dict[str, int] = {}
    for folder, label in FOLDER_STEM_RELABELS:
        cur = conn.execute(
            f"UPDATE slice_index SET stem_type = ? WHERE stem_type = 'vocal' AND {norm} LIKE ?",
            (label, f"%\\{folder}\\%"),
        )
        if cur.rowcount:
            moved[folder] = int(cur.rowcount)
    return moved


def ensure_role_indexes(path: str | None = None) -> list[str]:
    """Build the role lookup map on the C: replica. Never opens the D: source."""
    dest = path or live_index_path()
    if not os.path.isfile(dest):
        raise FileNotFoundError(f"Live replica missing: {dest}")
    conn = sqlite3.connect(dest, timeout=30)
    built: list[str] = []
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        moved = relabel_misfiled_vocals(conn)
        if moved:
            print(f"[LIVE_INDEX] relabeled misfiled vocal rows {moved}", flush=True)
        for ddl in ROLE_INDEX_DDL:
            conn.execute(ddl)
            built.append(ddl.split("INDEX IF NOT EXISTS ", 1)[-1].split(" ", 1)[0])
        conn.execute("ANALYZE slice_index")
        conn.commit()
    finally:
        conn.close()
    print(f"[LIVE_INDEX] role indexes={','.join(built)} db={dest}", flush=True)
    return built


def _copy_file_timeout(src: str, dest: str, timeout_sec: int = COPY_TIMEOUT_SEC) -> None:
    import subprocess

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    try:
        completed = subprocess.run(
            ["cmd", "/c", "copy", "/y", src, dest],
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError(f"copy timed out after {timeout_sec}s: {src}") from exc
    if completed.returncode != 0 or not os.path.isfile(dest):
        raise OSError(
            (completed.stderr or completed.stdout or "copy failed").strip()[:300]
        )


def _source_fingerprint(src: str) -> str | None:
    """Identity of the source catalog: path, mtime in ns, byte size.

    Nanosecond mtime rather than whole seconds because an in-place relabel of
    the catalog keeps both the row count and the file size, leaving the mtime
    as the only signal that anything changed.
    """
    try:
        stat = os.stat(src)
    except OSError:
        return None
    return f"{os.path.normcase(os.path.abspath(src))}|{stat.st_mtime_ns}|{stat.st_size}"


def _read_stamp(path: str) -> list[str]:
    try:
        with open(path, encoding="utf-8") as handle:
            return [line.strip() for line in handle.read().splitlines()]
    except OSError:
        return []


def _write_stamp(path: str, *lines: str) -> None:
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines))
    except OSError:
        # A stamp that cannot be written only costs one redundant check.
        pass


def source_stamp_path(dest: str) -> str:
    """Provenance marker: which source fingerprint this replica was copied from."""
    return dest + ".source"


def _attempt_stamp_path(dest: str) -> str:
    return dest + ".attempt"


def source_changed(src: str, dest: str) -> bool:
    """True when ``src`` differs from the catalog ``dest`` was copied from.

    Staleness is answered from the provenance stamp, never from the replica's
    own mtime. ``ensure_role_indexes`` runs UPDATE / CREATE INDEX / ANALYZE on
    the replica on *every* refresh call, which rewrites the file and resets
    its mtime. Any rule of the form "is the replica recent?" therefore reports
    on the last render, not on the data, and pins the replica forever as long
    as renders happen more often than the question is asked.
    """
    fingerprint = _source_fingerprint(src)
    if fingerprint is None:
        return True
    stamp = _read_stamp(source_stamp_path(dest))
    if stamp and stamp[0]:
        return stamp[0] != fingerprint
    # No stamp: this replica predates provenance tracking, so adopt it when
    # the two files are the same size. That is the only honest evidence
    # available (the replica mtime says nothing about its origin), and it is
    # a one-time judgement: the exact fingerprint governs from here, so a
    # later rebuild or an in-place relabel of the same byte size still moves
    # the source mtime and is caught.
    try:
        return os.path.getsize(src) != os.path.getsize(dest)
    except OSError:
        return True


def _copy_cooling_off(dest: str, fingerprint: str | None) -> float:
    """Seconds left before retrying a copy of ``fingerprint`` that already failed.

    Without this, a source that is genuinely new but cannot be copied (D:
    locked, disk full) would restart a multi-hundred-megabyte transfer inside
    every single render. ``REFRESH_EVERY_SEC`` is the retry cadence.
    """
    if not fingerprint:
        return 0.0
    stamp = _read_stamp(_attempt_stamp_path(dest))
    if len(stamp) < 2 or stamp[1] != fingerprint:
        return 0.0
    try:
        elapsed = time.time() - float(stamp[0])
    except ValueError:
        return 0.0
    return max(0.0, REFRESH_EVERY_SEC - elapsed)


def _clear_copy_attempt(dest: str) -> None:
    try:
        os.remove(_attempt_stamp_path(dest))
    except OSError:
        pass


def _backup_with_deadline(
    src_conn: sqlite3.Connection,
    dst_conn: sqlite3.Connection,
    timeout_sec: float = COPY_TIMEOUT_SEC,
) -> None:
    """``Connection.backup`` with a transfer budget.

    A single-shot ``backup()`` cannot be abandoned — its ``timeout`` is a lock
    wait, not a transfer budget — and one render stalled 25 minutes on a
    0-byte .tmp while D: was under load, with the 900 s step timeout as the
    only backstop. Copying in page batches gives the progress callback
    somewhere to raise from, so a stalled transfer aborts inside the budget
    and the caller falls back to the replica already on disk.
    """
    deadline = time.monotonic() + float(timeout_sec)

    def _tick(_status: int, _remaining: int, _total: int) -> None:
        if time.monotonic() > deadline:
            raise TimeoutError(f"sqlite backup exceeded {timeout_sec:.0f}s")

    src_conn.backup(dst_conn, pages=BACKUP_PAGES_PER_STEP, progress=_tick)


def refresh_live_index_replica(*, force: bool = False) -> str:
    """Copy the D: catalog to C:\\live_web_outputs. Never opens it for write.

    The copy fires on one condition only: the source no longer matches the
    fingerprint the replica was built from. There is deliberately no "the
    replica is older than N hours" shortcut — see ``source_changed`` for why
    that question cannot be answered from the replica's mtime.
    """
    dest = live_index_path()
    os.makedirs(os.path.dirname(dest), exist_ok=True)

    src = source_index_path()
    if not os.path.isfile(src):
        if os.path.isfile(dest):
            ensure_role_indexes(dest)
            return dest
        raise FileNotFoundError(f"No corpus index at {src} and no live replica at {dest}")

    fingerprint = _source_fingerprint(src)
    if not force and os.path.isfile(dest):
        if not source_changed(src, dest):
            if not _read_stamp(source_stamp_path(dest)):
                # Adopting a pre-existing replica: record its provenance so
                # every later check is an exact comparison.
                print(
                    f"[LIVE_INDEX] adopting existing replica as a copy of {src} "
                    f"({os.path.getsize(dest)} bytes)",
                    flush=True,
                )
            _write_stamp(source_stamp_path(dest), fingerprint or "")
            age_days = max(0.0, (time.time() - os.path.getmtime(src)) / 86400.0)
            print(
                f"[LIVE_INDEX] source unchanged for {age_days:.1f}d; keeping replica {dest}",
                flush=True,
            )
            ensure_role_indexes(dest)
            return dest
        cooling = _copy_cooling_off(dest, fingerprint)
        if cooling > 0.0:
            print(
                f"[LIVE_INDEX] source changed but the last copy failed; "
                f"retrying in {cooling / 60.0:.0f} min, using existing {dest}",
                flush=True,
            )
            ensure_role_indexes(dest)
            return dest
        print(f"[LIVE_INDEX] source changed ({fingerprint}); refreshing replica", flush=True)

    tmp = dest + ".tmp"
    try:
        src_conn = sqlite3.connect(_as_uri(src, mode="ro"), uri=True, timeout=8)
        dst_conn = sqlite3.connect(tmp, timeout=8)
        try:
            _backup_with_deadline(src_conn, dst_conn)
        finally:
            dst_conn.close()
            src_conn.close()
        os.replace(tmp, dest)
        _write_stamp(source_stamp_path(dest), fingerprint or "")
        _clear_copy_attempt(dest)
        _enable_wal(dest)
        ensure_role_indexes(dest)
    except (sqlite3.Error, OSError, TimeoutError) as exc:
        if os.path.isfile(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        _write_stamp(_attempt_stamp_path(dest), str(time.time()), fingerprint or "")
        if os.path.isfile(dest):
            print(f"[LIVE_INDEX] replica refresh skipped ({exc}); using existing {dest}", flush=True)
            ensure_role_indexes(dest)
            return dest
        print(f"[LIVE_INDEX] sqlite backup failed ({exc}); timed copy fallback", flush=True)
        try:
            _copy_file_timeout(src, dest)
            _write_stamp(source_stamp_path(dest), fingerprint or "")
            _clear_copy_attempt(dest)
            _enable_wal(dest)
            ensure_role_indexes(dest)
        except (OSError, shutil.Error, TimeoutError) as copy_exc:
            if os.path.isfile(dest):
                print(
                    f"[LIVE_INDEX] copy fallback failed ({copy_exc}); using existing {dest}",
                    flush=True,
                )
                return dest
            raise
    print(
        f"[LIVE_INDEX] replica={dest} bytes={os.path.getsize(dest)} "
        f"source={src}",
        flush=True,
    )
    return dest


def get_db_connection(path: str | None = None) -> sqlite3.Connection:
    """Worker read path for the live corpus index.

    Always opens ``mode=ro`` with a 30s busy timeout so ingest/refresh writers
    on D: or replica maintenance never take a write lock from the API process.
    """
    dest = path or live_index_path()
    if not os.path.isfile(dest):
        raise FileNotFoundError(f"Live replica missing: {dest}")
    conn = sqlite3.connect(_as_uri(dest, mode="ro"), uri=True, timeout=30.0)
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA query_only = ON")
    return conn


def open_live_index(*, into_memory: bool = True) -> tuple[sqlite3.Connection, dict[str, Any]]:
    """Open the C: replica. Default: clone into :memory: so SELECT never hits disk."""
    path = refresh_live_index_replica()
    disk = get_db_connection(path)
    info: dict[str, Any] = {
        "path": path,
        "bytes": os.path.getsize(path) if os.path.isfile(path) else 0,
        "memory": bool(into_memory),
        "wal": True,
        "busy_timeout_ms": 30000,
        "mode": "ro",
    }
    if not into_memory:
        return disk, info
    mem = sqlite3.connect(":memory:")
    try:
        disk.backup(mem)
    finally:
        disk.close()
    row = mem.execute("SELECT COUNT(*) FROM slice_index").fetchone()
    info["rows"] = int(row[0]) if row else 0
    print(
        f"[LIVE_INDEX] RAM clone rows={info['rows']} from {path}",
        flush=True,
    )
    return mem, info
