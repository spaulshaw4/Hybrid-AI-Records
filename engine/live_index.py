"""Worker-only corpus index: static replica on C:, WAL, optional RAM clone.

The Learner and DSP lock pound D:\\. ``select_for_role`` must never open
``D:\\MusicDatasets\\db\\corpus_index.sqlite`` — that file lock is what hung
composition. The live API reads ``C:\\live_web_outputs\\db\\corpus_index_live.sqlite``
(or an in-memory clone of it) and never writes the Learner database.
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
# Refresh at most this often. Mid-job generates reuse the snapshot.
REFRESH_EVERY_SEC = 6 * 60 * 60
COPY_TIMEOUT_SEC = 90


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


def refresh_live_index_replica(*, force: bool = False) -> str:
    """Copy the D: catalog to C:\\live_web_outputs. Never opens it for write."""
    dest = live_index_path()
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if (
        not force
        and os.path.isfile(dest)
        and (time.time() - os.path.getmtime(dest)) < REFRESH_EVERY_SEC
    ):
        return dest

    src = source_index_path()
    if not os.path.isfile(src):
        if os.path.isfile(dest):
            return dest
        raise FileNotFoundError(f"No corpus index at {src} and no live replica at {dest}")

    tmp = dest + ".tmp"
    try:
        src_conn = sqlite3.connect(_as_uri(src, mode="ro"), uri=True, timeout=8)
        dst_conn = sqlite3.connect(tmp, timeout=8)
        try:
            src_conn.backup(dst_conn)
        finally:
            dst_conn.close()
            src_conn.close()
        os.replace(tmp, dest)
        _enable_wal(dest)
    except (sqlite3.Error, OSError, TimeoutError) as exc:
        if os.path.isfile(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        if os.path.isfile(dest):
            print(f"[LIVE_INDEX] replica refresh skipped ({exc}); using existing {dest}", flush=True)
            return dest
        print(f"[LIVE_INDEX] sqlite backup failed ({exc}); timed copy fallback", flush=True)
        try:
            _copy_file_timeout(src, dest)
            _enable_wal(dest)
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


def open_live_index(*, into_memory: bool = True) -> tuple[sqlite3.Connection, dict[str, Any]]:
    """Open the C: replica. Default: clone into :memory: so SELECT never hits disk."""
    path = refresh_live_index_replica()
    disk = sqlite3.connect(_as_uri(path, mode="ro"), uri=True, timeout=5)
    disk.execute("PRAGMA query_only=ON")
    info: dict[str, Any] = {
        "path": path,
        "bytes": os.path.getsize(path) if os.path.isfile(path) else 0,
        "memory": bool(into_memory),
        "wal": True,
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
