"""Durable ledger for the bulk 4s slicing campaign.

Lives in the same SQLite file as the corpus index
(``D:\\MusicDatasets\\db\\corpus_index.sqlite``) but only ever touches its own
``campaign_*`` tables plus ``oneshot_index``. ``slice_index``, ``slice_history``
and ``pack_manifest`` belong to the indexer and are never read or written here.

The index job writes to that database concurrently, so every connection opens
in WAL with a long ``busy_timeout`` and every write goes through ``_retry``,
which backs off on ``database is locked`` instead of losing the row.

Only the parent process writes to the ledger. Pool workers return results; the
driver records them. That keeps a single writer on our side of the file.
"""
from __future__ import annotations

import os
import random
import sqlite3
import time
from typing import Any, Iterable, Sequence

DEFAULT_DB = r"D:\MusicDatasets\db\corpus_index.sqlite"
DEFAULT_CAMPAIGN = "corpus_4s_bulk"
BUSY_TIMEOUT_MS = 30_000
LOCK_RETRIES = 8
STALE_CLAIM_SEC = 3600.0

STATUS_PENDING = "PENDING"
STATUS_IN_PROGRESS = "IN_PROGRESS"
STATUS_DONE = "DONE"
STATUS_FAILED = "FAILED"
STATUS_SKIPPED = "SKIPPED"
TERMINAL_STATUSES = (STATUS_DONE, STATUS_SKIPPED)

KIND_PHRASE = "phrase"
KIND_ONESHOT = "oneshot"

SOURCES_DDL = """
CREATE TABLE IF NOT EXISTS campaign_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_path TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'phrase',
    status TEXT NOT NULL DEFAULT 'PENDING',
    total_files INTEGER NOT NULL DEFAULT 0,
    bytes_total INTEGER NOT NULL DEFAULT 0,
    est_slices INTEGER NOT NULL DEFAULT 0,
    est_output_bytes INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0,
    UNIQUE (campaign, source_path)
);
"""

FILES_DDL = """
CREATE TABLE IF NOT EXISTS campaign_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign TEXT NOT NULL,
    source_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_format TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING',
    layer TEXT NOT NULL DEFAULT '',
    slices_written INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    claimed_at REAL NOT NULL DEFAULT 0,
    finished_at REAL NOT NULL DEFAULT 0,
    created_at REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0,
    UNIQUE (campaign, file_path)
);
"""

RUNS_DDL = """
CREATE TABLE IF NOT EXISTS campaign_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign TEXT NOT NULL,
    pid INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'dry-run',
    workers INTEGER NOT NULL DEFAULT 0,
    started_at REAL NOT NULL DEFAULT 0,
    heartbeat_at REAL NOT NULL DEFAULT 0,
    finished_at REAL NOT NULL DEFAULT 0,
    files_done INTEGER NOT NULL DEFAULT 0,
    slices_written INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT ''
);
"""

ONESHOT_INDEX_DDL = """
CREATE TABLE IF NOT EXISTS oneshot_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE,
    source_path TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'other',
    duration_sec REAL NOT NULL DEFAULT 0,
    peak REAL NOT NULL DEFAULT 0,
    rms_db REAL NOT NULL DEFAULT 0,
    spectral_centroid REAL NOT NULL DEFAULT 0,
    pitch_hz REAL NOT NULL DEFAULT 0,
    created_at REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0
);
"""

INDEX_DDL = (
    "CREATE INDEX IF NOT EXISTS idx_campaign_files_status "
    "ON campaign_files (campaign, status);",
    "CREATE INDEX IF NOT EXISTS idx_campaign_files_source "
    "ON campaign_files (campaign, source_name, status);",
    "CREATE INDEX IF NOT EXISTS idx_campaign_sources_status "
    "ON campaign_sources (campaign, status);",
    "CREATE INDEX IF NOT EXISTS idx_oneshot_category "
    "ON oneshot_index (category);",
)


class LedgerError(RuntimeError):
    """Ledger could not be opened or written."""


def _now() -> float:
    return time.time()


