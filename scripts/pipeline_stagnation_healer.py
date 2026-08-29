# D:\MusicDatasets\scripts\pipeline_stagnation_healer.py
import os
import sys
import time
import shutil
import argparse
import subprocess
from datetime import datetime, timezone, timedelta
from supabase import create_client, Client

# Loads .env / .env.local into os.environ before the credential reads below.
# os.environ.get() returns only the process environment and Python does not read
# .env on its own, so credentials configured in a file are otherwise invisible
# here. A value already present in the real environment still wins.
import os as _hybrid_os, sys as _hybrid_sys
_hybrid_sys.path.insert(0, _hybrid_os.path.dirname(_hybrid_os.path.abspath(__file__)))
import hybrid_env  # noqa: F401,E402

BASE_DIR = r"D:\MusicDatasets"
INCOMING_DIR = os.path.join(BASE_DIR, "incoming")
RENDERS_DIR = os.path.join(BASE_DIR, "renders")
LOGS_DIR = os.path.join(BASE_DIR, "logs")
SCRIPTS_DIR = os.path.join(BASE_DIR, "scripts")
TELEMETRY_SCRIPT = os.path.join(SCRIPTS_DIR, "log_telemetry.py")

STAGNATION_TIMEOUT_MINUTES = 20
MAX_AUTO_RETRIES = 2
POLL_INTERVAL_SEC = 60

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("[HEALER FATAL] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from environment.")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def is_session_process_active(session_id: str) -> bool:
    """
    Check whether any live process is still handling this session.

    The query must exclude its own PID. The session id is embedded in the
    -like filter, so the powershell.exe running this very query has the id in
    its own CommandLine and Win32_Process enumerates itself - without the
    $PID exclusion every session looks permanently active and nothing is ever
    healed. Descendants of that shell (conhost, WMI helpers) are excluded the
    same way via their parent id.
    """
    try:
        ps_query = (
            "$self = $PID; "
            "Get-CimInstance Win32_Process | "
            f"Where-Object {{ $_.CommandLine -like '*{session_id}*' "
            "-and $_.ProcessId -ne $self "
            "-and $_.ParentProcessId -ne $self }} | "
            "Select-Object -ExpandProperty ProcessId"
        )

        cmd = ["powershell.exe", "-NoProfile", "-Command", ps_query]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        pids = [p.strip() for p in result.stdout.strip().splitlines() if p.strip().isdigit()]
        return len(pids) > 0
    except Exception as e:
        # Fail closed: if the process table cannot be read, assume the job may
        # still be alive rather than clobbering a live render.
        print(f"  [WARN] Failed to query process table for {session_id}: {e}")
        return True


def clean_stale_staging_artifacts(session_id: str):
    """
    Remove the per-session render scratchpad.

    Note this deliberately does NOT touch incoming/, because staging is keyed by
    genre (incoming/<genre>/) not by session. Deleting incoming/<session_id>
    would either be a no-op or, if a session id ever collided with a genre slug,
    destroy a whole genre's staged source audio.
    """
    render_path = os.path.join(RENDERS_DIR, session_id)

    if os.path.exists(render_path):
        try:
            shutil.rmtree(render_path, ignore_errors=True)
            print(f"  -> Purged stale render scratchpad: {render_path}")
        except Exception as e:
            print(f"  -> [WARN] Could not clean {render_path}: {e}")


def log_autoheal_event(session_id: str, action: str, retry_count: int, reason: str):
    if not os.path.exists(TELEMETRY_SCRIPT):
        return

    meta_json = (
        f'{{"session_id":"{session_id}",'
        f'"healer_action":"{action}",'
        f'"retry_count":{retry_count},'
        f'"reason":"{reason}"}}'
    )

    try:
        # sys.executable, not "python": a bare invocation hits the Microsoft
        # Store alias stub on this machine and silently produces no telemetry.
        subprocess.run([
            sys.executable, TELEMETRY_SCRIPT,
            "--event", f"pipeline_autoheal_{action}",
            "--user", "00000000-0000-0000-0000-000000000001",
            "--metadata", meta_json
        ], capture_output=True, text=True)
    except Exception as e:
        print(f"  [WARN] Telemetry logging failed: {e}")


