"""Pending artist payouts in master_catalog.db (fan-token $1 purchases).

Inserts are parameterized and idempotent on transaction_id. Status is always
the exact string ``Pending Payout``. This never sends money.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from typing import Any

WORKSTATION_DB = r"D:\MusicDatasets\database\master_catalog.db"
REPO_FALLBACK_DB = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".tmp", "master_catalog.db")
)

PENDING_PAYOUT_STATUS = "Pending Payout"


def default_db_path() -> str:
    env = os.environ.get("MASTER_CATALOG_DB", "").strip()
    if env:
        return env
    if os.path.isdir(r"D:\MusicDatasets") or os.path.isdir("D:\\"):
        return WORKSTATION_DB
    return REPO_FALLBACK_DB

PENDING_PAYOUTS_DDL = """
CREATE TABLE IF NOT EXISTS pending_payouts (
    transaction_id TEXT PRIMARY KEY,
    stripe_session_id TEXT,
    artist_name TEXT,
    song_title TEXT,
    artist_payout_target TEXT,
    buyer_email TEXT,
    token_amount REAL,
    currency TEXT,
    status TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_payouts_status ON pending_payouts(status);
"""


def ensure_pending_payouts(conn: sqlite3.Connection) -> None:
    conn.executescript(PENDING_PAYOUTS_DDL)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def insert_pending_payout(conn: sqlite3.Connection, row: dict[str, Any]) -> dict[str, Any]:
    """Insert a pending payout. Idempotent on transaction_id.

    Returns ``{"ok": True, "inserted": bool, "status": "Pending Payout"}``.
    """
    ensure_pending_payouts(conn)
    tx = str(row.get("transaction_id") or "").strip()
    if not tx:
        return {"ok": False, "inserted": False, "error": "missing_transaction_id"}

    stamp = _now()
    payload = (
        tx,
        str(row.get("stripe_session_id") or "").strip() or None,
        str(row.get("artist_name") or "").strip() or None,
        str(row.get("song_title") or "").strip() or None,
        str(row.get("artist_payout_target") or row.get("payout_address") or "").strip() or None,
        str(row.get("buyer_email") or "").strip() or None,
        float(row.get("token_amount") or 0),
        str(row.get("currency") or "USD").strip().upper() or "USD",
        PENDING_PAYOUT_STATUS,
        stamp,
        stamp,
    )
    conn.execute("BEGIN IMMEDIATE")
    try:
        cur = conn.execute(
            """
            INSERT INTO pending_payouts (
                transaction_id, stripe_session_id, artist_name, song_title,
                artist_payout_target, buyer_email, token_amount, currency,
                status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(transaction_id) DO NOTHING
            """,
            payload,
        )
        inserted = (cur.rowcount or 0) > 0
        conn.commit()
        return {
            "ok": True,
            "inserted": inserted,
            "status": PENDING_PAYOUT_STATUS,
            "transaction_id": tx,
        }
    except Exception:
        conn.rollback()
        raise


def record_from_payload(db_path: str, payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    parent = os.path.dirname(db_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return insert_pending_payout(conn, data if isinstance(data, dict) else {})
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Record a pending artist payout (no money sent)")
    parser.add_argument("--db", default=None)
    args = parser.parse_args(argv)
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        print(json.dumps({"ok": False, "inserted": False, "error": "invalid_json"}))
        return 2
    db_path = args.db or os.environ.get("MASTER_CATALOG_DB", "").strip() or default_db_path()
    result = record_from_payload(db_path, payload)
    print(json.dumps(result))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
