# scripts/hybrid_hex_vault_ledger.py
import os
import json
import argparse
from supabase import create_client, Client
from hybrid_hex_hasher import HybridHexHasher

# Loads .env / .env.local into os.environ before the credential reads below.
# os.environ.get() returns only the process environment and Python does not read
# .env on its own, so credentials configured in a file are otherwise invisible
# here. A value already present in the real environment still wins.
import os as _hybrid_os, sys as _hybrid_sys
_hybrid_sys.path.insert(0, _hybrid_os.path.dirname(_hybrid_os.path.abspath(__file__)))
import hybrid_env  # noqa: F401,E402


class HybridHexVaultLedger:
    def __init__(self):
        self.supabase_url = os.environ.get("SUPABASE_URL")
        self.supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        self.supabase: Client = create_client(self.supabase_url, self.supabase_key)
        self.manifest_path = r"D:\MusicDatasets\hybrid_engine_manifest.json"
        self.hasher = HybridHexHasher(self.manifest_path)

    def register_session_hex_checksums(self, session_id, working_dir):
        """
        Computes SHA-256 hex checksums for all rendered stems and the master sum,
        then updates the Supabase vault ledger with cryptographic verification metadata.
        """
        print(f"[HEX LEDGER] Generating cryptographic hex fingerprints for session: {session_id}")

        stems = ["drums", "bass", "melody", "vocal", "MASTER_SUM"]
        hex_checksums = {}

        for stem in stems:
            filename = f"{session_id}_{'processed_' if stem != 'MASTER_SUM' else ''}{stem}.wav"
            file_path = os.path.join(working_dir, filename)

            if os.path.exists(file_path):
                hex_hash = self.hasher.generate_stem_hex_checksum(file_path)
                hex_checksums[stem] = hex_hash
                print(f"  - [{stem}] Hex Digest: {hex_hash}")
            else:
                print(f"  - [{stem}] Warning: File not found at {file_path}")

        try:
            # Update Supabase user_vaults record with hex metadata
            res = self.supabase.from_('user_vaults').update({
                'metadata': json.dumps({
                    'hex_checksums': hex_checksums,
                    'verification_status': 'hex_verified'
                })
            }).eq('session_id', session_id).execute()
            print(f"[HEX LEDGER SUCCESS] Session {session_id} hex fingerprints successfully committed to vault ledger.")
            return hex_checksums
        except Exception as e:
            print(f"[HEX LEDGER ERROR] Failed to update Supabase ledger: {e}")
            return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 Hex Vault Ledger Management")
    parser.add_argument('--session', required=True, help='Active session ID')
    parser.add_argument('--dir', required=True, help='Working directory path containing rendered WAV stems')
    args = parser.parse_args()

    ledger = HybridHexVaultLedger()
    ledger.register_session_hex_checksums(args.session, args.dir)
