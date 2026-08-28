import os
import hashlib
import shutil
import time
import zipfile
import concurrent.futures
from pydub import AudioSegment
from pydub.utils import make_chunks
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise EnvironmentError("Missing Supabase credentials in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Directory configurations on D: Drive matching your workspace
DATA_DIR = r"D:\MusicDatasets"
SPLICED_STAGING_DIR = os.path.join(DATA_DIR, "spliced_staging")
ARCHIVE_RAW_DIR = os.path.join(DATA_DIR, "completed_raw")
ARCHIVE_SLICES_DIR = os.path.join(DATA_DIR, "uploaded_slices")

BUCKET_NAME = "vault-storage"

# Engine parameters
CHUNK_LENGTH_MS = 1000
DB_BATCH_SIZE = 50
UPLOAD_WORKERS = 10
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


def extract_incoming_archives():
    print("\n================================================================")
    print("ARCHIVE EXTRACTION - UNPACKING INCOMING BUNDLES")
    print("================================================================")

    unpacked_count = 0
    for root, _, files in os.walk(DATA_DIR):
        # Skip staging and archive directories
        if "spliced_staging" in root or "completed_raw" in root or "uploaded_slices" in root:
            continue

        for filename in files:
            if not filename.endswith(".zip"):
                continue

            zip_path = os.path.join(root, filename)
            folder_name = os.path.splitext(filename)[0].lower().replace(" ", "_")
            extract_dest = os.path.join(root, folder_name)

            os.makedirs(extract_dest, exist_ok=True)
            print(f"[UNZIP] Extracting {filename} into: {folder_name}")

            try:
                with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                    zip_ref.extractall(extract_dest)
                os.remove(zip_path)
                unpacked_count += 1
            except Exception as e:
                print(f"[ERROR] Failed to extract {filename}: {e}")

    print(f"[EXTRACTION COMPLETE] {unpacked_count} zip archives unpacked.")


def phase_1_local_splicing():
    print("\n================================================================")
    print("PHASE 1: RECURSIVE D: DRIVE SPLICING (1000ms RESOLUTION)")
    print("================================================================")

    spliced_count = 0

    # Walk through all folders inside D:\MusicDatasets
    for root, _, files in os.walk(DATA_DIR):
        # Skip system working folders
        if any(sub in root for sub in ["spliced_staging", "completed_raw", "uploaded_slices", "renders"]):
            continue

        for filename in files:
            if not filename.lower().endswith((".wav", ".mp3", ".flac")):
                continue

            filepath = os.path.join(root, filename)

            # Derive genre tag from the immediate parent folder name
            relative_path = os.path.relpath(root, DATA_DIR)
            genre = relative_path.split(os.sep)[0].lower().replace(" ", "_")
            if genre == "." or not genre:
                genre = "unknown"

            print(f"[SPLICER] Cutting: {filename} | Genre Tag: {genre}")

            try:
                audio = AudioSegment.from_file(filepath)
                chunks = make_chunks(audio, CHUNK_LENGTH_MS)

                genre_staging_dir = os.path.join(SPLICED_STAGING_DIR, genre)
                os.makedirs(genre_staging_dir, exist_ok=True)

                for i, chunk in enumerate(chunks):
                    chunk_name = f"{os.path.splitext(filename)[0]}_slice_{i}.wav"
                    chunk_path = os.path.join(genre_staging_dir, chunk_name)
                    chunk.export(chunk_path, format="wav")
                    spliced_count += 1

                archive_dest = os.path.join(ARCHIVE_RAW_DIR, genre)
                os.makedirs(archive_dest, exist_ok=True)
                shutil.move(filepath, os.path.join(archive_dest, filename))
            except Exception as e:
                print(f"[ERROR] Could not process {filename}: {e}")

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
                raise e
            time.sleep(RETRY_DELAY)


def phase_2_supabase_transfer():
    print("\n================================================================")
    print("PHASE 2: SUPABASE CLOUD TRANSFER (GENRE-SORTED BUCKETS)")
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

    print(f"[TRANSFER] Pushing {total_files} slices to Supabase...")

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

    print("[PHASE 2 COMPLETE] Transfer finished.")


def phase_3_cleanup(dry_run=True):
    print("\n================================================================")
    mode_text = "DRY RUN - NO DELETIONS" if dry_run else "ACTIVE DELETION"
    print(f"PHASE 3: CLEANUP ({ARCHIVE_RETENTION_DAYS} DAYS) - [{mode_text}]")
    print("================================================================")

    now = time.time()
    cutoff_time = now - (ARCHIVE_RETENTION_DAYS * 86400)
    flagged_count = 0

    for archive_dir in [ARCHIVE_RAW_DIR, ARCHIVE_SLICES_DIR]:
        for root, _, files in os.walk(archive_dir):
            for filename in files:
                filepath = os.path.join(root, filename)
                if os.path.getmtime(filepath) < cutoff_time:
                    flagged_count += 1
                    if dry_run:
                        print(f"[CLEANUP DRY RUN] Would delete: {filename}")
                    else:
                        os.remove(filepath)

    print(f"[PHASE 3 COMPLETE] {flagged_count} stale files processed.")


if __name__ == "__main__":
    for dir_path in [SPLICED_STAGING_DIR, ARCHIVE_RAW_DIR, ARCHIVE_SLICES_DIR]:
        os.makedirs(dir_path, exist_ok=True)

    extract_incoming_archives()
    phase_1_local_splicing()
    phase_2_supabase_transfer()
    phase_3_cleanup(dry_run=DRY_RUN_CLEANUP)
