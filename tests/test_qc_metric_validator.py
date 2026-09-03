import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.qc_metric_validator import measure_qc
from dsp.true_peak_limiter import measure_true_peak_dbtp


class TestQcMetricValidator(unittest.TestCase):
    def test_quiet_stereo_sine_passes(self):
        sr = 44100
        t = np.linspace(0, 0.5, int(sr * 0.5), endpoint=False)
        tone = 0.1 * np.sin(2 * np.pi * 440.0 * t)
        stereo = np.column_stack((tone, tone))
        report = measure_qc(stereo, sr)
        self.assertTrue(report["pass"], report.get("failures"))
        self.assertLessEqual(report["true_peak_dbtp"], -0.50)
        self.assertGreaterEqual(report["phase_correlation"], 0.80)
        self.assertNotEqual(report["true_peak_dbtp"], report["sample_peak_dbfs"])
        self.assertEqual(report["true_peak_method"], "4x_oversample_isp")

    def test_inverted_lr_fails_phase(self):
        sr = 44100
        t = np.linspace(0, 0.4, int(sr * 0.4), endpoint=False)
        tone = 0.1 * np.sin(2 * np.pi * 330.0 * t)
        inverted = np.column_stack((tone, -tone))
        report = measure_qc(inverted, sr)
        self.assertFalse(report["pass"])
        self.assertTrue(any("phase" in f for f in report["failures"]))
        self.assertLess(report["phase_correlation"], 0.0)

    def test_hot_clip_fails_true_peak(self):
        sr = 44100
        t = np.linspace(0, 0.2, int(sr * 0.2), endpoint=False)
        hot = np.clip(1.2 * np.sin(2 * np.pi * 200.0 * t), -1.0, 1.0)
        stereo = np.column_stack((hot, hot))
        report = measure_qc(stereo, sr)
        self.assertGreater(report["true_peak_dbtp"], -0.50)
        self.assertFalse(report["pass"])
        self.assertTrue(any("true_peak" in f for f in report["failures"]))
        self.assertAlmostEqual(report["true_peak_dbtp"], measure_true_peak_dbtp(stereo), places=3)
        self.assertLess(report["sample_peak_dbfs"], report["true_peak_dbtp"] + 0.01)


if __name__ == "__main__":
    unittest.main()
