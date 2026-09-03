import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.stereo_widener import apply_stereo_widener, apply_stereo_widener_report, phase_correlation


class TestStereoWidener(unittest.TestCase):
    def test_mono_passthrough(self):
        sr = 44100
        t = np.linspace(0, 0.4, int(sr * 0.4), endpoint=False)
        mono = (0.25 * np.sin(2 * np.pi * 440 * t)).astype(np.float64)
        out = apply_stereo_widener(mono, width=1.8, sr=sr)
        self.assertEqual(out.shape, mono.shape)
        np.testing.assert_array_equal(out, mono)

    def test_correlated_mid_stays_high(self):
        sr = 44100
        t = np.linspace(0, 0.5, int(sr * 0.5), endpoint=False)
        tone = 0.3 * np.sin(2 * np.pi * 1000 * t)
        stereo = np.column_stack((tone, tone))
        out, used = apply_stereo_widener_report(stereo, width=1.6, sr=sr)
        self.assertEqual(out.shape, stereo.shape)
        self.assertFalse(np.isnan(out).any())
        self.assertGreaterEqual(phase_correlation(out[:, 0], out[:, 1]), 0.80)
        self.assertGreaterEqual(used, 0.0)

    def test_wide_material_backs_off(self):
        sr = 44100
        t = np.linspace(0, 0.6, int(sr * 0.6), endpoint=False)
        # Decorrelated HF: different carriers above the 2 kHz crossover.
        left = 0.35 * np.sin(2 * np.pi * 3200 * t)
        right = 0.35 * np.sin(2 * np.pi * 4100 * t + 0.9)
        stereo = np.column_stack((left, right))
        out, used = apply_stereo_widener_report(stereo, width=2.2, sr=sr, min_correlation=0.80)
        self.assertLess(used, 2.2)
        self.assertGreaterEqual(phase_correlation(out[:, 0], out[:, 1]), 0.79)
        self.assertLessEqual(float(np.max(np.abs(out))), float(np.max(np.abs(stereo))) + 1e-9)


if __name__ == "__main__":
    unittest.main()
