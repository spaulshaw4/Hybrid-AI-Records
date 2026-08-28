import os
import hashlib
import argparse
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise EnvironmentError("Missing Supabase credentials in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def compute_sha256(filepath):
    sha256 = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while chunk := f.read(8192):
            sha256.update(chunk)
    return sha256.hexdigest()


def execute_hex_hook(session_id, work_dir):
    print("\n================================================================")
    print(f"CRYPTOGRAPHIC HEX HOOK - LOCKING VAULT FOR: {session_id}")
    print("================================================================")

    master_path = os.path.join(work_dir, "master_output.wav")
    if not os.path.exists(master_path):
        raise FileNotFoundError(f"Master output track not found at: {master_path}")

    print(f"[HEX HOOK] Computing SHA-256 hash for master track...")
    file_hash = compute_sha256(master_path)
    print(f"[HEX HOOK] Hash Locked: {file_hash}")

    print(f"[HEX HOOK] Updating Supabase vault ledger...")
    response = supabase.table('user_vaults').update({
        "status": "completed",
        "master_hash": file_hash,
        "metadata": {
            "render_status": "locked",
            "sha256": file_hash
        }
    }).eq("session_id", session_id).execute()

    print(f"[SUCCESS] Cryptographic signature locked and vault updated for session: {session_id}")
    return file_hash


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid Hex Pipeline Hook")
    parser.add_argument("--session", required=True, help="Session ID")
    parser.add_argument("--dir", required=True, help="Working directory path")
    args = parser.parse_args()

    execute_hex_hook(args.session, args.dir)
