"""Aggregator-oriented CSV/JSON export of mastered catalog rows.

This is a delivery spreadsheet for aggregators and internal ops. It is not
DDEX XML and does not claim DDEX compliance.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

DEFAULT_DB = os.environ.get("MASTER_CATALOG_DB", r"D:\MusicDatasets\database\master_catalog.db")
LEDGER_CANDIDATES = (
    "session_id",
    "genre",
    "s3_key",
    "sha256_hash",
    "true_peak_dbtp",
    "phase_correlation",
    "status",
    "updated_at",
    "slice_duration",
)
STREAM_CANDIDATES = ("track_id", "genre", "audio_url", "is_live", "verified_at")
METRIC_FIELDS = frozenset({"true_peak_dbtp", "phase_correlation"})


def table_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return [str(row[1]) for row in rows]


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def format_metric(value: object) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return round(float(value), 3)
    except (TypeError, ValueError):
        return None


def _row_to_record(keys: list[str], values: tuple) -> dict:
    record: dict = {}
    for key, value in zip(keys, values):
        if key in METRIC_FIELDS:
            record[key] = format_metric(value)
        else:
            record[key] = value
    return record


def export_mastered_rows(
    db_path: str,
    status: str = "MASTERED",
) -> dict:
    exported_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "exported_at": exported_at,
        "status": status,
        "count": 0,
        "records": [],
        "columns": list(LEDGER_CANDIDATES),
    }
    if not os.path.isfile(db_path):
        return payload

    conn = sqlite3.connect(db_path, timeout=10)
    try:
        if not table_exists(conn, "master_ledger"):
            return payload

        ledger_cols = [name for name in LEDGER_CANDIDATES if name in table_columns(conn, "master_ledger")]
        if not ledger_cols:
            payload["columns"] = []
            return payload

        select_sql = ", ".join(ledger_cols)
        params: list = []
        where = ""
        if status and "status" in ledger_cols:
            where = " WHERE upper(status) = upper(?)"
            params.append(status)

        stream_cols: list[str] = []
        join_sql = ""
        if table_exists(conn, "stream_catalog") and "session_id" in ledger_cols:
            stream_cols = [name for name in STREAM_CANDIDATES if name in table_columns(conn, "stream_catalog")]
            stream_cols = [name for name in stream_cols if name != "genre"]
            if stream_cols:
                qualified = ", ".join(f"sc.{name} AS stream_{name}" for name in stream_cols)
                select_sql = ", ".join(f"ml.{name}" for name in ledger_cols) + ", " + qualified
                join_sql = " LEFT JOIN stream_catalog sc ON sc.track_id = ml.session_id"
                from_sql = f"master_ledger ml{join_sql}"
            else:
                from_sql = "master_ledger ml"
                select_sql = ", ".join(f"ml.{name}" for name in ledger_cols)
        else:
            from_sql = "master_ledger"

        cursor = conn.execute(f"SELECT {select_sql} FROM {from_sql}{where}", params)
        keys = ledger_cols + [f"stream_{name}" for name in stream_cols]
        records = [_row_to_record(keys, row) for row in cursor.fetchall()]
        payload["columns"] = keys
        payload["records"] = records
        payload["count"] = len(records)
        return payload
    finally:
        conn.close()


def write_json(payload: dict, path: str | None) -> str:
    text = json.dumps(payload, indent=2)
    if path:
        parent = os.path.dirname(os.path.abspath(path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.write("\n")
    return text


def write_csv(payload: dict, path: str) -> None:
    columns = list(payload.get("columns") or [])
    records = list(payload.get("records") or [])
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        if columns:
            writer.writeheader()
        for record in records:
            row = {}
            for key in columns:
                value = record.get(key)
                row[key] = "" if value is None else value
            writer.writerow(row)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Aggregator-oriented CSV/JSON of catalog rows (default status=MASTERED)."
    )
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--status", default="MASTERED")
    parser.add_argument("--json", dest="json_path", default="")
    parser.add_argument("--csv", dest="csv_path", default="")
    args = parser.parse_args()

    payload = export_mastered_rows(args.db, status=args.status)
    if args.csv_path:
        write_csv(payload, args.csv_path)
        print(f"[EXPORT] csv={args.csv_path} count={payload['count']}")
    text = write_json(payload, args.json_path or None)
    if args.json_path:
        print(f"[EXPORT] json={args.json_path} count={payload['count']}")
    if not args.json_path and not args.csv_path:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
