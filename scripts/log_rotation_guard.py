"""Hourly NSSM log rotation + SQLite WAL checkpoint.

Canonical operator path is daemons/log_rotation_guard.py. This copy is what
deploy_to_workstation.ps1 installs under D:\\MusicDatasets\\scripts.
"""
from __future__ import annotations

import gzip
import os
import shutil
import sqlite3
import sys
import time

LOG_DIRS = [
    os.environ.get("HYBRID_LOG_DIR", r"D:\MusicDatasets\logs"),
    r"D:\MusicDatasets\monitoring\logs",
]
DB_PATH = os.environ.get("MASTER_CATALOG_DB", r"D:\MusicDatasets\database\master_catalog.db")
MAX_LOG_SIZE_MB = float(os.environ.get("HYBRID_MAX_LOG_MB", "50"))
INTERVAL_SEC = int(os.environ.get("HYBRID_LOG_GUARD_INTERVAL", "3600"))
KEEP_ARCHIVES = 8


def rotate_logs() -> None:
    for log_dir in LOG_DIRS:
        if not os.path.isdir(log_dir):
            continue
        for name in os.listdir(log_dir):
            if not name.lower().endswith(".log"):
                continue
            log_file = os.path.join(log_dir, name)
            try:
                size_mb = os.path.getsize(log_file) / (1024 * 1024)
                if size_mb <= MAX_LOG_SIZE_MB:
                    continue
                timestamp = int(time.time())
                archived_log = f"{log_file}.{timestamp}.gz"
                print(f"[*] Compressing {log_file} ({size_mb:.2f} MB)...")
                with open(log_file, "rb") as f_in, gzip.open(archived_log, "wb") as f_out:
                    shutil.copyfileobj(f_in, f_out)
                with open(log_file, "r+b") as handle:
                    handle.truncate(0)
                print(f"[ROTATED] Archived to {archived_log}")
                prune_archives(log_file)
            except OSError as err:
                print(f"[LOG ROTATION ERROR] {log_file}: {err}")


def prune_archives(log_file: str) -> None:
    folder = os.path.dirname(log_file)
    prefix = log_file + "."
    archives = sorted(
        os.path.join(folder, name)
        for name in os.listdir(folder)
        if name.endswith(".gz") and os.path.join(folder, name).startswith(prefix)
    )
    extra = archives[:-KEEP_ARCHIVES] if len(archives) > KEEP_ARCHIVES else []
    for path in extra:
        try:
            os.remove(path)
        except OSError:
            pass


def vacuum_sqlite_wal() -> None:
    if not os.path.exists(DB_PATH):
        return
    try:
        conn = sqlite3.connect(DB_PATH, timeout=15)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.execute("PRAGMA optimize")
        finally:
            conn.close()
        print("[SQLITE WAL] Checkpoint and optimize completed.")
    except Exception as err:
        print(f"[SQLITE WAL ERROR] {err}")


def run_once() -> None:
    rotate_logs()
    vacuum_sqlite_wal()


if __name__ == "__main__":
    once = "--once" in sys.argv
    print("[*] Log Rotation & DB Maintenance Daemon Active...")
    if once:
        run_once()
        sys.exit(0)
    while True:
        run_once()
        time.sleep(INTERVAL_SEC)
