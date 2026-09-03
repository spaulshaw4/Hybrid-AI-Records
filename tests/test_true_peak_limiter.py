import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.true_peak_limiter import apply_true_peak_limiter, measure_true_peak_dbtp


class TestTruePeakLimiter(unittest.TestCase):
    def test_hot_tone_stays_under_ceiling(self):
        sr = 44100
        t = np.linspace(0, 1.0, sr, endpoint=False)
        # Near-Nyquist-ish hot tone: sample peak is legal, ISPs are not.
        tone = 0.98 * np.sin(2 * np.pi * 12000 * t)
        stereo = np.column_stack((tone, tone))
        raw_tp = measure_true_peak_dbtp(stereo)
        self.assertGreater(raw_tp, -0.50)

        limited = apply_true_peak_limiter(stereo, sr=sr, ceiling_dbtp=-0.50)
        self.assertEqual(limited.shape, stereo.shape)
        self.assertFalse(np.isnan(limited).any())
        self.assertLessEqual(measure_true_peak_dbtp(limited), -0.49)

    def test_quiet_signal_unchanged_level(self):
        sr = 44100
        t = np.linspace(0, 0.25, int(sr * 0.25), endpoint=False)
        quiet = 0.05 * np.sin(2 * np.pi * 440 * t)
        stereo = np.column_stack((quiet, quiet))
        limited = apply_true_peak_limiter(stereo, sr=sr)
        # After lookahead delay the tail should still be in-range quiet audio.
        self.assertLess(float(np.max(np.abs(limited))), 0.1)


if __name__ == "__main__":
    unittest.main()
