import os
import uuid
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


def create_mock_session(genre_lock="heavy_alternative_rock"):
    session_id = f"hyb_test_{uuid.uuid4().hex[:8]}"

    payload = {
        "session_id": session_id,
        "genre_lock": genre_lock,
        "status": "pending",
        "metadata": {
            "test_run": True,
            "target_duration_seconds": 420
        }
    }

    print(f"[MOCK] Injecting test session {session_id} into Supabase...")
    res = supabase.table('user_vaults').insert(payload).execute()

    print(f"[SUCCESS] Mock session created successfully.")
    print(f"Session ID: {session_id}")
    print(f"Genre Lock: {genre_lock}")
    print("\nRun your pipeline with:")
    print(f'.\\run_master_pipeline.ps1 -SessionId "{session_id}"')


if __name__ == "__main__":
    create_mock_session()
