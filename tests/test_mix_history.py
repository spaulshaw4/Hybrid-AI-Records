"""The ledger must keep the losers, label plays honestly, and refuse the live index."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine import mix_history  # noqa: E402


def _ranked(n: int = 10):
    return [
        {
            "file_path": f"D:/corpus/slice_{i}.wav",
            "score": 1.0 - i * 0.05,
            "score_detail": {
                "key": 0.9,
                "chord": 0.8 - i * 0.01,
                "bpm": 0.7,
                "centroid": 0.6,
                "level": 0.5,
                "groove": 0.4,
            },
        }
        for i in range(n)
    ]


class TestLedger(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "mix.db")
        self.conn = mix_history.open_ledger(self.db)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_refuses_the_live_corpus_index(self):
        for path in mix_history.PROTECTED_DBS:
            with self.assertRaises(RuntimeError):
                mix_history.open_ledger(path)

    def test_losers_are_kept_not_just_the_winner(self):
        """A pick only carries information relative to what it beat."""
        mix_history.record_session(self.conn, "s1", progression=["Am7", "Fmaj7"])
        n = mix_history.record_decisions(
            self.conn, "s1", "harmonic", _ranked(10), ["D:/corpus/slice_2.wav"]
        )
        self.assertEqual(n, 10)
        s = mix_history.summary(self.conn)
        self.assertEqual(s["decisions"], 10)
        self.assertEqual(s["chosen"], 1)

    def test_session_upsert_does_not_duplicate(self):
        mix_history.record_session(self.conn, "s1", bpm=120.0)
        mix_history.record_session(self.conn, "s1", bpm=128.0)
        self.assertEqual(mix_history.summary(self.conn)["sessions"], 1)
        bpm = self.conn.execute(
            "SELECT bpm FROM mix_sessions WHERE session_id='s1'"
        ).fetchone()[0]
        self.assertEqual(bpm, 128.0)

    def test_mix_math_attaches_after_the_fact(self):
        mix_history.record_session(self.conn, "s1")
        mix_history.record_mix_math(self.conn, "s1", harmonic_fit=0.57, rms_contrast_db=8.2)
        row = self.conn.execute(
            "SELECT harmonic_fit, rms_contrast_db FROM mix_sessions WHERE session_id='s1'"
        ).fetchone()
        self.assertAlmostEqual(row[0], 0.57)
        self.assertAlmostEqual(row[1], 8.2)


class TestImplicitLabels(unittest.TestCase):
    def test_instant_skip_is_strongly_negative(self):
        self.assertLess(mix_history.label_for_play(1.0, 200.0), -0.9)

    def test_early_skip_is_negative(self):
        self.assertLess(mix_history.label_for_play(20.0, 200.0), 0.0)

    def test_full_playthrough_is_a_full_positive(self):
        self.assertAlmostEqual(mix_history.label_for_play(200.0, 200.0), 1.0)

    def test_label_rises_with_how_much_was_heard(self):
        seq = [mix_history.label_for_play(p, 200.0) for p in (10, 60, 120, 190)]
        self.assertEqual(seq, sorted(seq))

    def test_threshold_is_the_sign_change(self):
        just_under = mix_history.label_for_play(200.0 * mix_history.SKIP_FRACTION - 1, 200.0)
        just_over = mix_history.label_for_play(200.0 * mix_history.SKIP_FRACTION + 1, 200.0)
        self.assertLess(just_under, 0.0)
        self.assertGreaterEqual(just_over, 0.0)

    def test_unknown_duration_is_no_signal(self):
        self.assertEqual(mix_history.label_for_play(10.0, 0.0), 0.0)


class TestVerdicts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = mix_history.open_ledger(os.path.join(self.tmp.name, "m.db"))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_export_is_a_full_positive_without_playback(self):
        self.assertEqual(mix_history.record_verdict(self.conn, "s1", "export"), 1.0)

    def test_skip_records_negative(self):
        label = mix_history.record_verdict(
            self.conn, "s1", "play", position_sec=5.0, duration_sec=200.0
        )
        self.assertLess(label, 0.0)

    def test_training_pairs_only_include_well_received_tracks(self):
        for sid, pos in (("good", 200.0), ("bad", 3.0)):
            mix_history.record_session(self.conn, sid)
            mix_history.record_decisions(self.conn, sid, "harmonic", _ranked(5), ["D:/corpus/slice_0.wav"])
            mix_history.record_verdict(self.conn, sid, "play", position_sec=pos, duration_sec=200.0)
        pairs = mix_history.training_pairs(self.conn)
        self.assertTrue(pairs)
        self.assertEqual({p["session_id"] for p in pairs}, {"good"})
        self.assertIn("fit_chord", pairs[0])


if __name__ == "__main__":
    unittest.main()
