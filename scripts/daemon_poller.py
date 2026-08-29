# D:\MusicDatasets\scripts\daemon_poller.py
import os
import sys
import time
import json
import subprocess
from datetime import datetime, timezone
from supabase import create_client, Client

BASE_DIR = r"D:\MusicDatasets"
SCRIPTS_DIR = os.path.join(BASE_DIR, "scripts")
RUN_PIPELINE = os.path.join(SCRIPTS_DIR, "run_master_pipeline.ps1")

POLL_INTERVAL_SEC = 5
DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001"

# Supported track length, mirrored from run_master_pipeline.ps1. The pipeline
# clamps anyway; validating here keeps the dispatch log honest.
MIN_DURATION_SEC = 150   # 2:30
MAX_DURATION_SEC = 420   # 7:00

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("[FATAL] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def extract_render_parameters(job_metadata: dict) -> dict:
    """
    Pull DSP and duration settings from job metadata, falling back to defaults.

    Every value is validated rather than trusted: metadata originates from the
    web API, so a malformed field must not reach the PowerShell command line.
    """
    if not isinstance(job_metadata, dict):
        job_metadata = {}

    try:
        threshold_dbfs = float(job_metadata.get("threshold_dbfs", -3.0))
    except (ValueError, TypeError):
        threshold_dbfs = -3.0

    try:
        ceiling_dbfs = float(job_metadata.get("ceiling_dbfs", -0.5))
    except (ValueError, TypeError):
        ceiling_dbfs = -0.5

    gain_mode = str(job_metadata.get("gain_mode", "acoustic")).lower()
    if gain_mode not in ["acoustic", "linear", "unity"]:
        gain_mode = "acoustic"

    try:
        bit_depth = int(job_metadata.get("bit_depth", 16))
        if bit_depth not in [16, 24]:
            bit_depth = 16
    except (ValueError, TypeError):
        bit_depth = 16

    no_dither = bool(job_metadata.get("no_dither", False))

    # Track length, clamped to the supported 2:30-7:00 window
    try:
        duration_seconds = int(job_metadata.get("duration_seconds", MAX_DURATION_SEC))
    except (ValueError, TypeError):
        duration_seconds = MAX_DURATION_SEC
    duration_seconds = max(MIN_DURATION_SEC, min(MAX_DURATION_SEC, duration_seconds))

    try:
        premix_layers = int(job_metadata.get("premix_layers", 4))
        if premix_layers < 1:
            premix_layers = 1
    except (ValueError, TypeError):
        premix_layers = 4

    return {
        "threshold_dbfs": threshold_dbfs,
        "ceiling_dbfs": ceiling_dbfs,
        "gain_mode": gain_mode,
        "bit_depth": bit_depth,
        "no_dither": no_dither,
        "duration_seconds": duration_seconds,
        "premix_layers": premix_layers,
    }


def mark_failed(session_id: str, reason: str):
    """
    Record a deterministic failure immediately.

    The stagnation healer only rescues sessions that stall with no process
    attached; a pipeline that exited non-zero has already given its verdict, so
    leaving it in 'processing' would waste two healer retries on a repeatable
    fault before dead-lettering it.
    """
    try:
        supabase.table("user_vaults").update({
            "status": "failed",
            "metadata": {"error_output": reason[:500]},
            "updated_at": datetime.now(timezone.utc).isoformat()
        }).eq("session_id", session_id).execute()
    except Exception as e:
        print(f"[POLLER WARN] Could not mark {session_id} as failed: {e}")


def poll_and_execute():
    try:
        res = (
            supabase.table("user_vaults")
            .select("*")
            .eq("status", "pending")
            .order("created_at", desc=False)
            .limit(1)
            .execute()
        )
        jobs = res.data or []

        if not jobs:
            return

        job = jobs[0]
        session_id = job.get("session_id")
        genre_lock = job.get("genre_lock") or "heavy_alternative_rock"
        user_id = job.get("user_id") or DEFAULT_USER_ID
        raw_metadata = job.get("metadata") or {}

        if isinstance(raw_metadata, str):
            try:
                raw_metadata = json.loads(raw_metadata)
            except Exception:
                raw_metadata = {}

        cfg = extract_render_parameters(raw_metadata)

        print(f"\n[DISPATCH] Claiming session: {session_id}")
        print(f"  -> User UUID     : {user_id}")
        print(f"  -> Genre Lock    : {genre_lock}")
        print(f"  -> Track Length  : {cfg['duration_seconds']}s ({cfg['duration_seconds'] // 60}:{cfg['duration_seconds'] % 60:02d})")
        print(f"  -> Premix Layers : {cfg['premix_layers']}")
        print(f"  -> DSP Saturation: {cfg['threshold_dbfs']} dBFS knee | {cfg['ceiling_dbfs']} dBFS ceiling")
        print(f"  -> Audio Profile : {cfg['gain_mode']} | {cfg['bit_depth']}-bit PCM (dither: {not cfg['no_dither']})")

        supabase.table("user_vaults").update({
            "status": "processing",
            "updated_at": datetime.now(timezone.utc).isoformat()
        }).eq("session_id", session_id).execute()

        cmd = [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", RUN_PIPELINE,
            "-SessionId", session_id,
            "-GenreLock", genre_lock,
            "-UserId", user_id,
            "-DurationSeconds", str(cfg["duration_seconds"]),
            "-PremixLayers", str(cfg["premix_layers"]),
            "-ThresholdDbfs", str(cfg["threshold_dbfs"]),
            "-CeilingDbfs", str(cfg["ceiling_dbfs"]),
            "-GainMode", cfg["gain_mode"],
            "-BitDepth", str(cfg["bit_depth"])
        ]

        if cfg["no_dither"]:
            cmd.append("-NoDither")

        proc = subprocess.run(cmd, capture_output=True, text=True)
        print(proc.stdout)

        if proc.returncode != 0:
            print(f"[POLLER ERROR] Pipeline exited with code {proc.returncode}")
            if proc.stderr:
                print(f"[STDERR] {proc.stderr}")
            mark_failed(session_id, proc.stderr or f"exit code {proc.returncode}")
        else:
            print(f"[SUCCESS] Pipeline completed for {session_id}.")

    except Exception as e:
        print(f"[POLLER ERROR] Exception in job processing loop: {e}")


def main():
    print("================================================================")
    print("HYBRID 1.0 - SUPABASE DAEMON POLLER & DSP DISPATCHER ACTIVE")
    print(f"Poll Interval    : Every {POLL_INTERVAL_SEC} seconds")
    print(f"Track Length     : {MIN_DURATION_SEC}s - {MAX_DURATION_SEC}s (2:30 - 7:00)")
    print("================================================================")

    while True:
        poll_and_execute()
        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    main()
