import os
import hashlib
import shutil
import time
import concurrent.futures
from pydub import AudioSegment
from pydub.utils import make_chunks
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise EnvironmentError("Missing Supabase credentials in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Directory configurations on D: Drive
DATA_DIR = r"D:\MusicDatasets"
RAW_AUDIO_DIR = os.path.join(DATA_DIR, "raw_audio")
SPLICED_STAGING_DIR = os.path.join(DATA_DIR, "spliced_staging")
ARCHIVE_RAW_DIR = os.path.join(DATA_DIR, "completed_raw")
ARCHIVE_SLICES_DIR = os.path.join(DATA_DIR, "uploaded_slices")

BUCKET_NAME = "vault-storage"

# Engine parameters optimized for 546 GB dataset
CHUNK_LENGTH_MS = 1000
DB_BATCH_SIZE = 50
UPLOAD_WORKERS = 10  # Throttled to protect local sockets and API limits
UPLOAD_RETRIES = 3
RETRY_DELAY = 5
ARCHIVE_RETENTION_DAYS = 30
DRY_RUN_CLEANUP = True


def compute_sha256(filepath):
    sha256 = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while chunk := f.read(8192):
            sha256.update(chunk)
    return sha256.hexdigest()


def phase_1_local_splicing():
    print("\n================================================================")
    print("PHASE 1: LOCAL D: DRIVE SPLICING (1000ms RESOLUTION)")
    print("================================================================")

    spliced_count = 0
    for root, _, files in os.walk(RAW_AUDIO_DIR):
        for filename in files:
            if not filename.endswith(".wav"):
                continue

            filepath = os.path.join(root, filename)
            relative_path = os.path.relpath(root, RAW_AUDIO_DIR)
            genre = relative_path if relative_path != "." else "unknown"

            print(f"[SPLICER] Cutting: {filepath} | Genre: {genre}")

            audio = AudioSegment.from_file(filepath, format="wav")
            chunks = make_chunks(audio, CHUNK_LENGTH_MS)

            genre_staging_dir = os.path.join(SPLICED_STAGING_DIR, genre)
            os.makedirs(genre_staging_dir, exist_ok=True)

            for i, chunk in enumerate(chunks):
                chunk_name = f"{filename.replace('.wav', '')}_slice_{i}.wav"
                chunk_path = os.path.join(genre_staging_dir, chunk_name)
                chunk.export(chunk_path, format="wav")
                spliced_count += 1

            archive_dest = os.path.join(ARCHIVE_RAW_DIR, genre)
            os.makedirs(archive_dest, exist_ok=True)
            shutil.move(filepath, os.path.join(archive_dest, filename))

    print(f"[PHASE 1 COMPLETE] {spliced_count} total segments staged locally.")


def upload_worker(filepath, filename, genre):
    attempt = 0
    while attempt < UPLOAD_RETRIES:
        try:
            with open(filepath, 'rb') as f:
                supabase.storage.from_(BUCKET_NAME).upload(
                    path=f"spliced/{genre}/{filename}",
                    file=f,
                    file_options={"content-type": "audio/wav"}
                )
            return filename
        except Exception as e:
            attempt += 1
            if attempt >= UPLOAD_RETRIES:
                print(f"[ERROR] Fatal network failure on {filename} after {UPLOAD_RETRIES} attempts.")
                raise e
            print(f"[WARNING] Upload failed for {filename}. Retrying in {RETRY_DELAY}s... ({attempt}/{UPLOAD_RETRIES})")
            time.sleep(RETRY_DELAY)


def phase_2_supabase_transfer():
    print("\n================================================================")
    print("PHASE 2: SUPABASE CLOUD TRANSFER (THROTTLED BATCHING)")
    print("================================================================")

    staged_files = []
    for root, _, files in os.walk(SPLICED_STAGING_DIR):
        for f in files:
            if f.endswith(".wav"):
                staged_files.append((root, f))

    total_files = len(staged_files)
    if total_files == 0:
        print("[TRANSFER] No files in staging directory.")
        return

    print(f"[TRANSFER] Initiating push for {total_files} local slices...")

    db_batch = []
    upload_tasks = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=UPLOAD_WORKERS) as executor:
        for root, filename in staged_files:
            filepath = os.path.join(root, filename)
            relative_path = os.path.relpath(root, SPLICED_STAGING_DIR)
            genre = relative_path if relative_path != "." else "unknown"

            file_hash = compute_sha256(filepath)
            parts = filename.split('_slice_')
            original_file = parts[0] + ".wav"
            slice_index = int(parts[1].replace('.wav', ''))

            upload_tasks.append(executor.submit(upload_worker, filepath, filename, genre))

            db_batch.append({
                "filename": filename,
                "original_file": original_file,
                "slice_index": slice_index,
                "hash": file_hash,
                "genre": genre,
                "status": "archived"
            })

            genre_archive_dir = os.path.join(ARCHIVE_SLICES_DIR, genre)
            os.makedirs(genre_archive_dir, exist_ok=True)
            shutil.move(filepath, os.path.join(genre_archive_dir, filename))

            if len(db_batch) >= DB_BATCH_SIZE:
                supabase.table('audio_slices').insert(db_batch).execute()
                print(f"  -> [LEDGER] Inserted batch of {len(db_batch)} records.")
                db_batch = []

        for future in concurrent.futures.as_completed(upload_tasks):
            future.result()

    if len(db_batch) > 0:
        supabase.table('audio_slices').insert(db_batch).execute()
        print(f"  -> [LEDGER] Inserted final batch of {len(db_batch)} records.")

    print("[PHASE 2 COMPLETE] All files transferred to Supabase successfully.")


def phase_3_cleanup(dry_run=True):
    print("\n================================================================")
    mode_text = "DRY RUN - NO DELETIONS" if dry_run else "ACTIVE DELETION"
    print(f"PHASE 3: LOCAL ARCHIVE CLEANUP ({ARCHIVE_RETENTION_DAYS} DAYS) - [{mode_text}]")
    print("================================================================")

    now = time.time()
    cutoff_time = now - (ARCHIVE_RETENTION_DAYS * 86400)
    flagged_count = 0

    for archive_dir in [ARCHIVE_RAW_DIR, ARCHIVE_SLICES_DIR]:
        for root, _, files in os.walk(archive_dir):
            for filename in files:
                filepath = os.path.join(root, filename)
                file_mtime = os.path.getmtime(filepath)

                if file_mtime < cutoff_time:
                    flagged_count += 1
                    if dry_run:
                        print(f"[CLEANUP DRY RUN] Would delete: {filename}")
                    else:
                        os.remove(filepath)
                        print(f"[CLEANUP ACTIVE] Deleted old archive: {filename}")

    if dry_run:
        print(f"[PHASE 3 COMPLETE] {flagged_count} stale files flagged. Change DRY_RUN_CLEANUP = False to delete.")
    else:
        print(f"[PHASE 3 COMPLETE] {flagged_count} stale files purged.")


if __name__ == "__main__":
    for dir_path in [RAW_AUDIO_DIR, SPLICED_STAGING_DIR, ARCHIVE_RAW_DIR, ARCHIVE_SLICES_DIR]:
        os.makedirs(dir_path, exist_ok=True)

    phase_1_local_splicing()
    phase_2_supabase_transfer()
    phase_3_cleanup(dry_run=DRY_RUN_CLEANUP)
