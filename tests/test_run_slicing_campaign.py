import os
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from scripts import run_slicing_campaign as campaign  # noqa: E402
from scripts import slicing_campaign_ledger as ledger  # noqa: E402

CAMPAIGN = "test_bulk"


def write_tone(path: str, seconds: float, sr: int = 22050, channels: int = 1) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    t = np.arange(int(seconds * sr), dtype=np.float64) / sr
    tone = 0.4 * np.sin(2.0 * np.pi * 220.0 * t)
    data = np.column_stack([tone] * channels) if channels > 1 else tone
    sf.write(path, data, sr, subtype="PCM_16")
    return path


class TestWorkerBudget(unittest.TestCase):
    def test_indexer_running_caps_at_two(self):
        self.assertEqual(
            campaign.resolve_campaign_workers(None, cpu_count=8, indexer_running=True), 2
        )

    def test_explicit_request_is_clamped_while_indexer_runs(self):
        self.assertEqual(
            campaign.resolve_campaign_workers(8, cpu_count=8, indexer_running=True), 2
        )

    def test_idle_machine_defaults_to_eight(self):
        self.assertEqual(
            campaign.resolve_campaign_workers(None, cpu_count=8, indexer_running=False), 8
        )

    def test_explicit_request_gets_eight_when_idle(self):
        self.assertEqual(
            campaign.resolve_campaign_workers(8, cpu_count=8, indexer_running=False), 8
        )

    def test_never_exceeds_cpu_count(self):
        for cpus in (1, 2, 4, 8, 16):
            workers = campaign.resolve_campaign_workers(
                64, cpu_count=cpus, indexer_running=False, allow_contention=True
            )
            self.assertLessEqual(workers, cpus)
            self.assertGreaterEqual(workers, 1)

    def test_allow_contention_raises_ceiling_but_not_past_cpus(self):
        self.assertEqual(
            campaign.resolve_campaign_workers(
                8, cpu_count=8, indexer_running=True, allow_contention=True
            ),
            8,
        )

    def test_single_cpu_box_still_gets_one_worker(self):
        self.assertEqual(
            campaign.resolve_campaign_workers(None, cpu_count=1, indexer_running=True), 1
        )


class TestDiscovery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_denied_trees_are_never_discovered(self):
        for name in (
            "uploaded_slices",
            "corpus_4s",
            "scratch",
            "renders",
            "oneshots",
            "incoming_zips",
            "db",
            "scripts",
            "raw",
            "raw_packs",
        ):
            os.makedirs(os.path.join(self.root, name), exist_ok=True)

        names = [n for n, _p in campaign.discover_sources(self.root)]

        self.assertEqual(names, ["raw_packs"])

    def test_collect_skips_denied_subdirectories(self):
        write_tone(os.path.join(self.root, "pack", "loop.wav"), 1.0)
        write_tone(os.path.join(self.root, "pack", "corpus_4s", "nested.wav"), 1.0)

        found = [os.path.basename(p) for p, _e, _s in campaign.collect_source_files(
            os.path.join(self.root, "pack")
        )]

        self.assertEqual(found, ["loop.wav"])

    def test_collect_skips_already_sliced_names(self):
        write_tone(os.path.join(self.root, "pack", "loop.wav"), 1.0)
        write_tone(os.path.join(self.root, "pack", "loop_phrase_0001.wav"), 1.0)

        found = [os.path.basename(p) for p, _e, _s in campaign.collect_source_files(
            os.path.join(self.root, "pack")
        )]

        self.assertEqual(found, ["loop.wav"])

    def test_non_audio_files_are_ignored(self):
        pack = os.path.join(self.root, "pack")
        write_tone(os.path.join(pack, "loop.wav"), 1.0)
        with open(os.path.join(pack, "notes.txt"), "w", encoding="utf-8") as handle:
            handle.write("hello")
        with open(os.path.join(pack, "pack.zip"), "wb") as handle:
            handle.write(b"PK\x03\x04")

        found = campaign.collect_source_files(pack)

        self.assertEqual(len(found), 1)

    def test_drive_root_is_refused(self):
        with self.assertRaises(Exception):
            campaign.scan_into_ledger(None, root="D:\\", campaign=CAMPAIGN)

    def test_denied_root_name_is_refused(self):
        denied = os.path.join(self.root, "corpus_4s")
        os.makedirs(denied, exist_ok=True)
        with self.assertRaises(ValueError):
            campaign.scan_into_ledger(None, root=denied, campaign=CAMPAIGN)

    def test_mp3_is_collected(self):
        pack = os.path.join(self.root, "mtg")
        os.makedirs(pack, exist_ok=True)
        write_tone(os.path.join(pack, "loop.wav"), 1.0)
        mp3 = os.path.join(pack, "clip.mp3")
        with open(mp3, "wb") as handle:
            handle.write(b"ID3")
        found = {os.path.basename(p): ext for p, ext, _s in campaign.collect_source_files(pack)}
        self.assertIn("clip.mp3", found)
        self.assertEqual(found["clip.mp3"], "mp3")
        self.assertIn(".mp3", campaign.AUDIO_EXTENSIONS)


