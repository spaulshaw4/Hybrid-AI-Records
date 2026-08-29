# D:\MusicDatasets\scripts\test_stagnation_healer.py
import os
import sys
import time
import uuid
from datetime import datetime, timezone, timedelta
from supabase import create_client, Client

# Ensure local script directory is in path for module imports
SCRIPTS_DIR = r"D:\MusicDatasets\scripts"
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

# Also allow running straight from the repo checkout
_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)

# Loads .env / .env.local before the credential reads below.
import hybrid_env  # noqa: F401,E402

from pipeline_stagnation_healer import (
    scan_and_heal_stagnant_jobs,
    is_session_process_active,
    STAGNATION_TIMEOUT_MINUTES,
    MAX_AUTO_RETRIES,
)

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("[ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

TEST_USER_ID = "00000000-0000-0000-0000-000000000001"


def test_no_self_match():
    """
    Regression guard. is_session_process_active embeds the session id in a
    PowerShell -like filter, so the query process has the id in its own
    CommandLine and Win32_Process enumerates itself. Without excluding $PID the
    function always returns True and the healer skips every session forever.
    """
    print("[TEST 0/3] Verifying process probe does not match its own query...")
    phantom = f"nonexistent_session_{uuid.uuid4().hex}"
    active = is_session_process_active(phantom)

    if active:
        print("  -> [FAIL] Probe reported a phantom session as active (self-match bug).\n")
        return False

    print("  -> [PASS] Probe correctly reports no active process.\n")
    return True


def run_healer_test():
    test_session_id = f"stagnant_probe_{int(time.time())}_{uuid.uuid4().hex[:6]}"

    # Artificially set updated_at beyond the stall threshold
    stale_timestamp = (datetime.now(timezone.utc) - timedelta(minutes=STAGNATION_TIMEOUT_MINUTES + 5)).isoformat()

    print("================================================================")
    print("HYBRID 1.0 - PIPELINE STAGNATION HEALER INTEGRATION TEST")
    print(f"Test Session ID    : {test_session_id}")
    print(f"Backdated Timestamp: {stale_timestamp}")
    print(f"Stall Threshold    : {STAGNATION_TIMEOUT_MINUTES} minutes")
    print("================================================================\n")

    test_passed = test_no_self_match()

    try:
        # -----------------------------------------------------------------
        # TEST CASE 1: RE-QUEUE ATTEMPT (processing -> pending)
        # -----------------------------------------------------------------
        print("[TEST 1/3] Seeding stagnant session (auto_retry_count = 0)...")

        supabase.table("user_vaults").insert({
            "session_id": test_session_id,
            "user_id": TEST_USER_ID,
            "genre_lock": "heavy_alternative_rock",
            "status": "processing",
            "metadata": {
                "test_probe": True,
                "auto_retry_count": 0
            },
            "created_at": stale_timestamp,
            "updated_at": stale_timestamp
        }).execute()

        print("  -> Inserted artificial stalled session.")
        print("  -> Executing healer evaluation cycle...")
        scan_and_heal_stagnant_jobs()

        res1 = supabase.table("user_vaults").select("*").eq("session_id", test_session_id).execute()
        record1 = res1.data[0] if res1.data else {}
        meta1 = record1.get("metadata") or {}
        status1 = record1.get("status")
        retries1 = meta1.get("auto_retry_count")
        action1 = meta1.get("healing_action")

        print(f"  - Status Post-Scan    : {status1} (Expected: pending)")
        print(f"  - Auto-Retry Count    : {retries1} (Expected: 1)")
        print(f"  - Healing Action Tag  : {action1} (Expected: requeued)")

        if status1 == "pending" and retries1 == 1 and action1 == "requeued":
            print("  -> [PASS] Stagnant job correctly recovered and re-queued.\n")
        else:
            print("  -> [FAIL] Job failed to transition to pending state.\n")
            test_passed = False

        # -----------------------------------------------------------------
        # TEST CASE 2: DEAD-LETTER THRESHOLD (exceeds MAX_AUTO_RETRIES)
        # -----------------------------------------------------------------
        print(f"[TEST 2/3] Simulating stalled session exceeding max retries ({MAX_AUTO_RETRIES})...")

        supabase.table("user_vaults").update({
            "status": "processing",
            "metadata": {
                "test_probe": True,
                "auto_retry_count": MAX_AUTO_RETRIES
            },
            "updated_at": stale_timestamp
        }).eq("session_id", test_session_id).execute()

        print("  -> Executing healer evaluation cycle...")
        scan_and_heal_stagnant_jobs()

        res2 = supabase.table("user_vaults").select("*").eq("session_id", test_session_id).execute()
        record2 = res2.data[0] if res2.data else {}
        meta2 = record2.get("metadata") or {}
        status2 = record2.get("status")
        action2 = meta2.get("healing_action")

        print(f"  - Status Post-Scan    : {status2} (Expected: failed)")
        print(f"  - Healing Action Tag  : {action2} (Expected: dead_letter_failed)")

        if status2 == "failed" and action2 == "dead_letter_failed":
            print("  -> [PASS] Session correctly transitioned to dead-letter failed status.\n")
        else:
            print("  -> [FAIL] Session failed to mark as dead-letter failed.\n")
            test_passed = False

        # -----------------------------------------------------------------
        # TEST CASE 3: NULL updated_at must still be healed
        # -----------------------------------------------------------------
        print("[TEST 3/3] Verifying a row with NULL updated_at is not stranded...")

        supabase.table("user_vaults").update({
            "status": "processing",
            "metadata": {"test_probe": True, "auto_retry_count": 0},
            "updated_at": None
        }).eq("session_id", test_session_id).execute()

        scan_and_heal_stagnant_jobs()

        res3 = supabase.table("user_vaults").select("status").eq("session_id", test_session_id).execute()
        status3 = (res3.data[0].get("status") if res3.data else None)

        print(f"  - Status Post-Scan    : {status3} (Expected: pending or failed, not processing)")

        if status3 != "processing":
            print("  -> [PASS] Row with no updated_at was still evaluated.\n")
        else:
            print("  -> [FAIL] Row with NULL updated_at was skipped and would stall forever.\n")
            test_passed = False

    finally:
        print("[CLEANUP] Removing test artifacts from user_vaults ledger...")
        try:
            supabase.table("user_vaults").delete().eq("session_id", test_session_id).execute()
            print("  -> Cleaned synthetic test session.")
        except Exception as e:
            print(f"  [WARN] Failed to delete test session {test_session_id}: {e}")

    print("================================================================")
    if test_passed:
        print("OVERALL VERDICT: [PASS] Stagnation healer recovery lifecycle verified.")
    else:
        print("OVERALL VERDICT: [FAIL] State transitions did not match expected logic.")
    print("================================================================")


if __name__ == "__main__":
    run_healer_test()
