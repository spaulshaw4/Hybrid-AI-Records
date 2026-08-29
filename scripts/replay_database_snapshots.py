# D:\MusicDatasets\scripts\replay_database_snapshots.py
import os
import sys
import json
import zipfile
import argparse
from typing import List, Dict, Any
from supabase import create_client, Client

# Loads .env / .env.local into os.environ before the credential reads below.
# os.environ.get() returns only the process environment and Python does not read
# .env on its own, so credentials configured in a file are otherwise invisible
# here. A value already present in the real environment still wins.
import os as _hybrid_os, sys as _hybrid_sys
_hybrid_sys.path.insert(0, _hybrid_os.path.dirname(_hybrid_os.path.abspath(__file__)))
import hybrid_env  # noqa: F401,E402

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("[ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

TABLE_PRIMARY_KEYS = {
    "user_vaults": "session_id",
    "pipeline_telemetry_logs": "id",
    "audio_slices": "filename"
}

# daemon_poller.py continuously claims user_vaults rows in these states. Replaying
# them re-queues real renders, which burns tokens and CPU on sessions that already
# finished or were abandoned. Excluded unless --include-active is passed.
LIVE_QUEUE_STATES = {"pending", "processing"}


def chunk_records(records: List[Dict[str, Any]], chunk_size: int):
    for i in range(0, len(records), chunk_size):
        yield records[i:i + chunk_size]


def load_records_from_zip(archive_path: str, target_table: str = None) -> Dict[str, List[Dict[str, Any]]]:
    table_data = {}
    with zipfile.ZipFile(archive_path, "r") as z:
        for filename in z.namelist():
            if "database_snapshots/" in filename and filename.endswith(".json"):
                table_name = os.path.splitext(os.path.basename(filename))[0]
                if target_table and table_name != target_table:
                    continue
                with z.open(filename) as f:
                    raw_content = f.read().decode("utf-8")
                    table_data[table_name] = json.loads(raw_content)
    return table_data


def load_records_from_dir(dir_path: str, target_table: str = None) -> Dict[str, List[Dict[str, Any]]]:
    table_data = {}
    for filename in os.listdir(dir_path):
        if filename.endswith(".json"):
            table_name = os.path.splitext(filename)[0]
            if target_table and table_name != target_table:
                continue
            with open(os.path.join(dir_path, filename), "r", encoding="utf-8") as f:
                table_data[table_name] = json.load(f)
    return table_data


def filter_live_queue_rows(table_name: str, records: List[Dict[str, Any]], include_active: bool):
    """Drops rows that would re-enter the render queue on replay."""
    if table_name != "user_vaults" or include_active:
        return records, 0

    kept = []
    dropped = 0
    for r in records:
        if str(r.get("status", "")).lower() in LIVE_QUEUE_STATES:
            dropped += 1
        else:
            kept.append(r)
    return kept, dropped


def replay_table_records(table_name: str, records: List[Dict[str, Any]], batch_size: int, upsert: bool, dry_run: bool):
    total_records = len(records)

    if total_records == 0:
        print(f"\n[{table_name.upper()}] Nothing to replay.")
        return 0, 0

    print(f"\n[{table_name.upper()}] Preparing to process {total_records} records (Batch Size: {batch_size}, Mode: {'UPSERT' if upsert else 'INSERT'})...")

    if dry_run:
        print(f"  -> [DRY RUN] Would submit {total_records} records across {-(-total_records // batch_size)} batch requests to '{table_name}'.")
        return total_records, 0

    on_conflict_key = TABLE_PRIMARY_KEYS.get(table_name)

    if upsert and not on_conflict_key:
        print(f"  -> [WARN] No conflict key known for '{table_name}'; falling back to INSERT.")

    success_count = 0
    failure_count = 0

    for idx, batch in enumerate(chunk_records(records, batch_size), start=1):
        try:
            if upsert and on_conflict_key:
                res = supabase.table(table_name).upsert(batch, on_conflict=on_conflict_key).execute()
            else:
                res = supabase.table(table_name).insert(batch).execute()
            success_count += len(batch)
            print(f"  -> Batch {idx:02d}: Successfully replayed {len(batch)} records.")
        except Exception as e:
            failure_count += len(batch)
            print(f"  -> [ERROR] Batch {idx:02d} failed: {e}")

    return success_count, failure_count


def run_replay(source: str, table: str = None, batch_size: int = 200, upsert: bool = True,
               dry_run: bool = False, include_active: bool = False):
    print("================================================================")
    print("HYBRID 1.0 - DATABASE SNAPSHOT REPLAY UTILITY")
    print(f"Source Target : {source}")
    print(f"Filter Table  : {table or 'All Stored Tables'}")
    print(f"Replay Mode   : {'UPSERT (Safe Conflict Resolution)' if upsert else 'INSERT (Fail on Conflict)'}")
    print(f"Dry Run State : {dry_run}")
    print(f"Active Queue  : {'INCLUDED - will re-queue renders' if include_active else 'excluded (pending/processing skipped)'}")
    print("================================================================")

    if os.path.isfile(source) and source.endswith(".zip"):
        table_snapshots = load_records_from_zip(source, target_table=table)
    elif os.path.isdir(source):
        table_snapshots = load_records_from_dir(source, target_table=table)
    else:
        raise FileNotFoundError(f"Source '{source}' is neither a valid ZIP archive nor an existing directory.")

    if not table_snapshots:
        print("[INFO] No database JSON snapshots found matching the target criteria.")
        return

    total_success = 0
    total_fail = 0
    total_skipped = 0

    for table_name, records in table_snapshots.items():
        records, dropped = filter_live_queue_rows(table_name, records, include_active)
        total_skipped += dropped

        if dropped:
            print(f"\n[{table_name.upper()}] Skipping {dropped} row(s) in {sorted(LIVE_QUEUE_STATES)} "
                  f"to avoid re-queuing renders. Pass --include-active to replay them anyway.")

        success, fail = replay_table_records(table_name, records, batch_size, upsert, dry_run)
        total_success += success
        total_fail += fail

    print("\n================================================================")
    print("REPLAY EXECUTION SUMMARY:")
    print(f"  Tables Processed : {len(table_snapshots)}")
    print(f"  Records Processed: {total_success}")
    print(f"  Records Failed   : {total_fail}")
    print(f"  Records Skipped  : {total_skipped} (would have re-entered the render queue)")
    print("================================================================")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 Supabase Snapshot Replay Utility")
    parser.add_argument("--source", required=True, help="Path to backup .zip archive or directory containing .json snapshots")
    parser.add_argument("--table", default=None, help="Target specific table (e.g., user_vaults, pipeline_telemetry_logs)")
    parser.add_argument("--batch-size", type=int, default=200, help="Batch chunk size for API calls (default: 200)")
    parser.add_argument("--insert-only", action="store_true", help="Use direct INSERT instead of UPSERT on primary keys")
    parser.add_argument("--dry-run", action="store_true", help="Inspect and simulate replay without modifying Supabase")
    parser.add_argument("--include-active", action="store_true",
                        help="Also replay user_vaults rows in pending/processing state (re-queues real renders)")
    args = parser.parse_args()

    run_replay(
        source=args.source,
        table=args.table,
        batch_size=args.batch_size,
        upsert=not args.insert_only,
        dry_run=args.dry_run,
        include_active=args.include_active
    )