def parse_ts(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def scan_and_heal_stagnant_jobs():
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=STAGNATION_TIMEOUT_MINUTES)

    try:
        # Fetch every processing row and filter locally rather than using a
        # server-side .lt() on updated_at. A row whose updated_at is NULL - which
        # happens when a session is inserted without one - is excluded by any SQL
        # comparison, so it would stall forever and never be healed.
        response = (
            supabase.table("user_vaults")
            .select("session_id, user_id, genre_lock, status, metadata, created_at, updated_at")
            .eq("status", "processing")
            .execute()
        )
        candidates = response.data or []
    except Exception as e:
        print(f"[HEALER ERROR] Failed to query user_vaults ledger: {e}")
        return

    stagnant_sessions = []
    for job in candidates:
        last_touch = parse_ts(job.get("updated_at")) or parse_ts(job.get("created_at"))
        if last_touch is None:
            # No usable timestamp at all: treat as stagnant, it cannot self-recover
            stagnant_sessions.append(job)
        elif last_touch < cutoff:
            stagnant_sessions.append(job)

    if not stagnant_sessions:
        return

    print(f"\n[HEALER ALERT] Detected {len(stagnant_sessions)} stagnant session(s) exceeding {STAGNATION_TIMEOUT_MINUTES}m threshold.")

    for job in stagnant_sessions:
        session_id = job.get("session_id")
        metadata = job.get("metadata") or {}
        retry_count = metadata.get("auto_retry_count", 0)

        # Confirm process is actually dead before taking corrective action
        if is_session_process_active(session_id):
            print(f"  [SKIP] Session {session_id} is still executing an active OS process. Preserving state.")
            continue

        print(f"  [HEALING] Stagnant job detected: {session_id} (Retries: {retry_count}/{MAX_AUTO_RETRIES})")

        if retry_count < MAX_AUTO_RETRIES:
            new_retry_count = retry_count + 1
            metadata["auto_retry_count"] = new_retry_count
            metadata["last_healed_at"] = datetime.now(timezone.utc).isoformat()
            metadata["healing_action"] = "requeued"

            clean_stale_staging_artifacts(session_id)

            try:
                supabase.table("user_vaults").update({
                    "status": "pending",
                    "metadata": metadata,
                    "updated_at": datetime.now(timezone.utc).isoformat()
                }).eq("session_id", session_id).execute()

                print(f"  -> [RE-QUEUED] Session {session_id} reset to 'pending' (Attempt {new_retry_count}).")
                log_autoheal_event(session_id, "requeued", new_retry_count, f"Execution stalled > {STAGNATION_TIMEOUT_MINUTES}m")
            except Exception as e:
                print(f"  -> [ERROR] Failed to re-queue session {session_id}: {e}")

        else:
            metadata["healing_action"] = "dead_letter_failed"
            metadata["failure_reason"] = f"Exceeded maximum auto-retries ({MAX_AUTO_RETRIES}) after pipeline stall"

            clean_stale_staging_artifacts(session_id)

            try:
                supabase.table("user_vaults").update({
                    "status": "failed",
                    "metadata": metadata,
                    "updated_at": datetime.now(timezone.utc).isoformat()
                }).eq("session_id", session_id).execute()

                print(f"  -> [DEAD-LETTER] Session {session_id} marked as 'failed' (Max retries exceeded).")
                log_autoheal_event(session_id, "failed", retry_count, "Max auto-retries exceeded")
            except Exception as e:
                print(f"  -> [ERROR] Failed to mark session {session_id} as failed: {e}")


def run_stagnation_healer():
    print("================================================================")
    print("HYBRID 1.0 - PIPELINE STAGNATION & DEAD-LETTER HEALER")
    print(f"Stall Timeout    : {STAGNATION_TIMEOUT_MINUTES} minutes")
    print(f"Max Auto-Retries : {MAX_AUTO_RETRIES}")
    print(f"Scan Frequency   : Every {POLL_INTERVAL_SEC} seconds")
    print(f"Interpreter      : {sys.executable}")
    print("================================================================")

    while True:
        scan_and_heal_stagnant_jobs()
        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 pipeline stagnation healer")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single sweep and exit, instead of polling forever. Used by the "
             "macro server and terminal HUD, which would otherwise leak a permanent "
             "process on every manual heal."
    )
    args = parser.parse_args()

    if args.once:
        print("[HEALER] Single sweep requested.")
        scan_and_heal_stagnant_jobs()
        print("[HEALER] Sweep complete.")
    else:
        run_stagnation_healer()
