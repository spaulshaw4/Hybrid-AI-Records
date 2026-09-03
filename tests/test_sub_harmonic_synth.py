import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.sub_harmonic_synth import apply_sub_harmonic_synth


def _band_energy(signal: np.ndarray, sr: int, low_hz: float, high_hz: float) -> float:
    spec = np.fft.rfft(signal)
    freqs = np.fft.rfftfreq(signal.size, 1.0 / sr)
    mask = (freqs >= low_hz) & (freqs <= high_hz)
    return float(np.sum(np.abs(spec[mask]) ** 2))


class TestSubHarmonicSynth(unittest.TestCase):
    def test_mix_zero_passthrough(self):
        sr = 44100
        t = np.linspace(0, 0.4, int(sr * 0.4), endpoint=False)
        tone = 0.4 * np.sin(2 * np.pi * 50 * t)
        out = apply_sub_harmonic_synth(tone, mix=0.0, sr=sr)
        np.testing.assert_array_equal(out, tone)

    def test_fifty_hz_gains_body_band(self):
        sr = 44100
        t = np.linspace(0, 1.0, sr, endpoint=False)
        tone = 0.5 * np.sin(2 * np.pi * 50 * t)
        stereo = np.column_stack((tone, tone))
        out = apply_sub_harmonic_synth(stereo, mix=0.35, sr=sr)
        self.assertEqual(out.shape, stereo.shape)
        self.assertFalse(np.isnan(out).any())
        self.assertLessEqual(float(np.max(np.abs(out))), float(np.max(np.abs(stereo))) + 1e-9)
        before = _band_energy(tone, sr, 100.0, 250.0)
        after = _band_energy(0.5 * (out[:, 0] + out[:, 1]), sr, 100.0, 250.0)
        self.assertGreater(after, before)


if __name__ == "__main__":
    unittest.main()
