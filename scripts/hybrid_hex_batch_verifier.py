# scripts/hybrid_hex_batch_verifier.py
import os
import json
import argparse
from hybrid_hex_hasher import HybridHexHasher
from supabase import create_client, Client

# Loads .env / .env.local into os.environ before the credential reads below.
# os.environ.get() returns only the process environment and Python does not read
# .env on its own, so credentials configured in a file are otherwise invisible
# here. A value already present in the real environment still wins.
import os as _hybrid_os, sys as _hybrid_sys
_hybrid_sys.path.insert(0, _hybrid_os.path.dirname(_hybrid_os.path.abspath(__file__)))
import hybrid_env  # noqa: F401,E402


class HexBatchVerifier:
    def __init__(self):
        self.supabase_url = os.environ.get("SUPABASE_URL")
        self.supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        self.supabase: Client = create_client(self.supabase_url, self.supabase_key)
        self.manifest_path = r"D:\MusicDatasets\hybrid_engine_manifest.json"
        self.hasher = HybridHexHasher(self.manifest_path)
        self.renders_dir = r"D:\MusicDatasets\renders"

    def verify_all_local_renders(self):
        print("[BATCH HEX VERIFIER] Scanning local renders directory for cryptographic integrity check...")

        if not os.path.exists(self.renders_dir):
            print(f"[BATCH ERROR] Renders directory not found: {self.renders_dir}")
            return

        sessions = os.listdir(self.renders_dir)
        total_sessions = len(sessions)
        passed_count = 0

        for session_id in sessions:
            session_path = os.path.join(self.renders_dir, session_id)
            if not os.path.isdir(session_path):
                continue

            print(f"\n[SESSION INSPECT] Checking session: {session_id}")

            # Fetch expected hex checksums from Supabase vault metadata
            res = self.supabase.from_('user_vaults').select('metadata').eq('session_id', session_id).execute()

            if not res.data or not res.data[0].get('metadata'):
                print(f"  - Warning: No metadata found in Supabase for session {session_id}. Skipping remote comparison.")
                continue

            try:
                meta_raw = res.data[0]['metadata']
                metadata = json.loads(meta_raw) if isinstance(meta_raw, str) else meta_raw
                expected_checksums = metadata.get('hex_checksums', {})
            except Exception as e:
                print(f"  - Error parsing metadata for {session_id}: {e}")
                continue

            session_valid = True
            for stem, expected_hex in expected_checksums.items():
                filename = f"{session_id}_{'processed_' if stem != 'MASTER_SUM' else ''}{stem}.wav"
                file_path = os.path.join(session_path, filename)

                if os.path.exists(file_path):
                    is_valid = self.hasher.verify_stem_integrity(file_path, expected_hex)
                    if not is_valid:
                        session_valid = False
                else:
                    print(f"  - [{stem}] Missing local file: {filename}")
                    session_valid = False

            if session_valid:
                passed_count += 1
                print(f"  -> Session {session_id}: PASSED all hex integrity checks.")
            else:
                print(f"  -> Session {session_id}: FAILED integrity validation.")

        print(f"\n=== BATCH VERIFICATION COMPLETE ===")
        print(f"Total Sessions Scanned: {total_sessions}")
        print(f"Fully Verified & Valid: {passed_count}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 Batch Hex Integrity Verifier")
    args = parser.parse_args()

    verifier = HexBatchVerifier()
    verifier.verify_all_local_renders()
