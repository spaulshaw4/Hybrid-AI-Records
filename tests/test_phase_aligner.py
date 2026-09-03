import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.phase_aligner import align_stem_group, align_to_reference  # noqa: E402


class TestPhaseAligner(unittest.TestCase):
    def test_delayed_click_recovers_near_zero_lag(self):
        sr = 44100
        n = sr // 4
        click = np.zeros(n, dtype=np.float64)
        click[2000] = 1.0
        delay = 240
        target = np.zeros_like(click)
        target[2000 + delay] = 1.0
        result = align_to_reference(target, click, sr=sr, max_shift_ms=20.0)
        self.assertEqual(result.lag_samples, delay)
        self.assertTrue(result.applied)
        realigned = align_to_reference(result.aligned, click, sr=sr, max_shift_ms=20.0)
        self.assertEqual(realigned.lag_samples, 0)
        self.assertFalse(np.isnan(result.aligned).any())
        self.assertEqual(result.aligned.shape, target.shape)

    def test_delayed_tone_stereo_same_lag(self):
        sr = 44100
        t = np.linspace(0, 0.4, int(sr * 0.4), endpoint=False)
        tone = 0.5 * np.sin(2 * np.pi * 880.0 * t)
        delay = 160
        ref = np.column_stack((tone, tone * 0.7))
        tgt = np.column_stack((np.concatenate((np.zeros(delay), tone[:-delay])), np.concatenate((np.zeros(delay), tone[:-delay] * 0.7))))
        result = align_to_reference(tgt, ref, sr=sr, max_shift_ms=15.0)
        self.assertAlmostEqual(result.lag_samples, delay, delta=2)
        self.assertEqual(result.aligned.shape, tgt.shape)
        self.assertFalse(np.isnan(result.aligned).any())

    def test_weak_correlation_does_not_invent_lag(self):
        sr = 8000
        rng = np.random.default_rng(0)
        ref = rng.normal(0, 0.2, sr)
        tgt = rng.normal(0, 0.2, sr)
        result = align_to_reference(tgt, ref, sr=sr, max_shift_ms=40.0, min_peak=0.35)
        self.assertEqual(result.lag_samples, 0)
        self.assertFalse(result.applied)
        np.testing.assert_array_equal(result.aligned, tgt)

    def test_align_stem_group(self):
        sr = 16000
        click = np.zeros(sr // 5)
        click[400] = 1.0
        delayed = np.zeros_like(click)
        delayed[400 + 80] = 1.0
        aligned, lags = align_stem_group([click, delayed], sr=sr, reference_index=0, max_shift_ms=20.0)
        self.assertEqual(lags[0], 0)
        self.assertEqual(lags[1], 80)
        self.assertEqual(len(aligned), 2)


if __name__ == "__main__":
    unittest.main()
