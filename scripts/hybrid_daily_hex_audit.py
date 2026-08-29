# scripts/hybrid_daily_hex_audit.py
import os
import sys
import json
import logging
from datetime import datetime
from supabase import create_client, Client
from hybrid_hex_hasher import HybridHexHasher

# Loads .env / .env.local into os.environ before the credential reads below.
# os.environ.get() returns only the process environment and Python does not read
# .env on its own, so credentials configured in a file are otherwise invisible
# here. A value already present in the real environment still wins.
import os as _hybrid_os, sys as _hybrid_sys
_hybrid_sys.path.insert(0, _hybrid_os.path.dirname(_hybrid_os.path.abspath(__file__)))
import hybrid_env  # noqa: F401,E402


class HybridDailyHexAudit:
    def __init__(self):
        self.supabase_url = os.environ.get("SUPABASE_URL")
        self.supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not self.supabase_url or not self.supabase_key:
            raise EnvironmentError("Supabase credentials not found in environment variables.")

        self.supabase: Client = create_client(self.supabase_url, self.supabase_key)
        self.manifest_path = r"D:\MusicDatasets\hybrid_engine_manifest.json"
        self.hasher = HybridHexHasher(self.manifest_path)

        self.renders_dir = r"D:\MusicDatasets\renders"
        self.log_dir = r"D:\MusicDatasets\logs"
        self.audit_log_file = os.path.join(self.log_dir, "daily_hex_audit.log")

        self._setup_logger()

    def _setup_logger(self):
        os.makedirs(self.log_dir, exist_ok=True)
        self.logger = logging.getLogger("HybridHexAudit")
        self.logger.setLevel(logging.INFO)

        # File Handler
        fh = logging.FileHandler(self.audit_log_file)
        fh.setLevel(logging.INFO)

        # Console Handler
        ch = logging.StreamHandler()
        ch.setLevel(logging.INFO)

        formatter = logging.Formatter('%(asctime)s | %(levelname)s | %(message)s')
        fh.setFormatter(formatter)
        ch.setFormatter(formatter)

        self.logger.addHandler(fh)
        self.logger.addHandler(ch)

    def run_daily_audit(self):
        self.logger.info("=== STARTING DAILY HYBRID HEX AUDIT ===")

        if not os.path.exists(self.renders_dir):
            self.logger.error(f"Renders directory not found: {self.renders_dir}")
            return

        sessions = [d for d in os.listdir(self.renders_dir) if os.path.isdir(os.path.join(self.renders_dir, d))]

        metrics = {
            "total_scanned": len(sessions),
            "passed": 0,
            "failed_mismatch": 0,
            "failed_missing_files": 0,
            "orphaned_local": 0
        }

        for session_id in sessions:
            session_path = os.path.join(self.renders_dir, session_id)
            self.logger.info(f"Auditing session: {session_id}")

            # Fetch ledger record
            res = self.supabase.from_('user_vaults').select('metadata').eq('session_id', session_id).execute()

            if not res.data:
                self.logger.warning(f"[{session_id}] ORPHANED LOCAL DIRECTORY - No record in Supabase vault.")
                metrics["orphaned_local"] += 1
                continue

            meta_raw = res.data[0].get('metadata')
            if not meta_raw:
                self.logger.warning(f"[{session_id}] NO METADATA - Session exists in vault but lacks hex fingerprints.")
                metrics["failed_missing_files"] += 1
                continue

            metadata = json.loads(meta_raw) if isinstance(meta_raw, str) else meta_raw
            expected_checksums = metadata.get('hex_checksums', {})

            if not expected_checksums:
                self.logger.warning(f"[{session_id}] NO HEX CHECKSUMS - Vault metadata is missing the 'hex_checksums' dictionary.")
                metrics["failed_missing_files"] += 1
                continue

            session_valid = True
            files_missing = False

            for stem, expected_hex in expected_checksums.items():
                filename = f"{session_id}_{'processed_' if stem != 'MASTER_SUM' else ''}{stem}.wav"
                file_path = os.path.join(session_path, filename)

                if os.path.exists(file_path):
                    computed_hex = self.hasher.generate_stem_hex_checksum(file_path)
                    if computed_hex != expected_hex:
                        self.logger.error(f"[{session_id}] MISMATCH on {stem}: Expected {expected_hex}, Got {computed_hex}")
                        session_valid = False
                else:
                    self.logger.error(f"[{session_id}] MISSING LOCAL FILE: {filename}")
                    session_valid = False
                    files_missing = True

            if session_valid:
                self.logger.info(f"[{session_id}] PASSED cryptographic audit.")
                metrics["passed"] += 1
            else:
                if files_missing:
                    metrics["failed_missing_files"] += 1
                else:
                    metrics["failed_mismatch"] += 1

        self.logger.info("=== DAILY AUDIT SUMMARY ===")
        self.logger.info(f"Total Sessions Scanned: {metrics['total_scanned']}")
        self.logger.info(f"Integrity Verified:     {metrics['passed']}")
        self.logger.info(f"Failed (Mismatch):      {metrics['failed_mismatch']}")
        self.logger.info(f"Failed (Missing Files): {metrics['failed_missing_files']}")
        self.logger.info(f"Orphaned Local Dirs:    {metrics['orphaned_local']}")
        self.logger.info("=== END OF AUDIT ===")


if __name__ == "__main__":
    try:
        audit = HybridDailyHexAudit()
        audit.run_daily_audit()
    except Exception as e:
        logging.error(f"Fatal audit exception: {e}")
        sys.exit(1)
