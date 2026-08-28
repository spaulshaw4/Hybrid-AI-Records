import os
import shutil
import subprocess
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")


def run_health_check():
    print("\n================================================================")
    print("HYBRID 1.0 - PIPELINE PRE-FLIGHT HEALTH CHECK")
    print("================================================================")

    errors = 0

    # 1. Check Environment Variables
    print("[CHECK 1] Verifying Supabase credentials...")
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("  -> [ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.")
        errors += 1
    else:
        print("  -> [OK] Credentials present.")

    # 2. Check Supabase Connection & Bucket
    if SUPABASE_URL and SUPABASE_KEY:
        print("[CHECK 2] Testing Supabase connection and bucket access...")
        try:
            supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
            buckets = supabase.storage.list_buckets()
            bucket_names = [b.name for b in buckets] if buckets else []

            if "vault-storage" in bucket_names:
                print("  -> [OK] Connected to Supabase. Bucket 'vault-storage' found.")
            else:
                print("  -> [WARNING] Connected to Supabase, but bucket 'vault-storage' was not found.")
                errors += 1
        except Exception as e:
            print(f"  -> [ERROR] Failed to connect to Supabase: {e}")
            errors += 1

    # 3. Check Local D: Drive Directories
    print("[CHECK 3] Verifying local D: drive dataset structure...")
    base_dir = r"D:\MusicDatasets"
    required_subdirs = ["spliced_staging", "completed_raw", "uploaded_slices", "renders"]

    if not os.path.exists(base_dir):
        print(f"  -> [WARNING] Base directory {base_dir} does not exist. Creating it now...")
        try:
            os.makedirs(base_dir, exist_ok=True)
        except Exception as e:
            print(f"  -> [ERROR] Could not create base directory: {e}")
            errors += 1

    for subdir in required_subdirs:
        path = os.path.join(base_dir, subdir)
        if os.path.exists(path):
            print(f"  -> [OK] Directory exists: {path}")
        else:
            print(f"  -> [INFO] Creating missing directory: {path}")
            os.makedirs(path, exist_ok=True)

    # 4. Check FFmpeg (Required for pydub audio slicing/summation)
    print("[CHECK 4] Checking FFmpeg binary availability...")
    try:
        subprocess.run(["ffmpeg", "-version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        print("  -> [OK] FFmpeg is installed and accessible in system PATH.")
    except (subprocess.SubprocessError, FileNotFoundError):
        print("  -> [ERROR] FFmpeg not found in system PATH. PyDub requires FFmpeg to process audio files.")
        errors += 1

    print("================================================================")
    if errors == 0:
        print("[STATUS] ALL SYSTEMS GO. Pipeline is fully hardened and ready for execution.")
    else:
        print(f"[STATUS] Health check complete with {errors} issue(s) to resolve.")
    print("================================================================")


if __name__ == "__main__":
    run_health_check()
