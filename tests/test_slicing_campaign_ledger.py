import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from scripts import slicing_campaign_ledger as ledger  # noqa: E402

CAMPAIGN = "test_campaign"


class LedgerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "corpus_index.sqlite")
        self.conn = ledger.open_ledger(self.db)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def enqueue(self, *names):
        entries = [(os.path.join("D:\\src", n), "wav", 1024) for n in names]
        ledger.register_files(self.conn, CAMPAIGN, "src", entries)
        return [path for path, _fmt, _size in entries]


class TestSchemaIsolation(LedgerTestCase):
    def test_only_campaign_tables_are_created(self):
        names = {
            row[0]
            for row in self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        self.assertEqual(
            {n for n in names if not n.startswith("sqlite_")},
            {"campaign_sources", "campaign_files", "campaign_runs", "oneshot_index"},
        )

    def test_init_leaves_indexer_tables_alone(self):
        self.conn.execute("CREATE TABLE slice_index (id INTEGER PRIMARY KEY, file_path TEXT)")
        self.conn.execute("INSERT INTO slice_index (file_path) VALUES ('a.wav')")
        self.conn.commit()

        ledger.init_ledger(self.conn)

        rows = self.conn.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0]
        self.assertEqual(rows, 1)
        self.assertTrue(
            self.conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='oneshot_index'"
            ).fetchone()
        )


class TestWalAndTimeout(LedgerTestCase):
    def test_opens_in_wal_with_30s_busy_timeout(self):
        mode = str(self.conn.execute("PRAGMA journal_mode").fetchone()[0]).lower()
        self.assertEqual(mode, "wal")
        timeout = int(self.conn.execute("PRAGMA busy_timeout").fetchone()[0])
        self.assertEqual(timeout, 30_000)
        self.assertEqual(ledger.BUSY_TIMEOUT_MS, 30_000)


class TestEnqueueAndResume(LedgerTestCase):
    def test_register_files_is_idempotent(self):
        first = self.enqueue("a.wav", "b.wav")
        self.assertEqual(len(first), 2)
        added = ledger.register_files(
            self.conn,
            CAMPAIGN,
            "src",
            [(p, "wav", 1024) for p in first] + [("D:\\src\\c.wav", "wav", 1024)],
        )
        self.assertEqual(added, 1)
        counts = ledger.status_counts(self.conn, CAMPAIGN)
        self.assertEqual(counts[ledger.STATUS_PENDING], 3)

    def test_resume_skips_done_and_skipped(self):
        paths = self.enqueue("a.wav", "b.wav", "c.wav")
        ledger.record_result(
            self.conn,
            campaign=CAMPAIGN,
            file_path=paths[0],
            status=ledger.STATUS_DONE,
            slices_written=7,
        )
        ledger.record_result(
            self.conn,
            campaign=CAMPAIGN,
            file_path=paths[1],
            status=ledger.STATUS_SKIPPED,
            error="one-shot",
        )

        claimed = ledger.claim_batch(self.conn, CAMPAIGN, limit=10)

        self.assertEqual([row["file_path"] for row in claimed], [paths[2]])

    def test_reenqueue_after_done_does_not_reset_status(self):
        paths = self.enqueue("a.wav")
        ledger.record_result(
            self.conn, campaign=CAMPAIGN, file_path=paths[0], status=ledger.STATUS_DONE
        )

        ledger.register_files(self.conn, CAMPAIGN, "src", [(paths[0], "wav", 1024)])

        counts = ledger.status_counts(self.conn, CAMPAIGN)
        self.assertEqual(counts[ledger.STATUS_DONE], 1)
        self.assertEqual(counts[ledger.STATUS_PENDING], 0)

    def test_claim_marks_in_progress_and_counts_attempts(self):
        self.enqueue("a.wav")
        ledger.claim_batch(self.conn, CAMPAIGN, limit=1)
        row = self.conn.execute(
            "SELECT status, attempts, claimed_at FROM campaign_files"
        ).fetchone()
        self.assertEqual(row["status"], ledger.STATUS_IN_PROGRESS)
        self.assertEqual(row["attempts"], 1)
        self.assertGreater(row["claimed_at"], 0.0)

    def test_claim_respects_source_filter(self):
        ledger.register_files(self.conn, CAMPAIGN, "alpha", [("D:\\a\\1.wav", "wav", 1)])
        ledger.register_files(self.conn, CAMPAIGN, "beta", [("D:\\b\\1.wav", "wav", 1)])

        claimed = ledger.claim_batch(self.conn, CAMPAIGN, limit=10, source_name="beta")

        self.assertEqual([row["file_path"] for row in claimed], ["D:\\b\\1.wav"])

    def test_peek_pending_does_not_claim(self):
        paths = self.enqueue("a.wav", "b.wav")
        peeked = ledger.peek_pending(self.conn, CAMPAIGN, limit=10)
        self.assertEqual([row["file_path"] for row in peeked], paths)
        counts = ledger.status_counts(self.conn, CAMPAIGN)
        self.assertEqual(counts[ledger.STATUS_PENDING], 2)
        self.assertEqual(counts[ledger.STATUS_IN_PROGRESS], 0)

    def test_peek_offset_walks_without_mutating(self):
        paths = self.enqueue("a.wav", "b.wav", "c.wav")
        first = ledger.peek_pending(self.conn, CAMPAIGN, limit=1, offset=0)
        second = ledger.peek_pending(self.conn, CAMPAIGN, limit=1, offset=1)
        self.assertEqual(first[0]["file_path"], paths[0])
        self.assertEqual(second[0]["file_path"], paths[1])
        self.assertEqual(
            ledger.status_counts(self.conn, CAMPAIGN)[ledger.STATUS_PENDING], 3
        )


