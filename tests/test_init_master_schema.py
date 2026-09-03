import os
import sqlite3
import sys
import tempfile
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPTS = os.path.join(REPO, "scripts")
for path in (REPO, SCRIPTS):
    if path not in sys.path:
        sys.path.insert(0, path)

from init_master_schema import check_schema, init_schema


class TestInitMasterSchema(unittest.TestCase):
    def test_idempotent_temp_db_wal_and_tables(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "master_catalog.db")
            first = init_schema(db_path)
            second = init_schema(db_path)
            self.assertTrue(first["ok"])
            self.assertTrue(second["ok"])
            self.assertEqual(str(first["journal_mode"]).lower(), "wal")
            self.assertEqual(str(second["journal_mode"]).lower(), "wal")
            for name in (
                "master_ledger",
                "user_tokens",
                "stream_catalog",
                "dsp_telemetry",
                "token_credit_events",
                "token_debit_events",
                "pending_payouts",
            ):
                self.assertIn(name, first["tables"])

            conn = sqlite3.connect(db_path)
            try:
                conn.execute(
                    "INSERT INTO master_ledger (session_id, genre, status, updated_at) VALUES (?, ?, ?, ?)",
                    ("sess_keep", "dark_techno", "QUEUED", "2026-01-01T00:00:00+00:00"),
                )
                conn.commit()
            finally:
                conn.close()

            init_schema(db_path)
            conn = sqlite3.connect(db_path)
            try:
                count = conn.execute("SELECT COUNT(*) FROM master_ledger").fetchone()[0]
                self.assertEqual(int(count), 1)
                cols = {row[1] for row in conn.execute("PRAGMA table_info(master_ledger)")}
                self.assertIn("slice_duration", cols)
                self.assertIn("session_id", cols)
            finally:
                conn.close()

            checked = check_schema(db_path)
            self.assertTrue(checked["ok"])
            self.assertEqual(str(checked["journal_mode"]).lower(), "wal")


if __name__ == "__main__":
    unittest.main()
