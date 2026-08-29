import os
import argparse
from datetime import datetime, timezone
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise EnvironmentError("Missing Supabase credentials in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

BUCKET_NAME = "vault-storage"


# Supabase Pro allows 5 GB per file, which clears the whole 2:30-7:00 range
# with room to spare: a 7:00 master is 70.7 MB at 16-bit, 106 MB at 24-bit.
#
# Defaulting to the free tier's 50 MB instead would reject every render past
# 4:57 (16-bit) or 3:18 (24-bit), so the guard exists to catch a genuinely
# oversized file rather than to enforce the free-tier ceiling.
#
# On free tier, set HYBRID_MAX_UPLOAD_MB=50.
DEFAULT_MAX_UPLOAD_MB = 5120.0


def check_upload_size(master_path):
    """Returns (ok, size_mb, limit_mb). Verifies the file fits the plan's cap."""
    limit_mb = float(os.environ.get("HYBRID_MAX_UPLOAD_MB", DEFAULT_MAX_UPLOAD_MB))
    size_mb = os.path.getsize(master_path) / (1024.0 * 1024.0)
    return size_mb <= limit_mb, size_mb, limit_mb


def collect_slice_provenance(work_dir):
    """
    Summarise the slices that fed this render.

    Stores a manifest, not the audio. Full slice names are capped because a
    long render can consume thousands and the metadata column should stay small;
    the count and digest still identify the input set exactly.
    """
    import hashlib

    staged = os.path.join(work_dir, "raw_stems")
    premixed = os.path.join(work_dir, "premixed_stems")

    if not os.path.isdir(staged):
        return None

    slices = sorted(f for f in os.listdir(staged) if f.lower().endswith(".wav"))
    if not slices:
        return None

    # Digest over the ordered name list: two renders from the same inputs in the
    # same order produce the same digest, which makes a render reproducible.
    digest = hashlib.sha256("\n".join(slices).encode("utf-8")).hexdigest()

    premix_count = 0
    if os.path.isdir(premixed):
        premix_count = sum(1 for f in os.listdir(premixed) if f.lower().endswith(".wav"))

    MAX_NAMES = 50
    return {
        "slice_count": len(slices),
        "premix_positions": premix_count,
        "slice_set_sha256": digest,
        "slice_names": slices[:MAX_NAMES],
        "slice_names_truncated": len(slices) > MAX_NAMES
    }


def upload_master_to_cloud(session_id, work_dir):
    print("\n================================================================")
    print(f"CLOUD PERSISTENCE - UPLOADING MASTER TO SUPABASE: {session_id}")
    print("================================================================")

    master_path = os.path.join(work_dir, "master_output.wav")
    if not os.path.exists(master_path):
        raise FileNotFoundError(f"Master output not found at: {master_path}")

    storage_path = f"{session_id}/master_output.wav"

    fits, size_mb, limit_mb = check_upload_size(master_path)
    print(f"[CLOUD UPLOADER] Master size: {size_mb:.1f} MB (limit {limit_mb:.0f} MB)")

    if not fits:
        raise ValueError(
            f"Master is {size_mb:.1f} MB, over the {limit_mb:.0f} MB upload limit.\n"
            f"  Uncompressed stereo 44.1 kHz crosses 50 MB at 4:57 (16-bit) or "
            f"3:18 (24-bit).\n"
            f"  Options: shorten the render, drop to 16-bit, raise "
            f"HYBRID_MAX_UPLOAD_MB on a paid plan, or store masters in R2/S3."
        )

    print(f"[CLOUD UPLOADER] Reading master file from {master_path}...")
    with open(master_path, "rb") as f:
        file_bytes = f.read()

    print(f"[CLOUD UPLOADER] Uploading to bucket '{BUCKET_NAME}'...")
    response = supabase.storage.from_(BUCKET_NAME).upload(
        path=storage_path,
        file=file_bytes,
        file_options={"content-type": "audio/wav", "upsert": "true"}
    )

    # Retrieve public URL for the stored master track
    url_response = supabase.storage.from_(BUCKET_NAME).get_public_url(storage_path)
    public_url = url_response if isinstance(url_response, str) else url_response.get("publicUrl")

    print(f"[CLOUD UPLOADER] Updating vault ledger with storage link...")

    # Merge into existing metadata rather than replacing it, so the token cost,
    # trigger source, and enlinement blueprints written earlier survive.
    existing = supabase.table('user_vaults').select('metadata').eq('session_id', session_id).limit(1).execute()
    merged_metadata = {}
    if existing.data and existing.data[0].get('metadata'):
        merged_metadata = dict(existing.data[0]['metadata'])

    merged_metadata.update({
        "storage_bucket": BUCKET_NAME,
        "storage_path": storage_path
    })

    # Record which source slices produced this master, so a track can be traced
    # back to its inputs later. Names only, not the audio: a 7-minute render
    # consumes ~1680 slices, and uploading those would push exactly the egress
    # this pipeline exists to keep local, while duplicating corpus already on D:.
    provenance = collect_slice_provenance(work_dir)
    if provenance:
        merged_metadata["source_provenance"] = provenance
        print(f"[CLOUD UPLOADER] Recorded provenance for {provenance['slice_count']} source slice(s).")

    # This is the point where the session becomes 'completed': the master is
    # verifiably in cloud storage and storage_url is about to be persisted.
    supabase.table('user_vaults').update({
        "storage_url": public_url,
        "status": "completed",
        "metadata": merged_metadata,
        "updated_at": datetime.now(timezone.utc).isoformat()
    }).eq("session_id", session_id).execute()

    print(f"[SUCCESS] Master track uploaded and linked in Supabase: {public_url}")
    print(f"[SUCCESS] Session {session_id} promoted to 'completed'.")
    return public_url


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Upload Master to Supabase Storage")
    parser.add_argument("--session", required=True, help="Session ID")
    parser.add_argument("--dir", required=True, help="Working directory path")
    args = parser.parse_args()

    upload_master_to_cloud(args.session, args.dir)
