import os
import time
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise EnvironmentError("Missing Supabase credentials in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def dispatch_test_session():
    session_id = f"hyb_test_{int(time.time())}"
    genre_lock = "heavy_alternative_rock"
    user_id = "local_test_user_01"

    print("================================================================")
    print(f"DISPATCHING TEST SESSION: {session_id}")
    print("================================================================")

    try:
        response = supabase.table('user_vaults').insert({
            "session_id": session_id,
            "user_id": user_id,
            "genre_lock": genre_lock,
            "status": "pending",
            "metadata": {
                "target_duration_seconds": 420,
                "token_cost": 2.00,
                "mode": "test_dispatch"
            }
        }).execute()

        print(f"[SUCCESS] Test session {session_id} inserted into Supabase vault ledger.")
        print("[MONITOR] Watch your NSSM daemon log output for pipeline execution.")
    except Exception as e:
        print(f"[ERROR] Failed to dispatch test session: {e}")


if __name__ == "__main__":
    dispatch_test_session()
