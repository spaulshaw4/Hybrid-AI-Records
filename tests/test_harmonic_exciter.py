import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.harmonic_exciter import apply_harmonic_exciter  # noqa: E402


def _band_energy(signal: np.ndarray, sr: int, lo: float, hi: float) -> float:
    windowed = signal * np.hanning(signal.shape[0])
    spec = np.abs(np.fft.rfft(windowed)) ** 2
    freqs = np.fft.rfftfreq(signal.shape[0], 1.0 / sr)
    mask = (freqs >= lo) & (freqs <= hi)
    return float(np.sum(spec[mask]))


class TestHarmonicExciter(unittest.TestCase):
    def test_hf_energy_can_rise_peak_not_above_input(self):
        sr = 44100
        t = np.linspace(0, 1.0, sr, endpoint=False)
        tone = 0.45 * np.sin(2 * np.pi * 2500.0 * t)
        stereo = np.column_stack((tone, tone * 0.9))
        out = apply_harmonic_exciter(stereo, sr=sr, air_freq_hz=1800.0, drive=0.8, mix=0.45)
        self.assertEqual(out.shape, stereo.shape)
        self.assertFalse(np.isnan(out).any())
        self.assertLessEqual(float(np.max(np.abs(out))), float(np.max(np.abs(stereo))) + 1e-9)
        self.assertGreater(_band_energy(out[:, 0], sr, 6000.0, 12000.0), _band_energy(tone, sr, 6000.0, 12000.0))

    def test_zero_mix_or_drive_passthrough(self):
        sr = 44100
        t = np.linspace(0, 0.2, int(sr * 0.2), endpoint=False)
        tone = 0.3 * np.sin(2 * np.pi * 1000.0 * t)
        np.testing.assert_array_equal(apply_harmonic_exciter(tone, sr=sr, drive=0.0), tone)
        np.testing.assert_array_equal(apply_harmonic_exciter(tone, sr=sr, mix=0.0), tone)

    def test_nyquist_guard_and_mono_shape(self):
        sr = 8000
        t = np.linspace(0, 0.25, int(sr * 0.25), endpoint=False)
        tone = 0.4 * np.sin(2 * np.pi * 400.0 * t)
        out = apply_harmonic_exciter(tone, sr=sr, air_freq_hz=20000.0, drive=0.5, mix=0.3)
        self.assertEqual(out.shape, tone.shape)
        self.assertFalse(np.isnan(out).any())
        self.assertLessEqual(float(np.max(np.abs(out))), float(np.max(np.abs(tone))) + 1e-9)


if __name__ == "__main__":
    unittest.main()
