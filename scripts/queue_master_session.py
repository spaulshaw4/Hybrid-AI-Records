"""Queue a workstation master job for HybridAudioDaemon (user_vaults + ledger)."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)
import hybrid_env  # noqa: F401,E402
from ledger_schema import ensure_ledger  # noqa: E402

DEFAULT_DB = os.environ.get("MASTER_CATALOG_DB", r"D:\MusicDatasets\database\master_catalog.db")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_local_ledger(
    db_path: str,
    session_id: str,
    genre: str,
    status: str,
    slice_duration: float,
) -> None:
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10)
    try:
        ensure_ledger(conn)
        conn.execute(
            """
            INSERT INTO master_ledger (session_id, genre, status, updated_at, slice_duration)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                genre = excluded.genre,
                status = excluded.status,
                updated_at = excluded.updated_at,
                slice_duration = excluded.slice_duration
            """,
            (session_id, genre, status, utc_now(), slice_duration),
        )
        conn.commit()
    finally:
        conn.close()


def queue_supabase(session_id: str, genre: str, user_id: str, slice_duration: float) -> str:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return "skipped_no_credentials"
    from supabase import create_client

    client = create_client(url, key)
    payload = {
        "session_id": session_id,
        "user_id": user_id,
        "genre_lock": genre,
        "status": "pending",
        "metadata": {
            "slice_duration": slice_duration,
            "mode": "console_execute",
            "token_tier": "hybrid",
        },
    }
    try:
        client.table("user_vaults").insert(payload).execute()
    except Exception:
        client.table("user_vaults").update(
            {"genre_lock": genre, "status": "pending", "metadata": payload["metadata"]}
        ).eq("session_id", session_id).execute()
    return "queued"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--genre", required=True)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--slice-duration", type=float, default=4.0)
    parser.add_argument("--cloud", action="store_true", help="Also insert user_vaults for HybridAudioDaemon")
    parser.add_argument("--db", default=DEFAULT_DB)
    args = parser.parse_args()

    write_local_ledger(args.db, args.session_id, args.genre, "QUEUED", args.slice_duration)
    cloud = "skipped"
    if args.cloud:
        try:
            cloud = queue_supabase(args.session_id, args.genre, args.user_id, args.slice_duration)
        except Exception as exc:
            cloud = f"error:{exc}"
            print(json.dumps({"ok": False, "session_id": args.session_id, "cloud": cloud}))
            return 1

    print(
        json.dumps(
            {
                "ok": True,
                "session_id": args.session_id,
                "genre": args.genre,
                "cloud": cloud,
                "status": "QUEUED",
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
