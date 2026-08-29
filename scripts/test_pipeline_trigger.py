# D:\MusicDatasets\scripts\test_pipeline_trigger.py
import os
import time
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise EnvironmentError("Missing Supabase credentials in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def trigger_test_session():
    test_user_id = "00000000-0000-0000-0000-000000000001"
    session_id = f"hyb_test_{int(time.time())}"
    genre_lock = "heavy_alternative_rock"

    print("================================================================")
    print("HYBRID 1.0 - END-TO-END PIPELINE TEST TRIGGER")
    print(f"Initializing test session: {session_id}")
    print("================================================================")

    # Ensure test incoming files exist so watchdog/staging works smoothly
    incoming_dir = r"D:\MusicDatasets\incoming\heavy_alternative_rock"
    os.makedirs(incoming_dir, exist_ok=True)
    sample_file = os.path.join(incoming_dir, "test_track.wav")

    if not os.path.exists(sample_file):
        print(f"[SETUP] Creating dummy test audio file at {sample_file}...")
        from pydub import AudioSegment
        tone = AudioSegment.sine(440, duration=3000)  # 3 seconds of 440Hz tone
        tone.export(sample_file, format="wav")

    print("[TRIGGER] Inserting pending session into Supabase vault ledger...")
    response = supabase.table('user_vaults').insert({
        "session_id": session_id,
        "user_id": test_user_id,
        "genre_lock": genre_lock,
        "status": "pending",
        "metadata": {
            "token_cost_usd": 2.00,
            "trigger_source": "test_script"
        }
    }).execute()

    print(f"[SUCCESS] Session {session_id} inserted. Polling for state transitions...")

    timeout_sec = 120
    start_time = time.time()

    while time.time() - start_time < timeout_sec:
        res = supabase.table('user_vaults').select('*').eq('session_id', session_id).single().execute()
        data = res.data

        if data:
            status = data.get('status')
            print(f"  -> Current status: [{status.upper()}]")

            if status == 'completed':
                print("\n================================================================")
                print("[SUCCESS] Pipeline execution finished successfully!")
                print(f"  - Session ID : {session_id}")
                print(f"  - Master Hash: {data.get('master_hash')}")
                print(f"  - Storage URL: {data.get('storage_url')}")
                print("================================================================")
                return

            elif status == 'failed':
                print(f"\n[ERROR] Pipeline failed. Metadata: {data.get('metadata')}")
                return

        time.sleep(3)

    print("\n[TIMEOUT] Test execution timed out waiting for completion.")


if __name__ == "__main__":
    trigger_test_session()
