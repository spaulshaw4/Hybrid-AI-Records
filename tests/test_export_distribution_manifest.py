import json
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

from export_distribution_manifest import export_mastered_rows, write_csv, write_json  # noqa: E402


class TestExportDistributionManifest(unittest.TestCase):
    def test_empty_catalog_does_not_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "empty.db")
            payload = export_mastered_rows(db, status="MASTERED")
            self.assertEqual(payload["count"], 0)
            self.assertEqual(payload["records"], [])
            json_path = os.path.join(tmp, "out.json")
            csv_path = os.path.join(tmp, "out.csv")
            write_json(payload, json_path)
            write_csv(payload, csv_path)
            with open(json_path, encoding="utf-8") as handle:
                loaded = json.loads(handle.read())
            self.assertEqual(loaded["records"], [])
            with open(csv_path, encoding="utf-8") as handle:
                header = handle.readline()
            self.assertTrue(header)

    def test_missing_stream_catalog_and_null_s3(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "ledger.db")
            conn = sqlite3.connect(db)
            conn.execute(
                """
                CREATE TABLE master_ledger (
                    session_id TEXT PRIMARY KEY,
                    genre TEXT,
                    s3_key TEXT,
                    true_peak_dbtp REAL,
                    phase_correlation REAL,
                    status TEXT,
                    updated_at TEXT
                )
                """
            )
            conn.execute(
                "INSERT INTO master_ledger VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("s1", "techno", None, None, 0.91, "MASTERED", "2026-01-01T00:00:00+00:00"),
            )
            conn.commit()
            conn.close()
            payload = export_mastered_rows(db)
            self.assertEqual(payload["count"], 1)
            row = payload["records"][0]
            self.assertIsNone(row["s3_key"])
            self.assertIsNone(row["true_peak_dbtp"])
            self.assertEqual(row["phase_correlation"], 0.91)


if __name__ == "__main__":
    unittest.main()
