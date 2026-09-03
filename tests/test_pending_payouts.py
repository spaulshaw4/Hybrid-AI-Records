import os
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPTS = os.path.join(REPO, "scripts")
for path in (REPO, SCRIPTS):
    if path not in sys.path:
        sys.path.insert(0, path)

from pending_payouts import (  # noqa: E402
    PENDING_PAYOUT_STATUS,
    insert_pending_payout,
    record_from_payload,
)
from send_smtp_mail import send_smtp  # noqa: E402

SAMPLE = {
    "event": "token.purchased",
    "data": {
        "token_amount": 1.00,
        "currency": "USD",
        "song_title": "Heavy Sky",
        "artist_name": "Jester",
        "artist_payout_target": "paypal@artistdomain.com",
        "buyer_email": "fan@example.com",
        "transaction_id": "tx_984729184",
        "stripe_session_id": "cs_test_fan_1",
    },
}


class TestPendingPayouts(unittest.TestCase):
    def test_insert_pending_payout_status_and_idempotent(self):
        conn = sqlite3.connect(":memory:")
        try:
            first = insert_pending_payout(conn, SAMPLE["data"])
            self.assertTrue(first["ok"])
            self.assertTrue(first["inserted"])
            self.assertEqual(first["status"], "Pending Payout")
            self.assertEqual(PENDING_PAYOUT_STATUS, "Pending Payout")

            replay = insert_pending_payout(conn, SAMPLE["data"])
            self.assertTrue(replay["ok"])
            self.assertFalse(replay["inserted"])

            row = conn.execute(
                "SELECT artist_name, song_title, artist_payout_target, buyer_email, "
                "token_amount, currency, status, transaction_id FROM pending_payouts"
            ).fetchone()
            self.assertEqual(
                row,
                (
                    "Jester",
                    "Heavy Sky",
                    "paypal@artistdomain.com",
                    "fan@example.com",
                    1.0,
                    "USD",
                    "Pending Payout",
                    "tx_984729184",
                ),
            )
            count = conn.execute("SELECT COUNT(*) FROM pending_payouts").fetchone()[0]
            self.assertEqual(int(count), 1)
        finally:
            conn.close()

    def test_record_from_payload_uses_parameterized_insert(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "master_catalog.db")
            first = record_from_payload(db_path, SAMPLE)
            second = record_from_payload(db_path, SAMPLE)
            self.assertTrue(first["inserted"])
            self.assertFalse(second["inserted"])
            conn = sqlite3.connect(db_path)
            try:
                status = conn.execute(
                    "SELECT status FROM pending_payouts WHERE transaction_id = ?",
                    ("tx_984729184",),
                ).fetchone()[0]
                self.assertEqual(status, "Pending Payout")
            finally:
                conn.close()

    def test_smtp_fallback_reads_env_only_and_never_hardcodes_password(self):
        source = os.path.join(SCRIPTS, "send_smtp_mail.py")
        with open(source, encoding="utf-8") as handle:
            text = handle.read()
        self.assertNotIn("YOUR_SMTP_PASSWORD", text)
        self.assertNotIn("smtp_password = \"", text.lower().replace(" ", ""))

        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SMTP_HOST", None)
            os.environ.pop("SMTP_USER", None)
            os.environ.pop("SMTP_PASSWORD", None)
            result = send_smtp(
                {
                    "to": "spaulshaw4@gmail.com",
                    "from": "Hybrid AI Records <notifications@hybrid-ai-records.com>",
                    "subject": "New Artist Token Purchase",
                    "text": "test",
                }
            )
            self.assertFalse(result["ok"])
            self.assertEqual(result["reason"], "smtp_not_configured")


if __name__ == "__main__":
    unittest.main()
