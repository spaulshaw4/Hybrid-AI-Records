import os
import argparse
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise EnvironmentError("Missing Supabase credentials in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

BUCKET_NAME = "vault-storage"


def upload_master_to_cloud(session_id, work_dir):
    print("\n================================================================")
    print(f"CLOUD PERSISTENCE - UPLOADING MASTER TO SUPABASE: {session_id}")
    print("================================================================")

    master_path = os.path.join(work_dir, "master_output.wav")
    if not os.path.exists(master_path):
        raise FileNotFoundError(f"Master output not found at: {master_path}")

    storage_path = f"{session_id}/master_output.wav"

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
    supabase.table('user_vaults').update({
        "storage_url": public_url,
        "metadata": {
            "storage_bucket": BUCKET_NAME,
            "storage_path": storage_path
        }
    }).eq("session_id", session_id).execute()

    print(f"[SUCCESS] Master track uploaded and linked in Supabase: {public_url}")
    return public_url


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Upload Master to Supabase Storage")
    parser.add_argument("--session", required=True, help="Session ID")
    parser.add_argument("--dir", required=True, help="Working directory path")
    args = parser.parse_args()

    upload_master_to_cloud(args.session, args.dir)
