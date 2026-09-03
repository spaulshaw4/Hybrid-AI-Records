import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.transient_shaper import apply_transient_shaper


class TestTransientShaper(unittest.TestCase):
    def test_attack_raises_impulse_vs_sustain_sine(self):
        sr = 44100
        n = sr
        sig = np.zeros(n, dtype=np.float64)
        sig[200] = 0.9
        t = np.arange(n) / float(sr)
        sustain_at = int(0.25 * sr)
        sig[sustain_at:] += 0.25 * np.sin(2 * np.pi * 220.0 * t[sustain_at:])

        out = apply_transient_shaper(sig, sr=sr, attack=3.0, sustain=0.35)
        self.assertEqual(out.shape, sig.shape)
        self.assertFalse(np.isnan(out).any())
        self.assertFalse(np.isinf(out).any())

        early_in = float(np.max(np.abs(sig[:sustain_at])))
        late_in = float(np.max(np.abs(sig[sustain_at:])))
        early_out = float(np.max(np.abs(out[:sustain_at])))
        late_out = float(np.max(np.abs(out[sustain_at:])))
        ratio_in = early_in / (late_in + 1e-12)
        ratio_out = early_out / (late_out + 1e-12)
        self.assertGreater(ratio_out, ratio_in * 1.05)

        orig_peak = float(np.max(np.abs(sig)))
        self.assertAlmostEqual(float(np.max(np.abs(out))), orig_peak, places=6)

    def test_quiet_signal_does_not_explode(self):
        sr = 44100
        t = np.linspace(0, 0.25, int(sr * 0.25), endpoint=False)
        quiet = 1e-6 * np.sin(2 * np.pi * 440.0 * t)
        out = apply_transient_shaper(quiet, sr=sr, attack=8.0, sustain=8.0)
        self.assertEqual(out.shape, quiet.shape)
        self.assertFalse(np.isnan(out).any())
        self.assertLess(float(np.max(np.abs(out))), 1e-4)

    def test_stereo_shape_and_zeros(self):
        sr = 44100
        t = np.linspace(0, 0.2, int(sr * 0.2), endpoint=False)
        tone = 0.4 * np.sin(2 * np.pi * 330.0 * t)
        stereo = np.column_stack((tone, tone * 0.7))
        out = apply_transient_shaper(stereo, sr=sr, attack=1.8, sustain=0.7)
        self.assertEqual(out.shape, stereo.shape)
        self.assertFalse(np.isnan(out).any())

        zeros = np.zeros(512, dtype=np.float32)
        z_out = apply_transient_shaper(zeros, sr=sr, attack=4.0, sustain=0.2)
        self.assertEqual(z_out.shape, zeros.shape)
        self.assertFalse(np.isnan(z_out).any())
        self.assertLessEqual(float(np.max(np.abs(z_out))), 1e-12)


if __name__ == "__main__":
    unittest.main()
