"""Print JSON status for a master session from ledger + local deliverables."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

DEFAULT_DB = os.environ.get("MASTER_CATALOG_DB", r"D:\MusicDatasets\database\master_catalog.db")
BASE = os.environ.get("MUSICDATASETS_ROOT", r"D:\MusicDatasets")


def first_existing(*paths: str) -> str | None:
    for path in paths:
        if path and os.path.isfile(path):
            return path
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id", default="")
    parser.add_argument("--latest", action="store_true")
    parser.add_argument("--db", default=DEFAULT_DB)
    args = parser.parse_args()

    row = None
    active = 0
    if os.path.isfile(args.db):
        conn = sqlite3.connect(args.db, timeout=5)
        try:
            active_row = conn.execute(
                "SELECT COUNT(*) FROM master_ledger WHERE upper(status) IN ('PROCESSING','PENDING','QUEUED')"
            ).fetchone()
            active = int(active_row[0]) if active_row else 0
            if args.latest:
                row = conn.execute(
                    """
                    SELECT session_id, genre, true_peak_dbtp, phase_correlation, status, updated_at
                    FROM master_ledger ORDER BY updated_at DESC LIMIT 1
                    """
                ).fetchone()
            elif args.session_id:
                row = conn.execute(
                    """
                    SELECT session_id, genre, true_peak_dbtp, phase_correlation, status, updated_at
                    FROM master_ledger WHERE session_id = ?
                    """,
                    (args.session_id,),
                ).fetchone()
        finally:
            conn.close()

    session_id = args.session_id or (row[0] if row else "")
    raw = first_existing(
        os.path.join(BASE, "scratch", session_id, "unmastered_mix.wav"),
        os.path.join(BASE, "scratch", session_id, "premix.wav"),
    ) if session_id else None
    master = first_existing(
        os.path.join(BASE, "releases", session_id, "master_output.wav"),
        os.path.join(BASE, "scratch", session_id, "master_output.wav"),
    ) if session_id else None

    status = row[4] if row else ("MASTERED" if master else "UNKNOWN")
    print(
        json.dumps(
            {
                "session_id": session_id or None,
                "genre": row[1] if row else None,
                "true_peak_dbtp": row[2] if row else None,
                "phase_correlation": row[3] if row else None,
                "status": status,
                "updated_at": row[5] if row else None,
                "raw_ready": bool(raw),
                "master_ready": bool(master),
                "raw_rel": os.path.relpath(raw, BASE).replace("\\", "/") if raw else None,
                "master_rel": os.path.relpath(master, BASE).replace("\\", "/") if master else None,
                "active_jobs": active,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