class TestCrashRecovery(LedgerTestCase):
    def test_stale_claims_return_to_pending(self):
        self.enqueue("a.wav", "b.wav")
        ledger.claim_batch(self.conn, CAMPAIGN, limit=2)
        self.conn.execute(
            "UPDATE campaign_files SET claimed_at = ?", (time.time() - 7200.0,)
        )
        self.conn.commit()

        requeued = ledger.requeue_stale(self.conn, CAMPAIGN, max_age_sec=3600.0)

        self.assertEqual(requeued, 2)
        self.assertEqual(
            ledger.status_counts(self.conn, CAMPAIGN)[ledger.STATUS_PENDING], 2
        )

    def test_fresh_claims_are_left_alone(self):
        self.enqueue("a.wav")
        ledger.claim_batch(self.conn, CAMPAIGN, limit=1)

        requeued = ledger.requeue_stale(self.conn, CAMPAIGN, max_age_sec=3600.0)

        self.assertEqual(requeued, 0)
        self.assertEqual(
            ledger.status_counts(self.conn, CAMPAIGN)[ledger.STATUS_IN_PROGRESS], 1
        )

    def test_done_rows_survive_requeue(self):
        paths = self.enqueue("a.wav", "b.wav")
        ledger.record_result(
            self.conn, campaign=CAMPAIGN, file_path=paths[0], status=ledger.STATUS_DONE
        )
        ledger.claim_batch(self.conn, CAMPAIGN, limit=5)

        ledger.requeue_stale(self.conn, CAMPAIGN, max_age_sec=0.0)

        counts = ledger.status_counts(self.conn, CAMPAIGN)
        self.assertEqual(counts[ledger.STATUS_DONE], 1)
        self.assertEqual(counts[ledger.STATUS_PENDING], 1)