class TestOneShotClassification(unittest.TestCase):
    def test_short_sample_marks_source_as_oneshot(self):
        stats = {"probed": 10, "short": 9}
        kind, reason = campaign.classify_source("Kick", stats)
        self.assertEqual(kind, ledger.KIND_ONESHOT)
        self.assertIn("copy", reason.lower())

    def test_long_phrases_stay_phrase_even_with_a_drum_name(self):
        stats = {"probed": 10, "short": 0}
        kind, _reason = campaign.classify_source("Perc", stats)
        self.assertEqual(kind, ledger.KIND_PHRASE)

    def test_unprobeable_oneshot_name_is_skipped(self):
        kind, reason = campaign.classify_source("Hats", {"probed": 0, "short": 0})
        self.assertEqual(kind, ledger.KIND_ONESHOT)
        self.assertIn("nothing could be probed", reason)

    def test_music_tree_is_phrase_material(self):
        kind, _reason = campaign.classify_source("mtg", {"probed": 20, "short": 1})
        self.assertEqual(kind, ledger.KIND_PHRASE)

    def test_oneshot_cutoff_is_one_and_a_half_seconds(self):
        self.assertAlmostEqual(campaign.ONESHOT_MAX_DUR, 1.5)


class TestEstimation(unittest.TestCase):
    def test_output_estimate_scales_with_duration(self):
        entries = [("a.wav", "wav", 1_000_000)]
        stats = {"seconds_per_byte": 1.0 / 176400.0, "mean_channels": 2.0}

        slices, out_bytes = campaign.estimate_source(entries, stats)

        self.assertGreater(slices, 0)
        self.assertGreater(out_bytes, 0)
        # 24-bit output from 16-bit input is 1.5x the source bytes.
        self.assertAlmostEqual(out_bytes / 1_000_000.0, 1.5, places=2)

    def test_missing_probe_yields_zero_estimate(self):
        self.assertEqual(
            campaign.estimate_source([("a.wav", "wav", 10)], {"seconds_per_byte": 0.0}),
            (0, 0),
        )


class TestSliceWorker(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "corpus_4s")
        self.oneshots = os.path.join(self.tmp.name, "oneshots")

    def tearDown(self):
        self.tmp.cleanup()

    def _job(self, path, dry_run=False):
        return (
            path,
            self.out,
            self.oneshots,
            campaign.DEFAULT_TARGET_SR,
            campaign.NOMINAL_DUR,
            campaign.MIN_DUR,
            campaign.MAX_DUR,
            campaign.ONESHOT_MAX_DUR,
            dry_run,
        )

    def test_one_shot_file_is_copied_not_sliced(self):
        path = write_tone(os.path.join(self.tmp.name, "Kick", "kick.wav"), 0.4)

        result = campaign.slice_campaign_file(self._job(path))

        self.assertEqual(result["status"], ledger.STATUS_DONE)
        self.assertTrue(result["layer"].startswith("oneshot/"))
        self.assertEqual(result["oneshot"]["category"], "kick")
        self.assertTrue(os.path.isfile(path), "source must not be deleted")
        self.assertTrue(os.path.isfile(result["oneshot"]["dest"]))
        self.assertFalse(os.path.isdir(self.out), "must not 4s-slice a one-shot")

    def test_one_shot_dry_run_copies_nothing(self):
        path = write_tone(os.path.join(self.tmp.name, "Snare", "snare.wav"), 0.3)

        result = campaign.slice_campaign_file(self._job(path, dry_run=True))

        self.assertEqual(result["status"], ledger.STATUS_DONE)
        self.assertEqual(result["oneshot"]["category"], "snare")
        self.assertFalse(os.path.isdir(self.oneshots))
        self.assertTrue(os.path.isfile(path))

    def test_unreadable_file_is_failed_not_raised(self):
        bad = os.path.join(self.tmp.name, "broken.wav")
        with open(bad, "wb") as handle:
            handle.write(b"not audio at all")

        result = campaign.slice_campaign_file(self._job(bad))

        self.assertEqual(result["status"], ledger.STATUS_FAILED)
        self.assertIn("unreadable", result["error"])

    def test_phrase_file_produces_slices(self):
        path = write_tone(os.path.join(self.tmp.name, "pack", "loop.wav"), 12.0)

        result = campaign.slice_campaign_file(self._job(path))

        self.assertEqual(result["status"], ledger.STATUS_DONE)
        self.assertGreaterEqual(result["slices_written"], 2)
        written = os.listdir(os.path.join(self.out, result["layer"]))
        self.assertEqual(len(written), result["slices_written"])

    def test_dry_run_writes_nothing(self):
        path = write_tone(os.path.join(self.tmp.name, "pack", "loop.wav"), 12.0)

        result = campaign.slice_campaign_file(self._job(path, dry_run=True))

        self.assertGreaterEqual(result["slices_written"], 2)
        self.assertFalse(os.path.isdir(self.out))


