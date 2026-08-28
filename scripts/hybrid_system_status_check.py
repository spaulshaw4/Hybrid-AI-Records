# scripts/hybrid_system_status_check.py
import os
import sys
import psutil
from supabase import create_client, Client


def check_system_status():
    print("================================================================")
    print("HYBRID 1.0 ALPHA - SYSTEM DIAGNOSTIC & HEALTH CHECK")
    print("================================================================")

    # 1. Directory Checks
    dirs = {
        "Payloads": r"D:\MusicDatasets\job_payloads",
        "Renders": r"D:\MusicDatasets\renders",
        "Samples": r"D:\MusicDatasets\samples",
        "Logs": r"D:\MusicDatasets\logs"
    }

    print("\n[1/3] Verifying Local Directory Architecture...")
    for name, path in dirs.items():
        exists = os.path.exists(path)
        status = "OK (Exists)" if exists else "MISSING (Will be created)"
        print(f"  - {name}: {path} -> {status}")
        if not exists:
            os.makedirs(path, exist_ok=True)

    # 2. Resource Checks
    print("\n[2/3] Checking System Hardware & Python Environment...")
    python_version = sys.version.split()[0]
    print(f"  - Python Runtime: {python_version}")

    memory = psutil.virtual_memory()
    print(f"  - Total RAM: {memory.total / (1024**3):.2f} GB")
    print(f"  - Available RAM: {memory.available / (1024**3):.2f} GB ({memory.percent}% in use)")

    cpu_usage = psutil.cpu_percent(interval=1)
    print(f"  - CPU Utilization: {cpu_usage}%")

    # 3. Supabase Cloud Connection Check
    print("\n[3/3] Verifying Supabase Cloud Vault Connection...")
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

    if not supabase_url or not supabase_key:
        print("  - [WARNING] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables not detected.")
        print("  - Supabase vault operations may fail until environment secrets are configured.")
    else:
        try:
            supabase: Client = create_client(supabase_url, supabase_key)
            res = supabase.from_('user_vaults').select('session_id', count='exact').limit(1).execute()
            print("  - [SUCCESS] Successfully connected to Supabase vault ledger.")
        except Exception as e:
            print(f"  - [ERROR] Failed to communicate with Supabase: {e}")

    print("\n================================================================")
    print("DIAGNOSTIC COMPLETE.")
    print("================================================================")


if __name__ == "__main__":
    check_system_status()
