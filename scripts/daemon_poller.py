# D:\MusicDatasets\scripts\daemon_poller.py
import os
import time
import subprocess
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise EnvironmentError("Missing Supabase credentials in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

POLL_INTERVAL_SEC = 10
DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001"


def poll_vault_ledger():
    print("================================================================")
    print("HYBRID 1.0 - LOCAL WORKSTATION DAEMON POLLER")
    print("Polling Supabase vault ledger for pending sessions...")
    print("================================================================")

    while True:
        try:
            response = supabase.table('user_vaults').select('*').eq('status', 'pending').order('created_at', desc=False).limit(1).execute()
            jobs = response.data

            if jobs and len(jobs) > 0:
                job = jobs[0]
                session_id = job['session_id']
                user_id = job.get('user_id') or DEFAULT_USER_ID
                genre_lock = job.get('genre_lock', 'heavy_alternative_rock')

                print(f"\n[DAEMON] Discovered pending session: {session_id}")
                print(f"  -> User UUID: {user_id}")
                print(f"  -> Genre Lock: {genre_lock}")

                supabase.table('user_vaults').update({"status": "processing"}).eq("session_id", session_id).execute()

                ps_script_path = r"D:\MusicDatasets\scripts\run_master_pipeline.ps1"
                cmd = [
                    "powershell.exe",
                    "-ExecutionPolicy", "Bypass",
                    "-File", ps_script_path,
                    "-SessionId", session_id,
                    "-GenreLock", genre_lock,
                    "-UserId", user_id
                ]

                print(f"[DAEMON] Executing pipeline orchestrator with user telemetry binding...")
                process = subprocess.run(cmd, capture_output=True, text=True)

                if process.returncode == 0:
                    print(f"[SUCCESS] Pipeline execution finished successfully for {session_id}.")
                else:
                    print(f"[ERROR] Pipeline execution failed for {session_id}:")
                    print(process.stderr)
                    supabase.table('user_vaults').update({
                        "status": "failed",
                        "metadata": {"error_output": process.stderr[:500]}
                    }).eq("session_id", session_id).execute()

        except Exception as e:
            print(f"[DAEMON EXCEPTION] {e}")

        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    poll_vault_ledger()
