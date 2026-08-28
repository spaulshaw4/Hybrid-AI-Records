# scripts/test_pipeline_integration.py
import os
import json
import time
import subprocess
import shutil
import numpy as np
import soundfile as sf

PAYLOAD_DIR = r"D:\MusicDatasets\job_payloads"
RENDERS_DIR = r"D:\MusicDatasets\renders"
TEST_SESSION_ID = f"hybrid_test_{int(time.time())}"


def run_integration_test():
    """Run full pipeline integration test with mock payload."""
    print(f"[INTEGRATION TEST] Initializing test session: {TEST_SESSION_ID}")

    # Step 1: Create mock job payload
    os.makedirs(PAYLOAD_DIR, exist_ok=True)
    test_payload = {
        "session_id": TEST_SESSION_ID,
        "genre_lock": "nu_metal",
        "target_bpm": 118,
        "target_length_sec": 10,  # Short duration for fast testing
        "arrangement_tags": ["verse", "chorus"]
    }

    payload_path = os.path.join(PAYLOAD_DIR, f"job_{TEST_SESSION_ID}.json")
    with open(payload_path, 'w') as f:
        json.dump(test_payload, f, indent=2)
    print(f"[INTEGRATION TEST] Mock payload written to: {payload_path}")

    # Step 2: Run Master Engine
    print("[INTEGRATION TEST] Executing master engine core assembly...")
    res_engine = subprocess.run(
        ["python", r"D:\MusicDatasets\scripts\master_engine.py", "--payload", payload_path],
        capture_output=True,
        text=True
    )

    if res_engine.returncode != 0:
        print(f"[TEST ERROR] Master engine failed:\n{res_engine.stderr}")
        return False

    print("[INTEGRATION TEST] Master engine completed successfully.")

    # Step 3: Run Cylinder Orchestrator
    print("[INTEGRATION TEST] Executing parallel cylinder pipeline...")
    res_cyl = subprocess.run(
        ["python", r"D:\MusicDatasets\scripts\cylinder_orchestrator.py", "--payload", payload_path],
        capture_output=True,
        text=True
    )

    if res_cyl.returncode != 0:
        print(f"[TEST ERROR] Cylinder orchestrator failed:\n{res_cyl.stderr}")
        return False

    print("[INTEGRATION TEST] Cylinder processing completed successfully.")

    # Step 4: Run Bus Summation
    working_dir = os.path.join(RENDERS_DIR, TEST_SESSION_ID)
    print("[INTEGRATION TEST] Executing cylinder bus summation...")
    res_sum = subprocess.run(
        ["python", r"D:\MusicDatasets\scripts\cylinder_bus_summation.py",
         "--session", TEST_SESSION_ID,
         "--dir", working_dir],
        capture_output=True,
        text=True
    )

    if res_sum.returncode != 0:
        print(f"[TEST ERROR] Bus summation failed:\n{res_sum.stderr}")
        return False

    print("[INTEGRATION TEST] Bus summation completed successfully.")

    # Step 5: Verify Output Artifacts
    expected_files = [
        f"{TEST_SESSION_ID}_MASTER.wav",
        f"{TEST_SESSION_ID}_processed_drums.wav",
        f"{TEST_SESSION_ID}_processed_bass.wav",
        f"{TEST_SESSION_ID}_processed_melody.wav",
        f"{TEST_SESSION_ID}_processed_vocal.wav",
        f"{TEST_SESSION_ID}_MASTER_SUM.wav"
    ]

    all_exist = True
    for fname in expected_files:
        fpath = os.path.join(working_dir, fname)
        if os.path.exists(fpath):
            print(f"  [PASS] Artifact verified: {fname}")
        else:
            print(f"  [FAIL] Missing artifact: {fname}")
            all_exist = False

    # Cleanup payload if still present
    if os.path.exists(payload_path):
        os.remove(payload_path)

    if all_exist:
        print(f"\n[INTEGRATION TEST SUCCESS] All pipeline stages verified for session {TEST_SESSION_ID}.")
        return True
    else:
        print(f"\n[INTEGRATION TEST FAILED] One or more artifacts missing.")
        return False


if __name__ == "__main__":
    run_integration_test()
