import os
import time
import subprocess
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise EnvironmentError("Missing Supabase credentials in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

POLL_INTERVAL_SECONDS = 10


def poll_vaults():
    print("================================================================")
    print("HYBRID 1.0 - BACKGROUND DAEMON POLLER ACTIVE")
    print("================================================================")

    while True:
        try:
            response = supabase.table('user_vaults').select('*').eq('status', 'pending').limit(1).execute()
            jobs = response.data

            if jobs and len(jobs) > 0:
                job = jobs[0]
                session_id = job['session_id']
                genre_lock = job['genre_lock']

                print(f"\n[DAEMON] Detected pending session: {session_id} | Genre: {genre_lock}")

                supabase.table('user_vaults').update({"status": "processing"}).eq("session_id", session_id).execute()

                ps_script_path = r"D:\MusicDatasets\scripts\run_master_pipeline.ps1"
                result = subprocess.run([
                    "powershell.exe",
                    "-ExecutionPolicy", "Bypass",
                    "-File", ps_script_path,
                    "-SessionId", session_id,
                    "-GenreLock", genre_lock
                ], capture_output=True, text=True)

                if result.returncode == 0:
                    print(f"  -> [DAEMON] Session {session_id} completed successfully.")
                else:
                    print(f"  -> [ERROR] Session {session_id} failed execution.")
                    print(result.stderr)
                    supabase.table('user_vaults').update({"status": "failed"}).eq("session_id", session_id).execute()
            else:
                time.sleep(POLL_INTERVAL_SECONDS)

        except Exception as e:
            print(f"[DAEMON ERROR] Polling loop exception: {e}")
            time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    poll_vaults()
