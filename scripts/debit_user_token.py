"""Atomically debit one workstation token from master_catalog.db."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

DEFAULT_DB = os.environ.get("MASTER_CATALOG_DB", r"D:\MusicDatasets\database\master_catalog.db")
VALID_TYPES = frozenset({"artist", "hybrid", "render"})

SCHEMA = """
CREATE TABLE IF NOT EXISTS user_tokens (
    user_id TEXT NOT NULL,
    token_type TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    PRIMARY KEY (user_id, token_type)
);
CREATE TABLE IF NOT EXISTS token_debit_events (
    idempotency_key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_type TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    created_at TEXT
);
"""


def debit(db_path: str, user_id: str, token_type: str, tokens: int, idempotency_key: str | None) -> dict:
    token_type = token_type.lower().strip()
    if token_type not in VALID_TYPES:
        return {"ok": False, "balance": 0, "error": f"invalid token_type: {token_type}"}
    if tokens < 1:
        return {"ok": False, "balance": 0, "error": "tokens must be >= 1"}

    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        conn.execute("BEGIN IMMEDIATE")
        stamp = datetime.now(timezone.utc).isoformat()

        if idempotency_key:
            prior = conn.execute(
                "SELECT 1 FROM token_debit_events WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
            if prior:
                row = conn.execute(
                    "SELECT balance FROM user_tokens WHERE user_id = ? AND token_type = ?",
                    (user_id, token_type),
                ).fetchone()
                conn.commit()
                return {
                    "ok": True,
                    "balance": int(row[0]) if row else 0,
                    "already_applied": True,
                }

        row = conn.execute(
            "SELECT balance FROM user_tokens WHERE user_id = ? AND token_type = ?",
            (user_id, token_type),
        ).fetchone()
        balance = int(row[0]) if row else 0
        if balance < tokens:
            conn.rollback()
            return {"ok": False, "balance": balance, "error": "insufficient"}

        conn.execute(
            """
            UPDATE user_tokens
            SET balance = balance - ?, updated_at = ?
            WHERE user_id = ? AND token_type = ?
            """,
            (tokens, stamp, user_id, token_type),
        )
        if idempotency_key:
            conn.execute(
                """
                INSERT INTO token_debit_events (idempotency_key, user_id, token_type, tokens, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (idempotency_key, user_id, token_type, tokens, stamp),
            )
        conn.commit()
        return {"ok": True, "balance": balance - tokens, "already_applied": False}
    except Exception as exc:
        conn.rollback()
        return {"ok": False, "balance": 0, "error": str(exc)}
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--token-type", required=True)
    parser.add_argument("--tokens", type=int, default=1)
    parser.add_argument("--idempotency-key", default="")
    args = parser.parse_args()
    result = debit(
        args.db,
        args.user_id,
        args.token_type,
        args.tokens,
        args.idempotency_key or None,
    )
    print(json.dumps(result))
    sys.exit(0 if result.get("ok") else 2)
