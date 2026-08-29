import os
import argparse
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


def show_stats():
    print("\n================================================================")
    print("HYBRID 1.0 - PIPELINE ADMINISTRATIVE DASHBOARD")
    print("================================================================")

    try:
        vaults = supabase.table('user_vaults').select('status, genre_lock').execute().data
        total_sessions = len(vaults)
        pending = sum(1 for v in vaults if v['status'] == 'pending')
        processing = sum(1 for v in vaults if v['status'] == 'processing')
        completed = sum(1 for v in vaults if v['status'] == 'completed')
        failed = sum(1 for v in vaults if v['status'] == 'failed')

        print(f"Total Vault Sessions: {total_sessions}")
        print(f"  - Pending:    {pending}")
        print(f"  - Processing: {processing}")
        print(f"  - Completed:  {completed}")
        print(f"  - Failed:     {failed}")

        slices_res = supabase.table('audio_slices').select('id', count='exact').execute()
        total_slices = slices_res.count if hasattr(slices_res, 'count') else len(slices_res.data)

        print(f"\nTotal Audio Slices in Cloud Ledger: {total_slices}")
    except Exception as e:
        print(f"[ERROR] Could not fetch telemetry from Supabase: {e}")

    print("================================================================")


if __name__ == "__main__":
    show_stats()
