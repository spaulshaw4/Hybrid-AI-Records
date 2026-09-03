import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.dynamic_eq_processor import (  # noqa: E402
    HARSH_HIGH_HZ,
    MUD_HIGH_HZ,
    MUD_LOW_HZ,
    apply_dynamic_eq,
    apply_dynamic_master_eq,
)


def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x))))


class TestDynamicEqProcessor(unittest.TestCase):
    def test_loud_mud_tone_loses_band_energy(self):
        sr = 44100
        t = np.linspace(0, 1.0, sr, endpoint=False)
        tone = 0.85 * np.sin(2 * np.pi * 350.0 * t)
        out = apply_dynamic_master_eq(tone, sr=sr)
        self.assertEqual(out.shape, tone.shape)
        self.assertFalse(np.isnan(out).any())
        half = sr // 2
        self.assertLess(_rms(out[half:]), _rms(tone[half:]) * 0.92)

    def test_quiet_tone_below_threshold_nearly_unchanged(self):
        sr = 44100
        t = np.linspace(0, 0.5, int(sr * 0.5), endpoint=False)
        quiet = 0.01 * np.sin(2 * np.pi * 350.0 * t)
        out = apply_dynamic_master_eq(quiet, sr=sr)
        self.assertEqual(out.shape, quiet.shape)
        self.assertFalse(np.isnan(out).any())
        np.testing.assert_allclose(out, quiet, atol=2e-3, rtol=0.02)

    def test_stereo_shape_and_no_nans(self):
        sr = 44100
        t = np.linspace(0, 0.25, int(sr * 0.25), endpoint=False)
        tone = 0.4 * np.sin(2 * np.pi * 350.0 * t)
        stereo = np.column_stack((tone, tone * 0.8))
        out = apply_dynamic_master_eq(stereo, sr=sr)
        self.assertEqual(out.shape, stereo.shape)
        self.assertFalse(np.isnan(out).any())

    def test_nyquist_guard_skips_unusable_band(self):
        sr = 2000
        t = np.linspace(0, 0.2, int(sr * 0.2), endpoint=False)
        tone = 0.5 * np.sin(2 * np.pi * 200.0 * t)
        # Harsh band (~3.5 kHz) is above Nyquist; mud still applies if in range.
        out = apply_dynamic_eq(
            tone,
            sr,
            HARSH_HIGH_HZ,
            HARSH_HIGH_HZ + 500.0,
            threshold_db=-40.0,
            ratio=4.0,
        )
        self.assertEqual(out.shape, tone.shape)
        self.assertFalse(np.isnan(out).any())
        np.testing.assert_allclose(out, tone)

    def test_single_band_mud_range_contains_350hz(self):
        self.assertLess(MUD_LOW_HZ, 350.0)
        self.assertGreater(MUD_HIGH_HZ, 350.0)


if __name__ == "__main__":
    unittest.main()
