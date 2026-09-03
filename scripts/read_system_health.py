"""Read-only master_ledger queue / mastered-today counts for admin health."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

DEFAULT_DB = os.environ.get("MASTER_CATALOG_DB", r"D:\MusicDatasets\database\master_catalog.db")


def _count(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> int:
    row = conn.execute(sql, params).fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def read_health(db_path: str) -> dict:
    if not os.path.isfile(db_path):
        return {
            "ok": False,
            "db": db_path,
            "db_reachable": False,
            "queued": None,
            "processing": None,
            "masters_today": None,
            "journal_mode": None,
            "error": "catalog db missing",
        }

    conn = sqlite3.connect(db_path, timeout=5)
    try:
        tables = {
            row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if "master_ledger" not in tables:
            return {
                "ok": False,
                "db": db_path,
                "db_reachable": True,
                "queued": None,
                "processing": None,
                "masters_today": None,
                "journal_mode": str(conn.execute("PRAGMA journal_mode").fetchone()[0]),
                "error": "master_ledger missing",
            }

        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        queued = _count(
            conn,
            "SELECT COUNT(*) FROM master_ledger WHERE upper(status) = 'QUEUED'",
        )
        processing = _count(
            conn,
            "SELECT COUNT(*) FROM master_ledger WHERE upper(status) IN ('PROCESSING', 'PENDING')",
        )
        masters_today = _count(
            conn,
            """
            SELECT COUNT(*) FROM master_ledger
            WHERE upper(status) = 'MASTERED' AND updated_at >= ?
            """,
            (cutoff,),
        )
        journal_mode = str(conn.execute("PRAGMA journal_mode").fetchone()[0])
        return {
            "ok": True,
            "db": db_path,
            "db_reachable": True,
            "queued": queued,
            "processing": processing,
            "masters_today": masters_today,
            "journal_mode": journal_mode,
            "error": None,
        }
    except sqlite3.Error as exc:
        return {
            "ok": False,
            "db": db_path,
            "db_reachable": False,
            "queued": None,
            "processing": None,
            "masters_today": None,
            "journal_mode": None,
            "error": str(exc),
        }
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=DEFAULT_DB)
    args = parser.parse_args()
    print(json.dumps(read_health(args.db)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
