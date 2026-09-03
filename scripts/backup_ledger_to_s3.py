"""WAL-safe SQLite snapshot uploaded as gzip to vault-storage."""
from __future__ import annotations

import gzip
import os
import shutil
import sqlite3
import sys
from datetime import datetime, timezone

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)
import hybrid_env  # noqa: F401,E402
from s3_storage_lifecycle import _s3_client  # noqa: E402

SOURCE_DB = os.environ.get("MASTER_CATALOG_DB", r"D:\MusicDatasets\database\master_catalog.db")
BACKUP_TEMP = r"D:\MusicDatasets\scratch\master_catalog_snapshot.db"
S3_BUCKET = os.environ.get("SUPABASE_S3_BUCKET", "vault-storage")


def execute_live_backup() -> str:
    if not os.path.exists(SOURCE_DB):
        print(f"[ERROR] Source database not found: {SOURCE_DB}", file=sys.stderr)
        sys.exit(1)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    os.makedirs(os.path.dirname(BACKUP_TEMP), exist_ok=True)
    compressed_file = f"{BACKUP_TEMP}_{timestamp}.gz"

    print(f"[*] Initiating SQLite online backup API for: {SOURCE_DB}")
    src_conn = sqlite3.connect(SOURCE_DB)
    dst_conn = sqlite3.connect(BACKUP_TEMP)
    with dst_conn:
        src_conn.backup(dst_conn, pages=250, sleep=0.01)
    dst_conn.close()
    src_conn.close()
    print("[*] Local database snapshot created.")

    with open(BACKUP_TEMP, "rb") as f_in:
        with gzip.open(compressed_file, "wb", compresslevel=9) as f_out:
            shutil.copyfileobj(f_in, f_out)
    os.remove(BACKUP_TEMP)

    s3_key = f"backups/database/master_catalog_{timestamp}.db.gz"
    print(f"[*] Uploading backup to vault-storage/{s3_key}...")
    s3 = _s3_client()
    s3.upload_file(compressed_file, S3_BUCKET, s3_key)
    os.remove(compressed_file)
    print(f"[SUCCESS] Database backup archived to S3: {s3_key}")
    return s3_key


if __name__ == "__main__":
    execute_live_backup()
