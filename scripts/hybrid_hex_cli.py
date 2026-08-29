# scripts/hybrid_hex_cli.py
import os
import sys
import json
import argparse
from hybrid_hex_hasher import HybridHexHasher
from hybrid_hex_vault_ledger import HybridHexVaultLedger
from supabase import create_client, Client

# Loads .env / .env.local into os.environ before the credential reads below.
# os.environ.get() returns only the process environment and Python does not read
# .env on its own, so credentials configured in a file are otherwise invisible
# here. A value already present in the real environment still wins.
import os as _hybrid_os, sys as _hybrid_sys
_hybrid_sys.path.insert(0, _hybrid_os.path.dirname(_hybrid_os.path.abspath(__file__)))
import hybrid_env  # noqa: F401,E402


class HybridHexCLI:
    def __init__(self):
        self.supabase_url = os.environ.get("SUPABASE_URL")
        self.supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        self.supabase: Client = create_client(self.supabase_url, self.supabase_key)
        self.manifest_path = r"D:\MusicDatasets\hybrid_engine_manifest.json"
        self.hasher = HybridHexHasher(self.manifest_path)
        self.ledger = HybridHexVaultLedger()
        self.renders_dir = r"D:\MusicDatasets\renders"

    def hash_file(self, file_path):
        if not os.path.exists(file_path):
            print(f"[CLI Error] File not found: {file_path}")
            return
        hex_sum = self.hasher.generate_stem_hex_checksum(file_path)
        print(f"[HEX CLI] SHA-256 Checksum for {os.path.basename(file_path)}:")
        print(f"  -> {hex_sum}")

    def register_session(self, session_id, working_dir):
        if not os.path.exists(working_dir):
            print(f"[CLI Error] Working directory not found: {working_dir}")
            return
        self.ledger.register_session_hex_checksums(session_id, working_dir)

    def verify_session(self, session_id):
        session_path = os.path.join(self.renders_dir, session_id)
        if not os.path.exists(session_path):
            print(f"[CLI Error] Local render directory not found for session: {session_id}")
            return

        res = self.supabase.from_('user_vaults').select('metadata').eq('session_id', session_id).execute()
        if not res.data or not res.data[0].get('metadata'):
            print(f"[CLI Error] No metadata or hex fingerprints found in Supabase vault for session: {session_id}")
            return

        meta_raw = res.data[0]['metadata']
        metadata = json.loads(meta_raw) if isinstance(meta_raw, str) else meta_raw
        expected_checksums = metadata.get('hex_checksums', {})

        print(f"[CLI] Verifying hex integrity for session {session_id} against Supabase vault ledger...")

        all_valid = True
        for stem, expected_hex in expected_checksums.items():
            filename = f"{session_id}_{'processed_' if stem != 'MASTER_SUM' else ''}{stem}.wav"
            file_path = os.path.join(session_path, filename)

            if os.path.exists(file_path):
                valid = self.hasher.verify_stem_integrity(file_path, expected_hex)
                if not valid:
                    all_valid = False
            else:
                print(f"  - [{stem}] Missing local file: {filename}")
                all_valid = False

        if all_valid:
            print(f"[CLI SUCCESS] Session {session_id} passed all cryptographic hex integrity verifications.")
        else:
            print(f"[CLI FAILED] Session {session_id} integrity mismatch detected.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 Cryptographic Hex Management CLI")
    subparsers = parser.add_subparsers(dest="command")

    # Hash single file
    hash_parser = subparsers.add_parser("hash", help="Generate SHA-256 hex checksum for an audio file")
    hash_parser.add_argument("--file", required=True, help="Path to audio file")

    # Register session hex records
    reg_parser = subparsers.add_parser("register", help="Compute and commit session hex checksums to Supabase")
    reg_parser.add_argument("--session", required=True, help="Session ID")
    reg_parser.add_argument("--dir", required=True, help="Working directory path")

    # Verify session integrity
    verify_parser = subparsers.add_parser("verify", help="Verify local session renders against Supabase vault hex ledger")
    verify_parser.add_argument("--session", required=True, help="Session ID")

    args = parser.parse_args()
    cli = HybridHexCLI()

    if args.command == "hash":
        cli.hash_file(args.file)
    elif args.command == "register":
        cli.register_session(args.session, args.dir)
    elif args.command == "verify":
        cli.verify_session(args.session)
    else:
        parser.print_help()
