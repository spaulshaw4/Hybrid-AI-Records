"""Shared master_ledger schema helpers."""
from __future__ import annotations

import argparse
import sqlite3
from datetime import datetime, timedelta, timezone

LEDGER_DDL = """
CREATE TABLE IF NOT EXISTS master_ledger (
    session_id TEXT PRIMARY KEY,
    genre TEXT,
    s3_key TEXT,
    sha256_hash TEXT,
    true_peak_dbtp REAL,
    phase_correlation REAL,
    status TEXT,
    updated_at TEXT,
    slice_duration REAL
);
"""


def ensure_ledger(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(LEDGER_DDL)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(master_ledger)")}
    if "slice_duration" not in columns:
        conn.execute("ALTER TABLE master_ledger ADD COLUMN slice_duration REAL")


def _parse_updated_at(raw: object) -> datetime | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def mark_stale_processing_failed(conn: sqlite3.Connection, older_than_minutes: float) -> int:
    """Mark PROCESSING rows whose updated_at is older than N minutes as FAILED.

    Fresh PROCESSING rows are left alone. Unparseable timestamps are skipped.
    """
    ensure_ledger(conn)
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=max(0.0, float(older_than_minutes)))
    now = datetime.now(timezone.utc).isoformat()
    rows = conn.execute(
        "SELECT session_id, updated_at FROM master_ledger WHERE upper(status) = 'PROCESSING'"
    ).fetchall()
    changed = 0
    for session_id, updated_at in rows:
        parsed = _parse_updated_at(updated_at)
        if parsed is None or parsed > cutoff:
            continue
        conn.execute(
            "UPDATE master_ledger SET status = ?, updated_at = ? WHERE session_id = ?",
            ("FAILED", now, session_id),
        )
        changed += 1
    return changed


def wal_checkpoint_truncate(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Ledger helpers used by emergency_rollback.ps1")
    parser.add_argument("--db", required=True)
    parser.add_argument("--stale-minutes", type=float, default=45)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    conn = sqlite3.connect(args.db, timeout=15)
    try:
        ensure_ledger(conn)
        if args.dry_run:
            rows = conn.execute(
                "SELECT session_id, updated_at FROM master_ledger WHERE upper(status) = 'PROCESSING'"
            ).fetchall()
            print(f"SCAND {len(rows)} PROCESSING row(s); stale-only update skipped (dry-run)")
        else:
            marked = mark_stale_processing_failed(conn, args.stale_minutes)
            wal_checkpoint_truncate(conn)
            conn.commit()
            print(f"MARKED {marked}")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