class TestCampaignRun(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "MusicDatasets")
        self.out = os.path.join(self.root, "corpus_4s")
        self.oneshots = os.path.join(self.root, "oneshots")
        self.db = os.path.join(self.root, "db", "corpus_index.sqlite")
        os.makedirs(os.path.join(self.root, "db"), exist_ok=True)
        self.conn = ledger.open_ledger(self.db)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _seed(self, count=4, seconds=10.0):
        pack = os.path.join(self.root, "pack")
        paths = [
            write_tone(os.path.join(pack, f"loop_{i}.wav"), seconds) for i in range(count)
        ]
        ledger.register_files(
            self.conn,
            CAMPAIGN,
            "pack",
            [(p, "wav", os.path.getsize(p)) for p in paths],
        )
        return paths

    def _run(self, **kwargs):
        params = dict(
            campaign=CAMPAIGN,
            output_root=self.out,
            oneshot_root=self.oneshots,
            workers=1,
            execute=True,
        )
        params.update(kwargs)
        return campaign.run_campaign(self.conn, **params)

    def test_limit_stops_early_and_leaves_the_rest_pending(self):
        self._seed(4)

        totals = self._run(limit=2, batch_size=1)

        self.assertEqual(totals["files"], 2)
        counts = ledger.status_counts(self.conn, CAMPAIGN)
        self.assertEqual(counts[ledger.STATUS_DONE], 2)
        self.assertEqual(counts[ledger.STATUS_PENDING], 2)

    def test_second_run_resumes_the_remainder(self):
        self._seed(4)
        self._run(limit=2, batch_size=1)

        totals = self._run(batch_size=2)

        self.assertEqual(totals["files"], 2)
        counts = ledger.status_counts(self.conn, CAMPAIGN)
        self.assertEqual(counts[ledger.STATUS_DONE], 4)
        self.assertEqual(counts[ledger.STATUS_PENDING], 0)

    def test_third_run_has_nothing_left_to_do(self):
        self._seed(2)
        self._run()

        totals = self._run()

        self.assertEqual(totals["files"], 0)

    def test_failures_are_recorded_and_the_run_continues(self):
        paths = self._seed(2)
        broken = os.path.join(self.root, "pack", "broken.wav")
        with open(broken, "wb") as handle:
            handle.write(b"garbage")
        ledger.register_files(self.conn, CAMPAIGN, "pack", [(broken, "wav", 7)])

        totals = self._run(batch_size=10)

        self.assertEqual(totals["files"], len(paths) + 1)
        self.assertEqual(totals["failed"], 1)
        self.assertEqual(totals["done"], 2)
        counts = ledger.status_counts(self.conn, CAMPAIGN)
        self.assertEqual(counts[ledger.STATUS_FAILED], 1)

    def test_interrupt_returns_claims_to_pending(self):
        self._seed(3)
        original = campaign.slice_campaign_file
        calls = {"n": 0}

        def flaky(job):
            calls["n"] += 1
            if calls["n"] > 1:
                raise KeyboardInterrupt
            return original(job)

        campaign.slice_campaign_file = flaky
        try:
            totals = self._run(batch_size=3, workers=1)
        finally:
            campaign.slice_campaign_file = original

        self.assertTrue(totals["interrupted"])
        counts = ledger.status_counts(self.conn, CAMPAIGN)
        self.assertEqual(counts[ledger.STATUS_IN_PROGRESS], 0)
        self.assertEqual(counts[ledger.STATUS_DONE], 1)
        self.assertEqual(counts[ledger.STATUS_PENDING], 2)

        totals = self._run(batch_size=3, workers=1)
        self.assertEqual(totals["files"], 2)
        self.assertEqual(
            ledger.status_counts(self.conn, CAMPAIGN)[ledger.STATUS_DONE], 3
        )

    def test_status_line_reports_percent_and_counts(self):
        self._seed(2)
        self._run(limit=1, batch_size=1)

        line = campaign.status_line(self.conn, CAMPAIGN)

        self.assertIn("50.00%", line)
        self.assertIn("done=1", line)
        self.assertIn("pending=1", line)

    def test_dry_run_does_not_mark_files_done(self):
        self._seed(2)
        totals = self._run(execute=False, batch_size=2)
        self.assertEqual(totals["files"], 2)
        counts = ledger.status_counts(self.conn, CAMPAIGN)
        self.assertEqual(counts[ledger.STATUS_PENDING], 2)
        self.assertEqual(counts[ledger.STATUS_DONE], 0)
        self.assertFalse(os.path.isdir(self.out))

    def test_scan_enqueues_discovered_material(self):
        self._seed(2)
        os.makedirs(self.out, exist_ok=True)
        write_tone(os.path.join(self.out, "already_sliced.wav"), 10.0)

        summary = campaign.scan_into_ledger(
            self.conn, root=self.root, campaign=CAMPAIGN
        )

        names = {src["name"] for src in summary["sources"]}
        self.assertIn("pack", names)
        self.assertNotIn("corpus_4s", names)
        self.assertNotIn("db", names)

    def test_scan_enqueues_one_shot_trees_for_copy(self):
        kicks = os.path.join(self.root, "Kick")
        for i in range(4):
            write_tone(os.path.join(kicks, f"kick_{i}.wav"), 0.3)

        summary = campaign.scan_into_ledger(
            self.conn, root=self.root, campaign=CAMPAIGN
        )

        copied = {src["name"] for src in summary["oneshot_sources"]}
        self.assertIn("Kick", copied)
        row = self.conn.execute(
            "SELECT status, kind FROM campaign_sources WHERE source_name = 'Kick'"
        ).fetchone()
        self.assertEqual(row["status"], ledger.STATUS_PENDING)
        self.assertEqual(row["kind"], ledger.KIND_ONESHOT)
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM campaign_files WHERE source_name = 'Kick'"
            ).fetchone()[0],
            4,
        )

    def test_execute_copies_oneshots_and_indexes_them(self):
        kicks = os.path.join(self.root, "Kick")
        path = write_tone(os.path.join(kicks, "kick_0.wav"), 0.4)
        ledger.register_files(
            self.conn, CAMPAIGN, "Kick", [(path, "wav", os.path.getsize(path))]
        )

        totals = self._run(batch_size=1)

        self.assertEqual(totals["oneshots"], 1)
        self.assertTrue(os.path.isfile(path), "source must survive the copy")
        dests = []
        for dirpath, _dirs, files in os.walk(self.oneshots):
            dests.extend(os.path.join(dirpath, name) for name in files)
        self.assertEqual(len(dests), 1)
        row = self.conn.execute("SELECT * FROM oneshot_index").fetchone()
        self.assertEqual(row["category"], "kick")
        self.assertEqual(row["source_path"], path)
        self.assertFalse(os.path.isdir(os.path.join(self.out, "rhythm")))

    def test_unknown_source_filter_is_an_error(self):
        self._seed(1)
        with self.assertRaises(ValueError):
            campaign.scan_into_ledger(
                self.conn, root=self.root, campaign=CAMPAIGN, only_source="nope"
            )


