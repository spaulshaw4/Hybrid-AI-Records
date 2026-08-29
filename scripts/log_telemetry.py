# D:\MusicDatasets\scripts\log_telemetry.py
import os
import sys
import time
import psutil
import argparse
import json
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
    raise EnvironmentError("Missing Supabase credentials in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def get_hardware_telemetry(drive_letter="D:"):
    try:
        disk_usage = psutil.disk_usage(f"{drive_letter}\\")
        disk_free_gb = round(disk_usage.free / (1024 ** 3), 2)
        disk_total_gb = round(disk_usage.total / (1024 ** 3), 2)
        disk_percent = disk_usage.percent
    except Exception:
        disk_free_gb = None
        disk_total_gb = None
        disk_percent = None

    cpu_percent = psutil.cpu_percent(interval=0.5)
    memory_info = psutil.virtual_memory()

    return {
        "cpu_utilization_pct": cpu_percent,
        "ram_total_gb": round(memory_info.total / (1024 ** 3), 2),
        "ram_used_gb": round(memory_info.used / (1024 ** 3), 2),
        "ram_utilization_pct": memory_info.percent,
        "disk_target": drive_letter,
        "disk_free_gb": disk_free_gb,
        "disk_total_gb": disk_total_gb,
        "disk_utilization_pct": disk_percent
    }


def record_telemetry(event_type: str, user_id: str, job_id: str = None, session_id: str = None, duration_sec: float = None, extra_data: dict = None):
    hw_stats = get_hardware_telemetry(drive_letter="D:")

    metadata = {
        "session_id": session_id,
        "execution_duration_sec": duration_sec,
        "hardware": hw_stats,
        "timestamp_unix": int(time.time())
    }

    if extra_data:
        metadata.update(extra_data)

    payload = {
        "event_type": event_type,
        "user_id": user_id,
        "metadata": metadata
    }

    if job_id:
        payload["job_id"] = job_id

    try:
        response = supabase.table("pipeline_telemetry_logs").insert(payload).execute()
        print(f"[TELEMETRY] Logged event '{event_type}' for session {session_id or 'N/A'}")
        return response
    except Exception as e:
        print(f"[TELEMETRY ERROR] Failed to record log: {e}", file=sys.stderr)
        return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 Pipeline Telemetry Health Logger")
    parser.add_argument("--event", required=True, help="Event type (e.g., pipeline_start, pipeline_complete, pipeline_failed, heartbeat)")
    parser.add_argument("--user", required=True, help="User UUID")
    parser.add_argument("--job", default=None, help="Job UUID (optional)")
    parser.add_argument("--session", default=None, help="Session ID string")
    parser.add_argument("--duration", type=float, default=None, help="Execution duration in seconds")
    parser.add_argument("--metadata", default=None, help="Additional JSON metadata string")
    args = parser.parse_args()

    additional_meta = None
    if args.metadata:
        try:
            additional_meta = json.loads(args.metadata)
        except json.JSONDecodeError:
            additional_meta = {"raw_metadata": args.metadata}

    record_telemetry(
        event_type=args.event,
        user_id=args.user,
        job_id=args.job,
        session_id=args.session,
        duration_sec=args.duration,
        extra_data=additional_meta
    )
