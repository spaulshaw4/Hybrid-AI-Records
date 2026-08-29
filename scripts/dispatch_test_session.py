import os
import time
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