class TestFailureHandling(LedgerTestCase):
    def test_failure_is_recorded_not_raised(self):
        paths = self.enqueue("bad.wav")
        ledger.claim_batch(self.conn, CAMPAIGN, limit=1)

        ledger.record_result(
            self.conn,
            campaign=CAMPAIGN,
            file_path=paths[0],
            status=ledger.STATUS_FAILED,
            error="unreadable: malformed header",
        )

        row = self.conn.execute("SELECT status, error FROM campaign_files").fetchone()
        self.assertEqual(row["status"], ledger.STATUS_FAILED)
        self.assertIn("malformed header", row["error"])

    def test_failed_rows_are_not_reclaimed_until_asked(self):
        paths = self.enqueue("bad.wav", "good.wav")
        ledger.record_result(
            self.conn, campaign=CAMPAIGN, file_path=paths[0], status=ledger.STATUS_FAILED
        )

        claimed = ledger.claim_batch(self.conn, CAMPAIGN, limit=10)
        self.assertEqual([row["file_path"] for row in claimed], [paths[1]])

        requeued = ledger.reset_failed(self.conn, CAMPAIGN)
        self.assertEqual(requeued, 1)
        self.assertEqual(
            ledger.status_counts(self.conn, CAMPAIGN)[ledger.STATUS_PENDING], 1
        )

    def test_long_error_text_is_truncated_not_rejected(self):
        paths = self.enqueue("bad.wav")
        ledger.record_result(
            self.conn,
            campaign=CAMPAIGN,
            file_path=paths[0],
            status=ledger.STATUS_FAILED,
            error="x" * 5000,
        )
        row = self.conn.execute("SELECT error FROM campaign_files").fetchone()
        self.assertEqual(len(row["error"]), 2000)


class TestConcurrentWrites(LedgerTestCase):
    def test_write_survives_a_competing_writer(self):
        """A second connection holds the write lock; the ledger must wait it out."""
        self.enqueue("a.wav")
        released = threading.Event()
        started = threading.Event()

        def hold_lock():
            blocker = ledger.connect(self.db)
            blocker.execute("BEGIN IMMEDIATE")
            blocker.execute(
                "CREATE TABLE IF NOT EXISTS other_writer (id INTEGER PRIMARY KEY)"
            )
            started.set()
            time.sleep(0.4)
            blocker.commit()
            blocker.close()
            released.set()

        thread = threading.Thread(target=hold_lock)
        thread.start()
        self.assertTrue(started.wait(timeout=5.0))
        try:
            ledger.record_result(
                self.conn,
                campaign=CAMPAIGN,
                file_path="D:\\src\\a.wav",
                status=ledger.STATUS_DONE,
                slices_written=3,
            )
        finally:
            thread.join()

        self.assertTrue(released.is_set())
        row = self.conn.execute("SELECT status, slices_written FROM campaign_files").fetchone()
        self.assertEqual(row["status"], ledger.STATUS_DONE)
        self.assertEqual(row["slices_written"], 3)

    def test_retry_gives_up_with_a_clear_error(self):
        def always_locked():
            raise sqlite3.OperationalError("database is locked")

        with self.assertRaises(ledger.LedgerError):
            ledger._retry(always_locked)

    def test_retry_reraises_unrelated_operational_errors(self):
        def bad_sql():
            raise sqlite3.OperationalError("no such column: nope")

        with self.assertRaises(sqlite3.OperationalError):
            ledger._retry(bad_sql)


