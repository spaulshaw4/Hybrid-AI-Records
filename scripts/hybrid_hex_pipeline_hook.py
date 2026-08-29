import os
import hashlib
import argparse
from datetime import datetime, timezone
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


def compute_sha256(file_path):
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(65536), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()


def hex_pipeline_hook(session_id, work_dir):
    print("\n================================================================")
    print(f"CRYPTOGRAPHIC HEX HOOK - LOCKING VAULT FOR: {session_id}")
    print("================================================================")

    master_path = os.path.join(work_dir, "master_output.wav")
    if not os.path.exists(master_path):
        raise FileNotFoundError(f"Master output not found at: {master_path}")

    print("[HEX HOOK] Computing SHA-256 cryptographic master hash...")
    master_hash = compute_sha256(master_path)
    print(f"  -> Master Hash: {master_hash}")

    print("[HEX HOOK] Committing lock to Supabase vault ledger...")

    # Status deliberately stays 'processing' here. upload_master_to_cloud.py
    # promotes it to 'completed' only after the master reaches Supabase Storage,
    # so 'completed' always implies a usable storage_url for the frontend.
    response = supabase.table('user_vaults').update({
        "master_hash": master_hash,
        "updated_at": datetime.now(timezone.utc).isoformat()
    }).eq("session_id", session_id).execute()

    print(f"[SUCCESS] Cryptographic hex lock secured for session {session_id}.")
    return master_hash


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Cryptographic Hex Pipeline Hook")
    parser.add_argument("--session", required=True, help="Session ID")
    parser.add_argument("--dir", required=True, help="Working directory path")
    args = parser.parse_args()

    hex_pipeline_hook(args.session, args.dir)
