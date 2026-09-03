"""Catalog health sentinel. Logs CRITICAL and writes a flag; never rolls back.

Canonical operator path is daemons/db_sentinel.py. This copy is what
deploy_to_workstation.ps1 installs under D:\\MusicDatasets\\scripts.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

# Do not invoke emergency_rollback.ps1 from this process. A corrupt or missing
# catalog is signaled with a CRITICAL log line and a flag file only.

INTERVAL_SEC = int(os.environ.get("HYBRID_DB_SENTINEL_INTERVAL", "300"))
DEFAULT_DB = os.environ.get("MASTER_CATALOG_DB", r"D:\MusicDatasets\database\master_catalog.db")
DEFAULT_FLAG = os.environ.get(
    "HYBRID_SENTINEL_FLAG",
    r"D:\MusicDatasets\logs\db_sentinel.CRITICAL",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (name,),
    ).fetchone()
    return row is not None


def write_flag(flag_path: str, reason: str) -> None:
    parent = os.path.dirname(os.path.abspath(flag_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(flag_path, "w", encoding="utf-8") as handle:
        handle.write(f"{utc_now()}\nCRITICAL {reason}\n")


def clear_flag(flag_path: str) -> None:
    try:
        if os.path.isfile(flag_path):
            os.remove(flag_path)
    except OSError:
        pass


def find_orphans(conn: sqlite3.Connection) -> list[str]:
    if not table_exists(conn, "stream_catalog") or not table_exists(conn, "master_ledger"):
        return []
    rows = conn.execute(
        """
        SELECT sc.track_id
        FROM stream_catalog sc
        LEFT JOIN master_ledger ml
          ON ml.session_id = sc.track_id AND upper(ml.status) = 'MASTERED'
        WHERE ml.session_id IS NULL
        """
    ).fetchall()
    return [str(row[0]) for row in rows if row and row[0]]


def repair_orphans(conn: sqlite3.Connection, track_ids: list[str]) -> int:
    if not track_ids:
        return 0
    for track_id in track_ids:
        conn.execute("DELETE FROM stream_catalog WHERE track_id = ?", (track_id,))
    conn.commit()
    return len(track_ids)


def inspect_catalog(db_path: str, *, repair: bool = False) -> dict:
    report: dict = {
        "db": db_path,
        "ok": False,
        "critical": False,
        "reason": "",
        "orphans": [],
        "repaired": 0,
        "wal_checkpoint": False,
        "integrity": None,
    }
    if not os.path.isfile(db_path):
        report["critical"] = True
        report["reason"] = "catalog_missing"
        return report

    try:
        conn = sqlite3.connect(db_path, timeout=15)
    except sqlite3.Error as exc:
        report["critical"] = True
        report["reason"] = f"connect_failed:{exc}"
        return report

    try:
        conn.execute("PRAGMA journal_mode=WAL")
        integrity = str(conn.execute("PRAGMA integrity_check").fetchone()[0])
        report["integrity"] = integrity
        if integrity.lower() != "ok":
            report["critical"] = True
            report["reason"] = "integrity_check_failed"
            return report
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            report["wal_checkpoint"] = True
        except sqlite3.Error as exc:
            print(f"[WARN] wal_checkpoint: {exc}")
        orphans = find_orphans(conn)
        report["orphans"] = orphans
        if repair and orphans:
            report["repaired"] = repair_orphans(conn, orphans)
            report["orphans"] = find_orphans(conn)
        report["ok"] = True
        return report
    except sqlite3.Error as exc:
        report["critical"] = True
        report["reason"] = f"inspect_failed:{exc}"
        return report
    finally:
        conn.close()


def apply_report(report: dict, flag_path: str) -> int:
    if report.get("critical"):
        reason = str(report.get("reason") or "unknown")
        print(f"[CRITICAL] db sentinel: {reason} db={report.get('db')}")
        write_flag(flag_path, reason)
        return 2
    orphans = report.get("orphans") or []
    if orphans:
        print(f"[WARN] {len(orphans)} stream_catalog orphan(s); pass --repair-orphans to DELETE.")
    if report.get("repaired"):
        print(f"[REPAIRED] deleted {report['repaired']} orphan stream_catalog row(s)")
    if report.get("wal_checkpoint"):
        print("[SQLITE WAL] checkpoint truncate completed")
    print(f"[OK] catalog integrity={report.get('integrity')}")
    clear_flag(flag_path)
    return 0


def run_once(db_path: str, flag_path: str, repair: bool) -> int:
    report = inspect_catalog(db_path, repair=repair)
    return apply_report(report, flag_path)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Watch master_catalog.db. Never launches emergency_rollback.ps1."
    )
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--flag", default=DEFAULT_FLAG)
    parser.add_argument("--once", action="store_true")
    parser.add_argument(
        "--repair-orphans",
        action="store_true",
        help="Opt-in DELETE of stream_catalog rows with no MASTERED ledger match.",
    )
    args = parser.parse_args()
    print("[*] DB Sentinel active (flag-only; no rollback).")
    if args.once:
        return run_once(args.db, args.flag, args.repair_orphans)
    while True:
        run_once(args.db, args.flag, args.repair_orphans)
        time.sleep(INTERVAL_SEC)


if __name__ == "__main__":
    sys.exit(main())
