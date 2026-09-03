import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.micro_crossfader import apply_equal_power_crossfade, crossfade_sequence  # noqa: E402


class TestMicroCrossfader(unittest.TestCase):
    def test_length_is_a_plus_b_minus_fade(self):
        fade = 64
        a = np.ones(200, dtype=np.float64)
        b = np.full(150, 0.5, dtype=np.float64)
        out = apply_equal_power_crossfade(a, b, fade)
        self.assertEqual(out.shape[0], 200 + 150 - fade)
        self.assertTrue(np.isfinite(out).all())

    def test_stereo_and_sequence(self):
        fade = 32
        a = np.ones((100, 2))
        b = np.zeros((80, 2))
        c = np.full((60, 2), 0.25)
        out = apply_equal_power_crossfade(a, b, fade)
        self.assertEqual(out.shape, (100 + 80 - fade, 2))
        seq = crossfade_sequence([a, b, c], fade)
        expected = 100 + 80 + 60 - 2 * fade
        self.assertEqual(seq.shape[0], expected)


if __name__ == "__main__":
    unittest.main()
