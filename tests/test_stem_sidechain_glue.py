import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.stem_sidechain_glue import apply_sidechain_glue


class TestStemSidechainGlue(unittest.TestCase):
    def test_kick_pulse_ducks_bass_at_hits(self):
        sr = 44100
        n = sr
        t = np.arange(n) / float(sr)
        bass = 0.4 * np.sin(2 * np.pi * 55.0 * t)
        kick = np.zeros(n, dtype=np.float64)
        hits = [int(0.2 * sr), int(0.5 * sr), int(0.8 * sr)]
        width = int(0.012 * sr)
        for hit in hits:
            kick[hit : hit + width] = 0.95

        out = apply_sidechain_glue(bass, kick, sr=sr, ducking_ratio=0.25, attack_ms=1.0, release_ms=80.0)
        self.assertEqual(out.shape, bass.shape)
        self.assertFalse(np.isnan(out).any())

        delay = int(0.008 * sr)
        span = int(0.025 * sr)
        for hit in hits:
            window = slice(hit + delay, hit + delay + span)
            self.assertLess(
                float(np.mean(np.abs(out[window]))),
                float(np.mean(np.abs(bass[window]))) * 0.90,
            )

    def test_quiet_rhythm_almost_unchanged(self):
        sr = 44100
        t = np.linspace(0, 0.4, int(sr * 0.4), endpoint=False)
        bass = 0.3 * np.sin(2 * np.pi * 62.0 * t)
        quiet = 1e-6 * np.sin(2 * np.pi * 80.0 * t)
        out = apply_sidechain_glue(bass, quiet, sr=sr, ducking_ratio=0.2)
        self.assertEqual(out.shape, bass.shape)
        self.assertLess(float(np.max(np.abs(out - bass))), 1e-5)

    def test_empty_and_stereo(self):
        empty = np.zeros(0, dtype=np.float64)
        self.assertEqual(apply_sidechain_glue(empty, empty, sr=44100).size, 0)
        sr = 8000
        t = np.linspace(0, 0.1, int(sr * 0.1), endpoint=False)
        harm = np.column_stack((0.2 * np.sin(2 * np.pi * 80.0 * t), 0.2 * np.sin(2 * np.pi * 80.0 * t)))
        kick = np.zeros(len(t))
        kick[100:140] = 1.0
        out = apply_sidechain_glue(harm, kick, sr=sr)
        self.assertEqual(out.shape, harm.shape)


if __name__ == "__main__":
    unittest.main()
