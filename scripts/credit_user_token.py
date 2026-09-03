"""Credit workstation token balances in master_catalog.db."""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from datetime import datetime, timezone

DEFAULT_DB = r"D:\MusicDatasets\database\master_catalog.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS user_tokens (
    user_id TEXT NOT NULL,
    token_type TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    PRIMARY KEY (user_id, token_type)
);
CREATE TABLE IF NOT EXISTS token_credit_events (
    stripe_session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_type TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    created_at TEXT
);
"""


def credit(db_path: str, user_id: str, token_type: str, tokens: int, stripe_session_id: str) -> str:
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA)
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            "SELECT 1 FROM token_credit_events WHERE stripe_session_id = ?",
            (stripe_session_id,),
        ).fetchone()
        if existing:
            conn.commit()
            return "already_credited"
        stamp = datetime.now(timezone.utc).isoformat()
        conn.execute(
            """
            INSERT INTO user_tokens (user_id, token_type, balance, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, token_type) DO UPDATE SET
                balance = balance + excluded.balance,
                updated_at = excluded.updated_at
            """,
            (user_id, token_type, tokens, stamp),
        )
        conn.execute(
            """
            INSERT INTO token_credit_events (stripe_session_id, user_id, token_type, tokens, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (stripe_session_id, user_id, token_type, tokens, stamp),
        )
        conn.commit()
        return "credited"
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--token-type", required=True)
    parser.add_argument("--tokens", type=int, required=True)
    parser.add_argument("--stripe-session-id", required=True)
    args = parser.parse_args()
    print(credit(args.db, args.user_id, args.token_type, args.tokens, args.stripe_session_id))
