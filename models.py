#!/usr/bin/env python3
"""Local SQLite job + ledger store for the self-hosted studio mixer."""
from __future__ import annotations

import os
import sqlite3
import uuid
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
_ON_POD = Path("/workspace").is_dir()
DB_PATH = os.environ.get(
    "LOCAL_DB_PATH",
    str(Path("/workspace/hybrid_studio.db") if _ON_POD else _ROOT / "hybrid_studio.db"),
)


def _connect() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = _connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                job_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                vocal_path TEXT,
                instrumental_path TEXT,
                master_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ledger (
                transaction_id TEXT PRIMARY KEY,
                job_id TEXT,
                amount_usd REAL DEFAULT 2.00,
                status TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        job_cols = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
        if "lyrics" not in job_cols:
            conn.execute("ALTER TABLE jobs ADD COLUMN lyrics TEXT")
        conn.commit()
    finally:
        conn.close()
    print(f"Local database initialized at: {DB_PATH}")


def create_job(job_id: str, vocal_path: str, instrumental_path: str) -> None:
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO jobs (job_id, status, vocal_path, instrumental_path) VALUES (?, ?, ?, ?)",
            (job_id, "pending", vocal_path, instrumental_path),
        )
        conn.commit()
    finally:
        conn.close()


def update_job_status(
    job_id: str,
    status: str,
    master_url: str | None = None,
    lyrics: str | None = None,
) -> None:
    conn = _connect()
    try:
        assignments = ["status = ?"]
        params: list[object] = [status]
        if master_url is not None:
            assignments.append("master_url = ?")
            params.append(master_url)
        if lyrics is not None:
            assignments.append("lyrics = ?")
            params.append(lyrics)
        params.append(job_id)
        conn.execute(
            f"UPDATE jobs SET {', '.join(assignments)} WHERE job_id = ?",
            params,
        )
        conn.commit()
    finally:
        conn.close()


def get_job(job_id: str) -> dict | None:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM jobs WHERE job_id = ?",
            (job_id,),
        ).fetchone()
        if row is None:
            return None
        return {key: row[key] for key in row.keys()}
    finally:
        conn.close()


def log_ledger(job_id: str, amount_usd: float = 2.00, status: str = "recorded") -> str:
    tx_id = str(uuid.uuid4())
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO ledger (transaction_id, job_id, amount_usd, status) VALUES (?, ?, ?, ?)",
            (tx_id, job_id, amount_usd, status),
        )
        conn.commit()
    finally:
        conn.close()
    return tx_id


if __name__ == "__main__":
    init_db()
