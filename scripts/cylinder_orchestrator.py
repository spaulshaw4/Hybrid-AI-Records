import os
import argparse
import subprocess
import concurrent.futures
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

RENDERS_DIR = r"D:\MusicDatasets\renders"
BUCKET_NAME = "vault-storage"
DOWNLOAD_WORKERS = 10
SEED_COUNT = 420  # Exactly 7 minutes of 1000ms audio stems


def download_slice(filename, genre, dest_path):
    with open(dest_path, 'wb') as f:
        # Match the new genre-sorted bucket path
        res = supabase.storage.from_(BUCKET_NAME).download(f"spliced/{genre}/{filename}")
        f.write(res)
    return filename


def orchestrate(session_id):
    print("\n================================================================")
    print(f"CYLINDER ORCHESTRATOR - ASSEMBLING: {session_id}")
    print("================================================================")

    session_dir = os.path.join(RENDERS_DIR, session_id, "raw_stems")
    os.makedirs(session_dir, exist_ok=True)

    session_res = supabase.table('user_vaults').select('*').eq('session_id', session_id).execute()
    if not session_res.data:
        raise ValueError(f"Session {session_id} not found in vault.")

    genre = session_res.data[0].get('genre_lock', 'unknown')
    print(f"[ORCHESTRATOR] Locked Genre: {genre}")

    # Fetch slices filtered by genre
    slice_res = supabase.table('audio_slices').select('filename').eq('genre', genre).limit(SEED_COUNT).execute()
    slices = slice_res.data

    # AUTOMATED FEEDER BOT LOGIC
    if not slices:
        print(f"[BOT] Zero {genre} segments found in ledger. Constructing feeder pipeline...")
        feeder_script = r"D:\MusicDatasets\scripts\batch_slicer_upload.py"
        subprocess.run(["python", feeder_script], check=True)

        print("[BOT] Feeder complete. Re-querying ledger...")
        slice_res = supabase.table('audio_slices').select('filename').eq('genre', genre).limit(SEED_COUNT).execute()
        slices = slice_res.data

        if not slices:
            raise ValueError("[ERROR] Feeder constructed data, but exact genre match still failed.")

    print(f"[ORCHESTRATOR] Retrieved {len(slices)} seed segments. Initiating local download...")

    download_tasks = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as executor:
        for s in slices:
            filename = s['filename']
            dest_path = os.path.join(session_dir, filename)
            # Pass the locked genre to the download function
            download_tasks.append(executor.submit(download_slice, filename, genre, dest_path))

        for future in concurrent.futures.as_completed(download_tasks):
            future.result()

    print("[ORCHESTRATOR] Seed segments downloaded. Handing off to Bus Summation.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    args = parser.parse_args()

    orchestrate(args.session)
