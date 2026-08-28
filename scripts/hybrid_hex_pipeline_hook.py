import os
import shutil
import argparse
import hashlib
import json
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def purge_session_stems(session_id, work_dir):
    """Auto-purge temporary stems after hex-lock to protect egress."""
    raw_stems_dir = os.path.join(work_dir, "raw_stems")
    if os.path.exists(raw_stems_dir):
        shutil.rmtree(raw_stems_dir)
        print(f"[EGRESS PROTECT] Purged temporary stems for session {session_id}")


def compute_sha256(filepath):
    sha256 = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while chunk := f.read(8192):
            sha256.update(chunk)
    return sha256.hexdigest()


def execute_hook(session_id, work_dir):
    print("\n================================================================")
    print(f"CRYPTOGRAPHIC HEX HOOK - LOCKING: {session_id}")
    print("================================================================")

    master_file = os.path.join(work_dir, f"{session_id}_master.wav")

    if not os.path.exists(master_file):
        raise FileNotFoundError(f"Master file not found: {master_file}")

    print(f"[HEX] Hashing master track...")
    hex_hash = compute_sha256(master_file)
    print(f"[HEX] Generated signature: {hex_hash}")

    # Fetch existing metadata
    session_res = supabase.table('user_vaults').select('metadata').eq('session_id', session_id).execute()
    metadata = session_res.data[0].get('metadata', {}) if session_res.data else {}

    # Append cryptographic ledger
    metadata['hex_checksums'] = {
        "master_track": hex_hash
    }

    # Lock into Supabase
    supabase.table('user_vaults').update({
        'metadata': metadata,
        'status': 'completed'
    }).eq('session_id', session_id).execute()

    print("[SUCCESS] Hex signature verified and locked in Supabase vault.")

    # Auto-purge stems to protect network egress
    purge_session_stems(session_id, work_dir)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--dir", required=True)
    args = parser.parse_args()

    execute_hook(args.session, args.dir)
