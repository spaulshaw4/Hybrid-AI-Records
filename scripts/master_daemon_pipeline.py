# scripts/master_daemon_pipeline.py
import os
import time
import json
import subprocess
import traceback
from supabase import create_client, Client
from hybrid_local_alert import HybridLocalNotifier

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

PAYLOAD_DIR = r"D:\MusicDatasets\job_payloads"
RENDERS_DIR = r"D:\MusicDatasets\renders"
POLL_INTERVAL = 2

notifier = HybridLocalNotifier()


def process_job(payload_path):
    try:
        with open(payload_path, 'r') as f:
            job_data = json.load(f)

        session_id = job_data.get("session_id")
        print(f"\n[DAEMON] Picked up new job payload: {session_id}")

        # Update Supabase vault status to processing
        supabase.from_('user_vaults').update({'status': 'processing'}).eq('session_id', session_id).execute()
        notifier.send_alert(session_id, "processing", f"Job picked up by worker daemon. Genre: {job_data.get('genre_lock')}")

        # Step 1: Master Engine
        res_engine = subprocess.run(
            ["python", r"D:\MusicDatasets\scripts\master_engine.py", "--payload", payload_path],
            capture_output=True, text=True
        )
        if res_engine.returncode != 0:
            raise RuntimeError(f"Master Engine failed:\n{res_engine.stderr}")

        # Step 2: Cylinder Orchestrator
        res_cyl = subprocess.run(
            ["python", r"D:\MusicDatasets\scripts\cylinder_orchestrator.py", "--payload", payload_path],
            capture_output=True, text=True
        )
        if res_cyl.returncode != 0:
            raise RuntimeError(f"Cylinder Orchestrator failed:\n{res_cyl.stderr}")

        # Step 3: Bus Summation
        working_dir = os.path.join(RENDERS_DIR, session_id)
        res_sum = subprocess.run(
            ["python", r"D:\MusicDatasets\scripts\cylinder_bus_summation.py", "--session", session_id, "--dir", working_dir],
            capture_output=True, text=True
        )
        if res_sum.returncode != 0:
            raise RuntimeError(f"Bus Summation failed:\n{res_sum.stderr}")

        # Step 4: Cryptographic Hex Registration & Verification Hook
        res_hook = subprocess.run(
            ["python", r"D:\MusicDatasets\scripts\hybrid_hex_pipeline_hook.py", "--session", session_id, "--dir", working_dir],
            capture_output=True, text=True
        )
        if res_hook.returncode != 0:
            raise RuntimeError(f"Hex Pipeline Hook failed:\n{res_hook.stderr}")

        # Step 5: Mark Completed in Supabase Vault
        supabase.from_('user_vaults').update({'status': 'completed'}).eq('session_id', session_id).execute()
        print(f"[DAEMON SUCCESS] Session {session_id} successfully processed and locked.")
        notifier.send_alert(session_id, "completed", "All stems rendered, summed, cryptographically hashed, and verified.")

        # Cleanup payload file
        if os.path.exists(payload_path):
            os.remove(payload_path)

    except Exception as e:
        error_trace = traceback.format_exc()
        print(f"[DAEMON ERROR] {error_trace}")

        # Attempt to extract session_id from filename if payload was read
        try:
            session_id = job_data.get("session_id")
            supabase.from_('user_vaults').update({'status': 'failed'}).eq('session_id', session_id).execute()
            notifier.send_alert(session_id, "failed", str(e))
        except Exception:
            pass

        # Move failed payload to dead-letter or remove to prevent infinite loop
        if os.path.exists(payload_path):
            failed_path = payload_path + ".failed"
            os.rename(payload_path, failed_path)


def start_daemon():
    print(f"=== HYBRID 1.0 WORKER DAEMON STARTED ===")
    print(f"Monitoring payload directory: {PAYLOAD_DIR}")

    os.makedirs(PAYLOAD_DIR, exist_ok=True)
    os.makedirs(RENDERS_DIR, exist_ok=True)

    while True:
        try:
            if os.path.exists(PAYLOAD_DIR):
                files = [os.path.join(PAYLOAD_DIR, f) for f in os.listdir(PAYLOAD_DIR) if f.endswith('.json')]
                for payload_file in files:
                    process_job(payload_file)
        except Exception as e:
            print(f"[DAEMON LOOP ERROR] {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    start_daemon()
