"""Print JSON token balances for one user_id."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

DEFAULT_DB = os.environ.get("MASTER_CATALOG_DB", r"D:\MusicDatasets\database\master_catalog.db")
TIERS = ("artist", "hybrid", "render")


def balances(db_path: str, user_id: str) -> dict[str, int]:
    out = {tier: 0 for tier in TIERS}
    if not os.path.isfile(db_path):
        return out
    conn = sqlite3.connect(db_path, timeout=5)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_tokens (
                user_id TEXT NOT NULL,
                token_type TEXT NOT NULL,
                balance INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT,
                PRIMARY KEY (user_id, token_type)
            )
            """
        )
        rows = conn.execute(
            "SELECT token_type, balance FROM user_tokens WHERE user_id = ?",
            (user_id,),
        ).fetchall()
        for token_type, balance in rows:
            key = str(token_type or "").lower()
            if key in out:
                out[key] = int(balance or 0)
    finally:
        conn.close()
    return out


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--db", default=DEFAULT_DB)
    args = parser.parse_args()
    print(json.dumps({"user_id": args.user_id, "balances": balances(args.db, args.user_id)}))
    sys.exit(0)
