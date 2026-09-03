"""Initialize master_catalog.db tables + WAL without inventing a second ledger."""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from ledger_schema import ensure_ledger  # noqa: E402

WORKSTATION_DB = r"D:\MusicDatasets\database\master_catalog.db"
REPO_FALLBACK_DB = os.path.abspath(
    os.path.join(SCRIPTS_DIR, "..", ".tmp", "master_catalog.db")
)

# Columns match credit_user_token.py / debit_user_token.py / read_user_tokens.py
# and sync_master_ledger.py. master_ledger is created only via ledger_schema.
AUX_DDL = """
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
CREATE TABLE IF NOT EXISTS token_debit_events (
    idempotency_key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_type TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS stream_catalog (
    track_id TEXT PRIMARY KEY,
    genre TEXT,
    audio_url TEXT,
    is_live INTEGER,
    verified_at TEXT
);
CREATE TABLE IF NOT EXISTS dsp_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    genre TEXT,
    true_peak_dbtp REAL,
    phase_correlation REAL,
    integrated_rms_dbfs REAL,
    recorded_at TEXT
);
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
"""

INDEX_DDL = """
CREATE INDEX IF NOT EXISTS idx_master_ledger_status ON master_ledger(status);
CREATE INDEX IF NOT EXISTS idx_master_ledger_genre ON master_ledger(genre);
CREATE INDEX IF NOT EXISTS idx_master_ledger_updated_at ON master_ledger(updated_at);
CREATE INDEX IF NOT EXISTS idx_stream_catalog_genre ON stream_catalog(genre);
CREATE INDEX IF NOT EXISTS idx_user_tokens_user_id ON user_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_dsp_telemetry_session_id ON dsp_telemetry(session_id);
CREATE INDEX IF NOT EXISTS idx_pending_payouts_status ON pending_payouts(status);
"""


def default_db_path() -> str:
    env = os.environ.get("MASTER_CATALOG_DB", "").strip()
    if env:
        return env
    if os.path.isdir(r"D:\MusicDatasets") or os.path.isdir("D:\\"):
        return WORKSTATION_DB
    return REPO_FALLBACK_DB


def apply_pragmas(conn: sqlite3.Connection) -> str:
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-64000")
    conn.execute("PRAGMA foreign_keys=ON")
    row = conn.execute("PRAGMA journal_mode").fetchone()
    return str(row[0] if row else "")


def init_schema(db_path: str) -> dict:
    parent = os.path.dirname(db_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10)
    try:
        journal_mode = apply_pragmas(conn)
        ensure_ledger(conn)
        conn.executescript(AUX_DDL)
        conn.executescript(INDEX_DDL)
        conn.commit()
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        return {"ok": True, "db": db_path, "journal_mode": journal_mode, "tables": sorted(tables)}
    finally:
        conn.close()


def check_schema(db_path: str) -> dict:
    if not os.path.isfile(db_path):
        return {"ok": False, "db": db_path, "journal_mode": None, "error": "missing"}
    conn = sqlite3.connect(db_path, timeout=5)
    try:
        journal_mode = str(conn.execute("PRAGMA journal_mode").fetchone()[0])
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        return {
            "ok": True,
            "db": db_path,
            "journal_mode": journal_mode,
            "tables": sorted(tables),
        }
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Initialize master_catalog schema + WAL")
    parser.add_argument("--db", default=None, help="SQLite path (default: workstation or repo .tmp)")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Print journal_mode and table list; do not write schema",
    )
    args = parser.parse_args()
    db_path = args.db or default_db_path()

    if args.check:
        result = check_schema(db_path)
    else:
        result = init_schema(db_path)

    mode = result.get("journal_mode") or "missing"
    print(f"journal_mode={mode}")
    if result.get("error"):
        print(f"error={result['error']}", file=sys.stderr)
        return 2
    print(f"db={result['db']}")
    if result.get("tables"):
        print("tables=" + ",".join(result["tables"]))
    return 0 if str(mode).lower() == "wal" else 1


if __name__ == "__main__":
    sys.exit(main())
