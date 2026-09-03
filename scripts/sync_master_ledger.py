"""Atomic master_ledger upsert and QC-gated stream_catalog promotion."""
from __future__ import annotations

import argparse
import hashlib
import os
import sqlite3
import sys
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS master_ledger (
    session_id TEXT PRIMARY KEY,
    genre TEXT,
    s3_key TEXT,
    sha256_hash TEXT,
    true_peak_dbtp REAL,
    phase_correlation REAL,
    status TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS stream_catalog (
    track_id TEXT PRIMARY KEY,
    genre TEXT,
    audio_url TEXT,
    is_live INTEGER,
    verified_at TEXT
);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def promote_master_to_catalog(
    db_path: str,
    session_id: str,
    genre: str,
    s3_key: str,
    sha256: str,
    true_peak: float,
    phase: float,
    verify_path: str | None = None,
) -> None:
    if verify_path:
        if not os.path.isfile(verify_path):
            print(f"[REJECTED] Master file missing at {verify_path}. Phantom record blocked.", file=sys.stderr)
            sys.exit(1)
        actual = sha256_file(verify_path)
        if sha256 and actual.lower() != sha256.lower():
            print("[REJECTED] SHA-256 mismatch; ledger transaction aborted.", file=sys.stderr)
            sys.exit(1)

    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    try:
        ensure_schema(conn)
        cursor.execute("BEGIN IMMEDIATE")
        stamp = utc_now()
        cursor.execute(
            """
            INSERT INTO master_ledger (
                session_id, genre, s3_key, sha256_hash, true_peak_dbtp, phase_correlation, status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'MASTERED', ?)
            ON CONFLICT(session_id) DO UPDATE SET
                status = 'MASTERED',
                s3_key = excluded.s3_key,
                sha256_hash = excluded.sha256_hash,
                true_peak_dbtp = excluded.true_peak_dbtp,
                phase_correlation = excluded.phase_correlation,
                updated_at = excluded.updated_at
            """,
            (session_id, genre, s3_key, sha256, true_peak, phase, stamp),
        )
        if true_peak <= -0.50 and phase >= 0.80:
            cursor.execute(
                """
                INSERT INTO stream_catalog (
                    track_id, genre, audio_url, is_live, verified_at
                ) VALUES (?, ?, ?, 1, ?)
                ON CONFLICT(track_id) DO UPDATE SET
                    audio_url = excluded.audio_url,
                    is_live = 1,
                    verified_at = excluded.verified_at
                """,
                (session_id, genre, f"vault-storage/{s3_key}", stamp),
            )
            print(f"[PROMOTED] Session {session_id} promoted to live streaming catalog.")
        else:
            print(f"[REJECTED] Session {session_id} failed QC thresholds (Peak: {true_peak}, Phase: {phase}).")
        conn.commit()
    except Exception as exc:
        conn.rollback()
        print(f"[ERROR] Transaction rolled back: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--genre", required=True)
    parser.add_argument("--s3-key", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--true-peak", type=float, required=True)
    parser.add_argument("--phase", type=float, required=True)
    parser.add_argument("--verify-path", default=None)
    args = parser.parse_args()
    promote_master_to_catalog(
        args.db,
        args.session_id,
        args.genre,
        args.s3_key,
        args.sha256,
        args.true_peak,
        args.phase,
        args.verify_path,
    )
