"""BS.1770-4 loudness kernel — no workstation D: paths required."""
import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.loudness_meter import (  # noqa: E402
    SILENCE_LUFS,
    bs1770_channel_weights,
    measure_loudness,
)


class TestLoudnessMeter(unittest.TestCase):
    def test_fullscale_1khz_stereo_is_near_minus_one_lufs(self):
        """0 dBFS peak 1 kHz stereo sine.

        Ungated z = 1.0 → −0.691 LKFS before K-weight. At 1 kHz the shelf
        boost brings integrated to about 0.0 LUFS on this kernel. Ballpark
        accepted here: −3.5 … +1.0 LUFS (not a certified meter test).
        """
        sr = 48000
        t = np.arange(int(sr * 3.5), dtype=np.float64) / sr
        tone = np.sin(2.0 * np.pi * 1000.0 * t)
        stereo = np.column_stack((tone, tone))
        report = measure_loudness(stereo, sr)
        self.assertFalse(np.isnan(report.integrated_lufs))
        self.assertGreaterEqual(report.integrated_lufs, -3.5)
        self.assertLessEqual(report.integrated_lufs, 1.0)
        self.assertGreaterEqual(report.momentary_max, -3.5)
        self.assertLessEqual(report.momentary_max, 1.0)
        self.assertGreaterEqual(report.short_term_max, -3.5)
        self.assertLessEqual(report.short_term_max, 1.0)
        self.assertAlmostEqual(report.target_gap_db, -14.0 - report.integrated_lufs, places=3)

    def test_silence_is_absolute_gate(self):
        sr = 48000
        silent = np.zeros((sr * 2, 2), dtype=np.float64)
        report = measure_loudness(silent, sr)
        self.assertAlmostEqual(report.integrated_lufs, SILENCE_LUFS, places=1)
        self.assertAlmostEqual(report.momentary_max, SILENCE_LUFS, places=1)
        self.assertAlmostEqual(report.short_term_max, SILENCE_LUFS, places=1)

    def test_mono_shape_and_nan_guard(self):
        sr = 48000
        t = np.arange(sr, dtype=np.float64) / sr
        mono = 0.25 * np.sin(2.0 * np.pi * 1000.0 * t)
        report = measure_loudness(mono, sr)
        self.assertEqual(mono.ndim, 1)
        self.assertTrue(np.isfinite(report.integrated_lufs))

        dirty = mono.copy()
        dirty[10] = np.nan
        dirty[20] = np.inf
        cleaned = measure_loudness(dirty, sr)
        self.assertTrue(np.isfinite(cleaned.integrated_lufs))
        self.assertTrue(np.isfinite(cleaned.short_term_max))
        self.assertTrue(np.isfinite(cleaned.momentary_max))

    def test_empty_and_lfe_ignored(self):
        empty = measure_loudness(np.zeros((0, 2)), 48000)
        self.assertEqual(empty.integrated_lufs, SILENCE_LUFS)

        sr = 48000
        t = np.arange(int(sr * 1.2), dtype=np.float64) / sr
        lfe_only = np.zeros((t.size, 6), dtype=np.float64)
        lfe_only[:, 3] = np.sin(2.0 * np.pi * 1000.0 * t)
        report = measure_loudness(lfe_only, sr)
        self.assertLessEqual(report.integrated_lufs, -60.0)

        weights = bs1770_channel_weights(6)
        self.assertEqual(float(weights[3]), 0.0)
        self.assertAlmostEqual(float(weights[4]), 1.41)


if __name__ == "__main__":
    unittest.main()
