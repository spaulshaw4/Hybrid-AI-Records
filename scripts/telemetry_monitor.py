import os
import time
import psutil
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


def fetch_telemetry():
    os.system('cls' if os.name == 'nt' else 'clear')
    print("================================================================")
    print("HYBRID 1.0 - TELEMETRY & HEALTH MONITOR")
    print("================================================================")

    # System resource metrics
    cpu_usage = psutil.cpu_percent(interval=1)
    ram = psutil.virtual_memory()
    disk = psutil.disk_usage(r"D:")

    print(f"[SYSTEM METRICS]")
    print(f"  -> CPU Usage: {cpu_usage}%")
    print(f"  -> RAM Usage: {ram.percent}% ({ram.used // (1024**3)} GB / {ram.total // (1024**3)} GB)")
    print(f"  -> D: Drive Free: {disk.free // (1024**3)} GB available out of {disk.total // (1024**3)} GB")

    # Supabase Vault Ledger Telemetry
    print(f"\n[VAULT LEDGER TELEMETRY]")
    try:
        pending = supabase.table('user_vaults').select('session_id', count='exact').eq('status', 'pending').execute()
        processing = supabase.table('user_vaults').select('session_id', count='exact').eq('status', 'processing').execute()
        completed = supabase.table('user_vaults').select('session_id', count='exact').eq('status', 'completed').execute()
        failed = supabase.table('user_vaults').select('session_id', count='exact').eq('status', 'failed').execute()

        print(f"  -> Pending Jobs:  {pending.count if hasattr(pending, 'count') else len(pending.data)}")
        print(f"  -> Processing:    {processing.count if hasattr(processing, 'count') else len(processing.data)}")
        print(f"  -> Completed:     {completed.count if hasattr(completed, 'count') else len(completed.data)}")
        print(f"  -> Failed:        {failed.count if hasattr(failed, 'count') else len(failed.data)}")
    except Exception as e:
        print(f"  -> [ERROR] Failed to query Supabase ledger: {e}")

    print("================================================================")
    print("Monitoring active (Refreshing every 5 seconds. Press Ctrl+C to exit).")


if __name__ == "__main__":
    try:
        while True:
            fetch_telemetry()
            time.sleep(5)
    except KeyboardInterrupt:
        print("\nTelemetry monitor stopped.")