class TestProgressReporting(LedgerTestCase):
    def test_progress_percent_and_slice_totals(self):
        paths = self.enqueue("a.wav", "b.wav", "c.wav", "d.wav")
        ledger.record_result(
            self.conn,
            campaign=CAMPAIGN,
            file_path=paths[0],
            status=ledger.STATUS_DONE,
            slices_written=5,
        )
        ledger.record_result(
            self.conn, campaign=CAMPAIGN, file_path=paths[1], status=ledger.STATUS_SKIPPED
        )

        progress = ledger.campaign_progress(self.conn, CAMPAIGN)

        self.assertEqual(progress["total_files"], 4)
        self.assertEqual(progress["settled"], 2)
        self.assertEqual(progress["remaining"], 2)
        self.assertAlmostEqual(progress["percent"], 50.0)
        self.assertEqual(progress["slices_written"], 5)

    def test_eta_uses_measured_execute_rate(self):
        self.enqueue("a.wav", "b.wav", "c.wav", "d.wav")
        run_id = ledger.start_run(
            self.conn, campaign=CAMPAIGN, mode="execute", workers=2
        )
        self.conn.execute(
            "UPDATE campaign_runs SET started_at = ?, finished_at = ?, files_done = 2 "
            "WHERE id = ?",
            (100.0, 110.0, run_id),
        )
        self.conn.commit()

        progress = ledger.campaign_progress(self.conn, CAMPAIGN)

        self.assertAlmostEqual(progress["files_per_sec"], 0.2)
        self.assertAlmostEqual(progress["eta_sec"], 20.0)

    def test_dry_runs_do_not_pollute_the_rate(self):
        self.enqueue("a.wav")
        run_id = ledger.start_run(
            self.conn, campaign=CAMPAIGN, mode="dry-run", workers=2
        )
        self.conn.execute(
            "UPDATE campaign_runs SET started_at = ?, finished_at = ?, files_done = 500 "
            "WHERE id = ?",
            (100.0, 101.0, run_id),
        )
        self.conn.commit()

        self.assertEqual(ledger._measured_rate(self.conn, CAMPAIGN), 0.0)

    def test_source_rows_round_trip(self):
        ledger.register_source(
            self.conn,
            campaign=CAMPAIGN,
            source_name="mtg",
            source_path="D:\\MusicDatasets\\mtg",
            kind=ledger.KIND_PHRASE,
            total_files=16896,
            bytes_total=123456789,
            est_slices=999,
        )
        ledger.register_source(
            self.conn,
            campaign=CAMPAIGN,
            source_name="mtg",
            source_path="D:\\MusicDatasets\\mtg",
            kind=ledger.KIND_PHRASE,
            total_files=17000,
            bytes_total=123456789,
        )

        rows = ledger.source_rows(self.conn, CAMPAIGN)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["total_files"], 17000)

    def test_format_helpers(self):
        self.assertEqual(ledger.format_duration(0), "0s")
        self.assertEqual(ledger.format_duration(90), "1m30s")
        self.assertEqual(ledger.format_duration(7260), "2h01m")
        self.assertEqual(ledger.format_bytes(1024), "1.0 KB")
        self.assertEqual(ledger.format_bytes(1024**4), "1.0 TB")


class TestOneshotIndexIsolation(LedgerTestCase):
    def test_oneshot_upsert_does_not_touch_slice_index(self):
        self.conn.execute(
            "CREATE TABLE slice_index (id INTEGER PRIMARY KEY, file_path TEXT)"
        )
        self.conn.execute("INSERT INTO slice_index (file_path) VALUES ('phrase.wav')")
        self.conn.commit()

        ledger.upsert_oneshot(
            self.conn,
            file_path=r"D:\MusicDatasets\oneshots\kick\pack__kick.wav",
            source_path=r"D:\MusicDatasets\Kick\kick.wav",
            category="kick",
            duration_sec=0.4,
            peak=0.9,
            rms_db=-12.0,
            spectral_centroid=180.0,
            pitch_hz=55.0,
        )

        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0], 1
        )
        row = self.conn.execute("SELECT * FROM oneshot_index").fetchone()
        self.assertEqual(row["category"], "kick")
        self.assertEqual(row["duration_sec"], 0.4)
        self.assertEqual(row["source_path"], r"D:\MusicDatasets\Kick\kick.wav")

    def test_oneshot_upsert_is_idempotent_on_dest_path(self):
        dest = r"D:\MusicDatasets\oneshots\snare\a__snare.wav"
        ledger.upsert_oneshot(
            self.conn, file_path=dest, source_path="a.wav", category="snare"
        )
        ledger.upsert_oneshot(
            self.conn,
            file_path=dest,
            source_path="a.wav",
            category="snare",
            duration_sec=0.2,
        )
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM oneshot_index").fetchone()[0], 1
        )
        self.assertEqual(
            self.conn.execute("SELECT duration_sec FROM oneshot_index").fetchone()[0],
            0.2,
        )


if __name__ == "__main__":
    unittest.main()