class TestZipListing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.incoming = os.path.join(self.tmp.name, "incoming_zips")
        os.makedirs(self.incoming)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_zip(self, name: str, payload: bytes = b"pk") -> str:
        path = os.path.join(self.incoming, name)
        with open(path, "wb") as handle:
            handle.write(b"PK\x03\x04" + payload)
        return path

    def test_lists_new_zips_and_refuses_fma_full(self):
        landr = self._write_zip("LANDR-pack.zip")
        fma = self._write_zip("fma_full.zip", b"huge")

        census = campaign.list_incoming_zips(self.incoming)

        names = {rec["name"] for rec in census["zips"]}
        refused = {rec["name"] for rec in census["refused"]}
        self.assertIn("LANDR-pack.zip", names)
        self.assertIn("fma_full.zip", refused)
        self.assertEqual(census["extracted"], 0)
        self.assertTrue(os.path.isfile(landr))
        self.assertTrue(os.path.isfile(fma))

    def test_listing_does_not_extract(self):
        self._write_zip("new_pack.zip")
        before = os.listdir(self.tmp.name)
        campaign.list_incoming_zips(self.incoming)
        after = os.listdir(self.tmp.name)
        self.assertEqual(sorted(before), sorted(after))

    def test_refused_zip_helper(self):
        self.assertTrue(campaign.refused_zip_name("fma_full.zip"))
        self.assertTrue(campaign.refused_zip_name("FMA_FULL.ZIP"))
        self.assertFalse(campaign.refused_zip_name("LANDR-20260830.zip"))


if __name__ == "__main__":
    unittest.main()
