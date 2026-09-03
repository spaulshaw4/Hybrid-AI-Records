import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.polarity_inverter_check import check_polarity  # noqa: E402


class TestPolarityInverterCheck(unittest.TestCase):
    def test_inverted_tone_recommends_flip(self):
        sr = 44100
        t = np.linspace(0, 0.25, int(sr * 0.25), endpoint=False)
        tone = 0.4 * np.sin(2 * np.pi * 440 * t)
        report = check_polarity(-tone, tone)
        self.assertFalse(report.silent)
        self.assertTrue(report.recommend_flip)
        self.assertGreater(report.inverted_correlation, report.correlation)
        self.assertGreater(report.inverted_sum_rms, report.sum_rms)

    def test_aligned_tone_does_not_flip(self):
        sr = 8000
        t = np.linspace(0, 0.1, int(sr * 0.1), endpoint=False)
        tone = 0.3 * np.sin(2 * np.pi * 220 * t)
        stereo = np.column_stack((tone, tone))
        report = check_polarity(stereo, stereo)
        self.assertFalse(report.recommend_flip)

    def test_silent_is_nan(self):
        zeros = np.zeros(256)
        report = check_polarity(zeros, zeros)
        self.assertTrue(report.silent)
        self.assertTrue(np.isnan(report.correlation))
        self.assertFalse(report.recommend_flip)


if __name__ == "__main__":
    unittest.main()
