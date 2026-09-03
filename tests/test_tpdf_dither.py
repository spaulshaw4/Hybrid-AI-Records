import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.tpdf_dither import apply_tpdf_dither, quantize_to_bits  # noqa: E402


class TestTpdfDither(unittest.TestCase):
    def test_24bit_ramp_differs_and_stays_legal(self):
        ramp = np.linspace(-0.001, 0.001, 2048, dtype=np.float64)
        undithered = quantize_to_bits(ramp, 24)
        dithered = apply_tpdf_dither(ramp, target_bits=24, seed=7, noise_shape=True)
        self.assertEqual(dithered.shape, ramp.shape)
        self.assertFalse(np.array_equal(dithered, undithered))
        self.assertLessEqual(float(np.max(np.abs(dithered))), 1.0)
        self.assertTrue(np.isfinite(dithered).all())

    def test_stereo_and_seed_replay(self):
        stereo = np.column_stack((np.linspace(-0.2, 0.2, 512), np.linspace(0.2, -0.2, 512)))
        a = apply_tpdf_dither(stereo, target_bits=16, seed=3, noise_shape=False)
        b = apply_tpdf_dither(stereo, target_bits=16, seed=3, noise_shape=False)
        self.assertEqual(a.shape, stereo.shape)
        self.assertTrue(np.allclose(a, b))
        self.assertLessEqual(float(np.max(np.abs(a))), 1.0)

    def test_rejects_illegal_bits(self):
        with self.assertRaises(ValueError):
            apply_tpdf_dither(np.zeros(8), target_bits=12)


if __name__ == "__main__":
    unittest.main()
