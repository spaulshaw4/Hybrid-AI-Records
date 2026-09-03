import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.midside_processor import apply_midside_stereo_sculpt  # noqa: E402


class TestMidSideProcessor(unittest.TestCase):
    def test_mono_sub_and_wide_highs(self):
        sr = 44100
        t = np.linspace(0, 0.5, int(sr * 0.5), endpoint=False)
        bass = 0.4 * np.sin(2 * np.pi * 60 * t)
        highs_l = 0.2 * np.sin(2 * np.pi * 4000 * t)
        highs_r = -highs_l
        stereo = np.column_stack((bass + highs_l, bass + highs_r))
        out = apply_midside_stereo_sculpt(stereo, mono_cutoff_hz=120.0, side_gain_factor=1.2, sr=sr)

        from scipy.signal import butter, sosfiltfilt

        sos_lp = butter(4, 80.0, btype="lowpass", fs=sr, output="sos")
        low_l = sosfiltfilt(sos_lp, out[:, 0])
        low_r = sosfiltfilt(sos_lp, out[:, 1])
        low_corr = np.corrcoef(low_l, low_r)[0, 1]
        self.assertGreater(low_corr, 0.85)
        self.assertEqual(out.shape, stereo.shape)
        self.assertFalse(np.isnan(out).any())


if __name__ == "__main__":
    unittest.main()
