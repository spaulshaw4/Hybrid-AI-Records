"""Claim QUEUED sqlite sessions and dispatch run_master_pipeline.ps1."""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)
from ledger_schema import ensure_ledger  # noqa: E402

DB_PATH = os.environ.get("MASTER_CATALOG_DB", r"D:\MusicDatasets\database\master_catalog.db")
POWERSHELL_PATH = os.environ.get(
    "HYBRID_POWERSHELL",
    r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
)
BASE_DIR = os.environ.get("MUSICDATASETS_ROOT", r"D:\MusicDatasets")
ORCHESTRATOR_SCRIPT = os.path.join(BASE_DIR, "scripts", "run_master_pipeline.ps1")
IDLE_SLEEP = float(os.environ.get("HYBRID_QUEUE_IDLE_SEC", "5"))
BUSY_SLEEP = float(os.environ.get("HYBRID_QUEUE_BUSY_SEC", "1"))
THROTTLE_PATH = os.environ.get(
    "HYBRID_THROTTLE_FILE",
    os.path.join(BASE_DIR, "config", "throttle.json"),
)
THROTTLE_SLEEP = float(os.environ.get("HYBRID_THROTTLE_SLEEP_SEC", "15"))


def throttle_active(path: str = THROTTLE_PATH) -> bool:
    """Honor hardware_thermal_guard.py flag file. Missing/invalid = not throttled."""
    if not os.path.isfile(path):
        return False
    try:
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError, TypeError):
        return False
    return bool(payload.get("throttled"))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def claim_next_job(db_path: str) -> tuple[str, str, float] | None:
    conn = sqlite3.connect(db_path, timeout=15)
    try:
        ensure_ledger(conn)
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """
            SELECT session_id, genre, slice_duration
            FROM master_ledger
            WHERE upper(status) = 'QUEUED'
            ORDER BY updated_at ASC
            LIMIT 1
            """
        ).fetchone()
        if not row:
            conn.rollback()
            return None
        session_id, genre, slice_duration = row
        conn.execute(
            """
            UPDATE master_ledger
            SET status = 'PROCESSING', updated_at = ?
            WHERE session_id = ? AND upper(status) = 'QUEUED'
            """,
            (utc_now(), session_id),
        )
        if conn.total_changes != 1:
            conn.rollback()
            return None
        conn.commit()
        return session_id, genre or "dark_techno", float(slice_duration or 4.0)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def mark_status(db_path: str, session_id: str, status: str) -> None:
    conn = sqlite3.connect(db_path, timeout=15)
    try:
        ensure_ledger(conn)
        conn.execute(
            "UPDATE master_ledger SET status = ?, updated_at = ? WHERE session_id = ?",
            (status, utc_now(), session_id),
        )
        conn.commit()
    finally:
        conn.close()


def dispatch_pipeline(session_id: str, genre: str, slice_duration: float) -> int:
    if not os.path.isfile(ORCHESTRATOR_SCRIPT):
        print(f"[ERROR] Missing orchestrator: {ORCHESTRATOR_SCRIPT}", file=sys.stderr)
        return 2
    cmd = [
        POWERSHELL_PATH,
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ORCHESTRATOR_SCRIPT,
        "-SessionId",
        session_id,
        "-GenreLock",
        genre,
        "-SliceDuration",
        str(slice_duration),
    ]
    print(f"[*] Starting async worker pipeline for session: {session_id} [{genre}]...")
    result = subprocess.run(cmd, check=False)
    return int(result.returncode)


def process_next_queued_job(db_path: str = DB_PATH) -> bool:
    if throttle_active():
        print("[THROTTLE] hardware_thermal_guard flag is set; not claiming jobs")
        return False
    try:
        job = claim_next_job(db_path)
        if not job:
            return False
        session_id, genre, slice_duration = job
        code = dispatch_pipeline(session_id, genre, slice_duration)
        if code == 0:
            print(f"[SUCCESS] Worker completed session: {session_id}")
            return True
        print(f"[ERROR] Worker failed for {session_id} exit={code}", file=sys.stderr)
        mark_status(db_path, session_id, "FAILED")
        return True
    except Exception as exc:
        print(f"[QUEUE WORKER EXCEPTION] {exc}", file=sys.stderr)
        return False


if __name__ == "__main__":
    once = "--once" in sys.argv
    print("[*] Master Queue Worker Daemon active. Polling for audio sessions...")
    if once:
        process_next_queued_job()
        sys.exit(0)
    while True:
        if throttle_active():
            print("[THROTTLE] waiting for thermal flag to clear")
            time.sleep(THROTTLE_SLEEP)
            continue
        had_job = process_next_queued_job()
        time.sleep(BUSY_SLEEP if had_job else IDLE_SLEEP)
