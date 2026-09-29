"""Isolated acoustic profiles: centroid / transient / RMS, never the live index."""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.acoustic_profiles import (  # noqa: E402
    LIVE_INDEX_PATHS,
    analyze_buffer,
    analyze_file,
    connect_profiles,
    existing_paths,
    insert_batch,
    row_for_file,
)
from ml.audio_features import TARGET_SR  # noqa: E402


def _pad(sr: int = TARGET_SR, seconds: float = 1.0) -> np.ndarray:
    t = np.linspace(0.0, seconds, int(sr * seconds), endpoint=False)
    return 0.4 * np.sin(2 * np.pi * 110.0 * t)


def _clicks(sr: int = TARGET_SR, seconds: float = 1.0, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(sr * seconds)
    x = np.zeros(n, dtype=np.float64)
    hop = sr // 8
    click = max(8, int(0.012 * sr))
    for start in range(0, n, hop):
        end = min(n, start + click)
        burst = rng.normal(0.0, 1.0, end - start) * np.hanning(end - start)
        x[start:end] += burst
    return x / (np.max(np.abs(x)) + 1e-9)


class TestAcousticProfiles(unittest.TestCase):
    def test_refuses_live_index(self):
        for path in LIVE_INDEX_PATHS:
            with self.assertRaises(RuntimeError):
                connect_profiles(path)

    def test_clicks_are_brighter_and_busier_than_a_pad(self):
        pad = analyze_buffer(_pad(), TARGET_SR)
        drums = analyze_buffer(_clicks(), TARGET_SR)
        self.assertGreater(drums["spectral_centroid"], pad["spectral_centroid"])
        self.assertGreater(drums["transient_density"], pad["transient_density"])
        self.assertGreater(drums["rms_energy"], 0.0)
        self.assertGreater(pad["rms_energy"], 0.0)

    def test_resume_skips_existing_rel_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "hybrid_acoustic_profiles.db")
            staging = os.path.join(tmp, "staging")
            os.makedirs(os.path.join(staging, "drums"))
            wav = os.path.join(staging, "drums", "kick.wav")
            sf.write(wav, _clicks(), TARGET_SR)
            conn = connect_profiles(db)
            profile = analyze_file(wav)
            self.assertIsNotNone(profile)
            insert_batch(conn, [row_for_file(staging, wav, profile)])
            seen = existing_paths(conn)
            conn.close()
            self.assertIn("drums/kick.wav", seen)
            conn2 = sqlite3.connect(db)
            n = conn2.execute("SELECT COUNT(*) FROM stem_features").fetchone()[0]
            conn2.close()
            self.assertEqual(n, 1)


if __name__ == "__main__":
    unittest.main()