def _retry(fn, *args, **kwargs):
    """Run a SQLite call, backing off while the indexer holds the write lock."""
    last: Exception | None = None
    for attempt in range(LOCK_RETRIES):
        try:
            return fn(*args, **kwargs)
        except sqlite3.OperationalError as exc:
            message = str(exc).lower()
            if "locked" not in message and "busy" not in message:
                raise
            last = exc
            time.sleep(min(2.0, (0.1 * (2**attempt)) + random.uniform(0.0, 0.1)))
    raise LedgerError(f"SQLite stayed locked after {LOCK_RETRIES} attempts: {last}")


def connect(db_path: str = DEFAULT_DB, *, read_only: bool = False) -> sqlite3.Connection:
    """Open the shared index database in WAL with a long busy timeout."""
    parent = os.path.dirname(os.path.abspath(db_path))
    if parent and not read_only:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(
        db_path,
        timeout=BUSY_TIMEOUT_MS / 1000.0,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    if not read_only:
        # WAL is already on for this file; setting it is idempotent and makes a
        # fresh test database behave like production.
        try:
            _retry(conn.execute, "PRAGMA journal_mode=WAL")
        except LedgerError:
            pass
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_ledger(conn: sqlite3.Connection) -> None:
    """Create the campaign tables. Never touches the indexer's tables."""
    _retry(conn.execute, SOURCES_DDL)
    _retry(conn.execute, FILES_DDL)
    _retry(conn.execute, RUNS_DDL)
    _retry(conn.execute, ONESHOT_INDEX_DDL)
    for stmt in INDEX_DDL:
        _retry(conn.execute, stmt)
    _retry(conn.commit)


def open_ledger(db_path: str = DEFAULT_DB) -> sqlite3.Connection:
    conn = connect(db_path)
    init_ledger(conn)
    return conn


def register_source(
    conn: sqlite3.Connection,
    *,
    campaign: str,
    source_name: str,
    source_path: str,
    kind: str = KIND_PHRASE,
    total_files: int = 0,
    bytes_total: int = 0,
    est_slices: int = 0,
    est_output_bytes: int = 0,
    status: str = STATUS_PENDING,
    note: str = "",
) -> None:
    """Insert or refresh one source-tree row. Existing status is preserved."""
    now = _now()
    _retry(
        conn.execute,
        """
        INSERT INTO campaign_sources
            (campaign, source_name, source_path, kind, status, total_files,
             bytes_total, est_slices, est_output_bytes, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (campaign, source_path) DO UPDATE SET
            source_name = excluded.source_name,
            kind = excluded.kind,
            total_files = excluded.total_files,
            bytes_total = excluded.bytes_total,
            est_slices = excluded.est_slices,
            est_output_bytes = excluded.est_output_bytes,
            note = excluded.note,
            updated_at = excluded.updated_at
        """,
        (
            campaign,
            source_name,
            source_path,
            kind,
            status,
            int(total_files),
            int(bytes_total),
            int(est_slices),
            int(est_output_bytes),
            note,
            now,
            now,
        ),
    )
    _retry(conn.commit)


def set_source_status(
    conn: sqlite3.Connection,
    *,
    campaign: str,
    source_path: str,
    status: str,
    note: str = "",
) -> None:
    _retry(
        conn.execute,
        "UPDATE campaign_sources SET status = ?, note = ?, updated_at = ? "
        "WHERE campaign = ? AND source_path = ?",
        (status, note, _now(), campaign, source_path),
    )
    _retry(conn.commit)


def register_files(
    conn: sqlite3.Connection,
    campaign: str,
    source_name: str,
    entries: Sequence[tuple[str, str, int]],
) -> int:
    """Enqueue ``(file_path, file_format, size_bytes)`` rows.

    Already-known files keep their status, so a re-scan after new material
    lands adds only the new work.
    """
    if not entries:
        return 0
    now = _now()
    rows = [
        (campaign, source_name, path, fmt, int(size), STATUS_PENDING, now, now)
        for path, fmt, size in entries
    ]
    cur = conn.cursor()
    _retry(
        cur.executemany,
        """
        INSERT INTO campaign_files
            (campaign, source_name, file_path, file_format, size_bytes,
             status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (campaign, file_path) DO NOTHING
        """,
        rows,
    )
    inserted = int(cur.rowcount or 0)
    _retry(conn.commit)
    return inserted


def requeue_stale(
    conn: sqlite3.Connection,
    campaign: str,
    *,
    max_age_sec: float = STALE_CLAIM_SEC,
) -> int:
    """Return abandoned IN_PROGRESS claims to PENDING after a crash or reboot.

    A killed run leaves rows claimed. Without this, resume would stall on work
    nobody owns.
    """
    cutoff = _now() - float(max_age_sec)
    cur = conn.cursor()
    _retry(
        cur.execute,
        "UPDATE campaign_files SET status = ?, error = '', updated_at = ? "
        "WHERE campaign = ? AND status = ? AND claimed_at <= ?",
        (STATUS_PENDING, _now(), campaign, STATUS_IN_PROGRESS, cutoff),
    )
    changed = int(cur.rowcount or 0)
    _retry(conn.commit)
    return changed


def reset_failed(conn: sqlite3.Connection, campaign: str, source_name: str = "") -> int:
    """Put FAILED rows back in the queue for an explicit retry pass."""
    params: list[Any] = [_now(), campaign, STATUS_FAILED]
    sql = (
        "UPDATE campaign_files SET status = 'PENDING', error = '', updated_at = ? "
        "WHERE campaign = ? AND status = ?"
    )
    if source_name:
        sql += " AND source_name = ?"
        params.append(source_name)
    cur = conn.cursor()
    _retry(cur.execute, sql, tuple(params))
    changed = int(cur.rowcount or 0)
    _retry(conn.commit)
    return changed


def peek_pending(
    conn: sqlite3.Connection,
    campaign: str,
    *,
    limit: int,
    source_name: str = "",
    offset: int = 0,
) -> list[sqlite3.Row]:
    """Read PENDING rows without claiming them.

    Dry-run uses this so a preview cannot mark files DONE and block a later
    ``-Execute`` pass. ``offset`` walks past rows already previewed in this run.
    """
    if limit <= 0:
        return []
    sql = (
        "SELECT id, file_path, file_format, size_bytes, source_name "
        "FROM campaign_files WHERE campaign = ? AND status = ?"
    )
    params: list[Any] = [campaign, STATUS_PENDING]
    if source_name:
        sql += " AND source_name = ?"
        params.append(source_name)
    sql += " ORDER BY id LIMIT ? OFFSET ?"
    params.append(int(limit))
    params.append(max(0, int(offset)))
    return list(_retry(conn.execute, sql, tuple(params)).fetchall())


def claim_batch(
    conn: sqlite3.Connection,
    campaign: str,
    *,
    limit: int,
    source_name: str = "",
) -> list[sqlite3.Row]:
    """Take up to ``limit`` PENDING rows and mark them IN_PROGRESS.

    DONE and SKIPPED rows are invisible here, which is what makes a re-run
    resume instead of restarting.
    """
    if limit <= 0:
        return []
    rows = peek_pending(conn, campaign, limit=limit, source_name=source_name)
    if not rows:
        return []
    now = _now()
    _retry(
        conn.executemany,
        "UPDATE campaign_files SET status = ?, claimed_at = ?, updated_at = ?, "
        "attempts = attempts + 1 WHERE id = ?",
        [(STATUS_IN_PROGRESS, now, now, int(r["id"])) for r in rows],
    )
    _retry(conn.commit)
    return rows


def upsert_oneshot(
    conn: sqlite3.Connection,
    *,
    file_path: str,
    source_path: str,
    category: str,
    duration_sec: float = 0.0,
    peak: float = 0.0,
    rms_db: float = 0.0,
    spectral_centroid: float = 0.0,
    pitch_hz: float = 0.0,
) -> None:
    """Record one copied one-shot. Never writes ``slice_index``."""
    now = _now()
    _retry(
        conn.execute,
        """
        INSERT INTO oneshot_index
            (file_path, source_path, category, duration_sec, peak, rms_db,
             spectral_centroid, pitch_hz, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (file_path) DO UPDATE SET
            source_path = excluded.source_path,
            category = excluded.category,
            duration_sec = excluded.duration_sec,
            peak = excluded.peak,
            rms_db = excluded.rms_db,
            spectral_centroid = excluded.spectral_centroid,
            pitch_hz = excluded.pitch_hz,
            updated_at = excluded.updated_at
        """,
        (
            file_path,
            source_path,
            category,
            float(duration_sec),
            float(peak),
            float(rms_db),
            float(spectral_centroid),
            float(pitch_hz),
            now,
            now,
        ),
    )
    _retry(conn.commit)


def record_result(
    conn: sqlite3.Connection,
    *,
    campaign: str,
    file_path: str,
    status: str,
    slices_written: int = 0,
    layer: str = "",
    error: str = "",
) -> None:
    """Write one terminal outcome. A failure is data, not a crash."""
    now = _now()
    _retry(
        conn.execute,
        "UPDATE campaign_files SET status = ?, slices_written = ?, layer = ?, "
        "error = ?, finished_at = ?, updated_at = ? "
        "WHERE campaign = ? AND file_path = ?",
        (
            status,
            int(slices_written),
            layer,
            str(error)[:2000],
            now,
            now,
            campaign,
            file_path,
        ),
    )
    _retry(conn.commit)


def record_results(
    conn: sqlite3.Connection,
    campaign: str,
    results: Iterable[dict[str, Any]],
) -> int:
    """Batch form of ``record_result`` for one Pool drain."""
    now = _now()
    rows = [
        (
            str(res.get("status") or STATUS_DONE),
            int(res.get("slices_written") or 0),
            str(res.get("layer") or ""),
            str(res.get("error") or "")[:2000],
            now,
            now,
            campaign,
            str(res.get("file_path") or ""),
        )
        for res in results
    ]
    if not rows:
        return 0
    _retry(
        conn.executemany,
        "UPDATE campaign_files SET status = ?, slices_written = ?, layer = ?, "
        "error = ?, finished_at = ?, updated_at = ? "
        "WHERE campaign = ? AND file_path = ?",
        rows,
    )
    _retry(conn.commit)
    return len(rows)


def start_run(
    conn: sqlite3.Connection,
    *,
    campaign: str,
    mode: str,
    workers: int,
    note: str = "",
) -> int:
    now = _now()
    cur = conn.cursor()
    _retry(
        cur.execute,
        "INSERT INTO campaign_runs (campaign, pid, mode, workers, started_at, "
        "heartbeat_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (campaign, os.getpid(), mode, int(workers), now, now, note),
    )
    _retry(conn.commit)
    return int(cur.lastrowid or 0)


def heartbeat_run(
    conn: sqlite3.Connection,
    run_id: int,
    *,
    files_done: int,
    slices_written: int,
) -> None:
    _retry(
        conn.execute,
        "UPDATE campaign_runs SET heartbeat_at = ?, files_done = ?, "
        "slices_written = ? WHERE id = ?",
        (_now(), int(files_done), int(slices_written), int(run_id)),
    )
    _retry(conn.commit)


def finish_run(
    conn: sqlite3.Connection,
    run_id: int,
    *,
    files_done: int,
    slices_written: int,
    note: str = "",
) -> None:
    now = _now()
    _retry(
        conn.execute,
        "UPDATE campaign_runs SET finished_at = ?, heartbeat_at = ?, files_done = ?, "
        "slices_written = ?, note = ? WHERE id = ?",
        (now, now, int(files_done), int(slices_written), note, int(run_id)),
    )
    _retry(conn.commit)


def status_counts(
    conn: sqlite3.Connection,
    campaign: str,
    source_name: str = "",
) -> dict[str, int]:
    sql = "SELECT status, COUNT(*) AS n FROM campaign_files WHERE campaign = ?"
    params: list[Any] = [campaign]
    if source_name:
        sql += " AND source_name = ?"
        params.append(source_name)
    sql += " GROUP BY status"
    counts = {
        STATUS_PENDING: 0,
        STATUS_IN_PROGRESS: 0,
        STATUS_DONE: 0,
        STATUS_FAILED: 0,
        STATUS_SKIPPED: 0,
    }
    for row in _retry(conn.execute, sql, tuple(params)).fetchall():
        counts[str(row["status"])] = int(row["n"])
    return counts


def campaign_progress(
    conn: sqlite3.Connection,
    campaign: str,
    source_name: str = "",
) -> dict[str, Any]:
    """Everything the one-line status command needs: percent, rate, ETA."""
    counts = status_counts(conn, campaign, source_name)
    total = sum(counts.values())
    settled = counts[STATUS_DONE] + counts[STATUS_SKIPPED] + counts[STATUS_FAILED]
    remaining = counts[STATUS_PENDING] + counts[STATUS_IN_PROGRESS]

    agg_sql = (
        "SELECT COALESCE(SUM(slices_written), 0) AS slices, "
        "COALESCE(SUM(size_bytes), 0) AS bytes_all, "
        "COALESCE(SUM(CASE WHEN status IN ('DONE','SKIPPED') THEN size_bytes ELSE 0 END), 0) "
        "AS bytes_settled FROM campaign_files WHERE campaign = ?"
    )
    params: list[Any] = [campaign]
    if source_name:
        agg_sql += " AND source_name = ?"
        params.append(source_name)
    agg = _retry(conn.execute, agg_sql, tuple(params)).fetchone()

    rate = _measured_rate(conn, campaign)
    eta_sec = (remaining / rate) if (rate > 0 and remaining) else 0.0

    return {
        "campaign": campaign,
        "source": source_name,
        "total_files": total,
        "counts": counts,
        "settled": settled,
        "remaining": remaining,
        "percent": (100.0 * settled / total) if total else 0.0,
        "slices_written": int(agg["slices"]) if agg else 0,
        "bytes_total": int(agg["bytes_all"]) if agg else 0,
        "bytes_settled": int(agg["bytes_settled"]) if agg else 0,
        "files_per_sec": rate,
        "eta_sec": eta_sec,
    }


def _measured_rate(conn: sqlite3.Connection, campaign: str) -> float:
    """Files/second measured from live-mode runs that actually did work."""
    rows = _retry(
        conn.execute,
        "SELECT started_at, heartbeat_at, finished_at, files_done FROM campaign_runs "
        "WHERE campaign = ? AND mode = 'execute' AND files_done > 0 "
        "ORDER BY id DESC LIMIT 10",
        (campaign,),
    ).fetchall()
    total_files = 0.0
    total_sec = 0.0
    for row in rows:
        end = float(row["finished_at"] or row["heartbeat_at"] or 0.0)
        start = float(row["started_at"] or 0.0)
        elapsed = end - start
        if elapsed <= 0.0:
            continue
        total_files += float(row["files_done"])
        total_sec += elapsed
    if total_sec <= 0.0:
        return 0.0
    return total_files / total_sec


def source_rows(conn: sqlite3.Connection, campaign: str) -> list[sqlite3.Row]:
    return list(
        _retry(
            conn.execute,
            "SELECT * FROM campaign_sources WHERE campaign = ? ORDER BY source_name",
            (campaign,),
        ).fetchall()
    )


def recent_failures(
    conn: sqlite3.Connection,
    campaign: str,
    limit: int = 10,
) -> list[sqlite3.Row]:
    return list(
        _retry(
            conn.execute,
            "SELECT file_path, error FROM campaign_files "
            "WHERE campaign = ? AND status = ? ORDER BY updated_at DESC LIMIT ?",
            (campaign, STATUS_FAILED, int(limit)),
        ).fetchall()
    )


def format_duration(seconds: float) -> str:
    total = int(max(0.0, float(seconds)))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}h{minutes:02d}m"
    if minutes:
        return f"{minutes}m{secs:02d}s"
    return f"{secs}s"


def format_bytes(num: float) -> str:
    value = float(num)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(value) < 1024.0 or unit == "TB":
            return f"{value:.1f} {unit}"
        value /= 1024.0
    return f"{value:.1f} TB"
