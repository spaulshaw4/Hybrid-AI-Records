"""Chord-aware selection must change which slice wins, and fail safe."""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine import musical_index  # noqa: E402
from engine.musical_features import (  # noqa: E402
    GRID_STEPS,
    chord_pitch_classes,
    chroma_vector,
    pack_floats,
)
from engine.stem_selector import score_candidate  # noqa: E402
from ml.audio_features import TARGET_SR  # noqa: E402


def _chord_chroma(name: str) -> str:
    pcs = chord_pitch_classes(name)
    t = np.linspace(0.0, 2.0, int(TARGET_SR * 2.0), endpoint=False)
    x = np.zeros_like(t)
    for pc in pcs:
        for octave in (3, 4):
            midi = 12 * (octave + 1) + pc
            x += np.sin(2 * np.pi * 440.0 * (2.0 ** ((midi - 69) / 12.0)) * t)
    return pack_floats(chroma_vector(x / (np.max(np.abs(x)) + 1e-9), TARGET_SR))


def _row(chroma: str | None, **over):
    row = {
        "file_path": over.pop("file_path", "x.wav"),
        "detected_key": "A",
        "estimated_bpm": 120.0,
        "rms_db": -20.0,
        "spectral_centroid": 2200.0,
    }
    if chroma is not None:
        row["chroma"] = chroma
    row.update(over)
    return row


class TestChordAwareScoring(unittest.TestCase):
    def test_fmaj7_slice_wins_an_fmaj7_bar_over_a_clashing_slice(self):
        """The roadmap says Fmaj7; the picker must stop choosing on root label alone."""
        fits = _row(_chord_chroma("Fmaj7"))
        clashes = _row(_chord_chroma("F#"))
        s_fit = score_candidate(fits, "harmonic", "A", 120.0, target_chord="Fmaj7")["score"]
        s_clash = score_candidate(clashes, "harmonic", "A", 120.0, target_chord="Fmaj7")["score"]
        self.assertGreater(s_fit, s_clash)

    def test_identical_rows_only_differ_by_chroma(self):
        """Both rows share detected_key/bpm/centroid, so only content can separate them."""
        a = _row(_chord_chroma("Am7"))
        b = _row(_chord_chroma("Fmaj7"))
        on_am = score_candidate(a, "harmonic", "A", 120.0, target_chord="Am7")
        on_f = score_candidate(b, "harmonic", "A", 120.0, target_chord="Am7")
        self.assertEqual(on_am["key"], on_f["key"])  # same label
        self.assertGreater(on_am["chord"], on_f["chord"])  # different content

    def test_unmeasured_slice_is_neutral_not_punished(self):
        measured_bad = _row(_chord_chroma("F#"))
        unmeasured = _row(None)
        s_bad = score_candidate(measured_bad, "harmonic", "A", 120.0, target_chord="Fmaj7")
        s_unk = score_candidate(unmeasured, "harmonic", "A", 120.0, target_chord="Fmaj7")
        self.assertEqual(s_unk["chord"], 0.5)
        self.assertGreater(s_unk["score"], s_bad["score"])

    def test_no_chord_context_is_byte_identical_to_the_old_scorer(self):
        """Guards every existing caller: no context, no behaviour change."""
        row = _row(_chord_chroma("Fmaj7"))
        plain = score_candidate(row, "harmonic", "A", 120.0)
        self.assertNotIn("chord", plain)
        self.assertNotIn("groove", plain)
        bare = score_candidate(_row(None), "harmonic", "A", 120.0)
        self.assertEqual(plain["score"], bare["score"])

    def test_dead_slice_still_scores_zero_with_chord_context(self):
        dead = _row(_chord_chroma("Fmaj7"), rms_db=-90.0)
        self.assertEqual(score_candidate(dead, "harmonic", "A", 120.0, target_chord="Fmaj7")["score"], 0.0)


class TestGrooveScoring(unittest.TestCase):
    def test_matching_accent_pattern_wins(self):
        four = np.zeros(GRID_STEPS)
        four[[0, 4, 8, 12]] = 1.0
        half = np.zeros(GRID_STEPS)
        half[[0, 8]] = 1.0
        a = _row(None, onset_grid=pack_floats(four))
        b = _row(None, onset_grid=pack_floats(half))
        sa = score_candidate(a, "rhythm", "A", 120.0, groove_target=four)["groove"]
        sb = score_candidate(b, "rhythm", "A", 120.0, groove_target=four)["groove"]
        self.assertGreater(sa, sb)


class TestMusicalIndexFailsSafe(unittest.TestCase):
    def test_missing_db_returns_rows_untouched(self):
        rows = [{"file_path": "nope.wav"}]
        out = musical_index.decorate_rows(rows, conn=None)
        self.assertEqual(out, rows)

    def test_absent_db_file_opens_as_none(self):
        self.assertIsNone(musical_index.open_musical_db(os.path.join(tempfile.gettempdir(), "nx.db")))

    def test_real_db_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "m.db")
            c = sqlite3.connect(db)
            c.execute(
                "CREATE TABLE slice_musical (file_path TEXT PRIMARY KEY, chroma TEXT, "
                "onset_grid TEXT, chroma_root INTEGER, chroma_is_minor INTEGER, "
                "chroma_confidence REAL, downbeat_phase REAL)"
            )
            c.execute(
                "INSERT INTO slice_musical VALUES (?,?,?,?,?,?,?)",
                ("D:/a.wav", _chord_chroma("Fmaj7"), pack_floats(np.zeros(GRID_STEPS)), 5, 0, 0.9, 0.0),
            )
            c.commit()
            c.close()
            conn = musical_index.open_musical_db(db)
            self.assertIsNotNone(conn)
            rows = musical_index.decorate_rows([{"file_path": "D:/a.wav"}, {"file_path": "D:/miss.wav"}], conn=conn)
            conn.close()
            self.assertIn("chroma", rows[0])
            self.assertNotIn("chroma", rows[1])


if __name__ == "__main__":
    unittest.main()
