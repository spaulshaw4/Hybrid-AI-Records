"""Latest QC telemetry for the meters SSE gateway.

Prefers dsp_telemetry (init_master_schema.py) when rows exist, else
master_ledger peak/phase. These are session snapshots, not per-frame DSP IPC.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

DEFAULT_DB = os.environ.get("MASTER_CATALOG_DB", r"D:\MusicDatasets\database\master_catalog.db")


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
        (name,),
    ).fetchone()
    return row is not None


def from_dsp_telemetry(conn: sqlite3.Connection, session_id: str) -> dict | None:
    if not table_exists(conn, "dsp_telemetry"):
        return None
    params: tuple = ()
    where = "1=1"
    if session_id:
        where = "session_id = ?"
        params = (session_id,)
    row = conn.execute(
        f"""
        SELECT session_id, true_peak_dbtp, phase_correlation, integrated_rms_dbfs
        FROM dsp_telemetry
        WHERE {where}
        ORDER BY recorded_at DESC, id DESC
        LIMIT 1
        """,
        params,
    ).fetchone()
    if not row:
        return None
    peak = row[1]
    return {
        "source": "dsp_telemetry",
        "session_id": row[0],
        "left_peak": peak,
        "right_peak": peak,
        "true_peak": peak,
        "rms": row[3],
        "phase_correlation": row[2],
    }


def from_ledger(conn: sqlite3.Connection, session_id: str) -> dict:
    row = None
    try:
        if session_id:
            row = conn.execute(
                """
                SELECT session_id, true_peak_dbtp, phase_correlation
                FROM master_ledger WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
        if not row:
            row = conn.execute(
                """
                SELECT session_id, true_peak_dbtp, phase_correlation
                FROM master_ledger ORDER BY updated_at DESC LIMIT 1
                """
            ).fetchone()
    except sqlite3.Error:
        row = None
    peak = row[1] if row else None
    return {
        "source": "master_ledger",
        "session_id": (row[0] if row else session_id) or None,
        "left_peak": peak,
        "right_peak": peak,
        "true_peak": peak,
        "rms": None,
        "phase_correlation": row[2] if row else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id", default="")
    parser.add_argument("--db", default=DEFAULT_DB)
    args = parser.parse_args()

    payload = {
        "source": "none",
        "session_id": args.session_id or None,
        "left_peak": None,
        "right_peak": None,
        "true_peak": None,
        "rms": None,
        "phase_correlation": None,
    }
    if os.path.isfile(args.db):
        conn = sqlite3.connect(args.db, timeout=5)
        try:
            telemetry = from_dsp_telemetry(conn, args.session_id)
            payload = telemetry or from_ledger(conn, args.session_id)
        finally:
            conn.close()
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
