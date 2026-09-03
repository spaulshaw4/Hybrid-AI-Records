import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.tape_saturation import apply_tape_saturation  # noqa: E402


def _thd(signal: np.ndarray, sr: int, f0: float) -> float:
    windowed = signal * np.hanning(signal.shape[0])
    spec = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(signal.shape[0], 1.0 / sr)
    fund = spec[int(np.argmin(np.abs(freqs - f0)))]
    harm = 0.0
    for k in range(2, 6):
        harm += float(spec[int(np.argmin(np.abs(freqs - f0 * k)))] ** 2)
    return float(np.sqrt(harm) / (fund + 1e-12))


class TestTapeSaturation(unittest.TestCase):
    def test_drive_zero_identical_and_shape(self):
        sr = 44100
        t = np.linspace(0, 0.25, int(sr * 0.25), endpoint=False)
        mono = (0.4 * np.sin(2 * np.pi * 440.0 * t)).astype(np.float64)
        stereo = np.column_stack((mono, mono * 0.8))
        out_mono = apply_tape_saturation(mono, sr=sr, drive=0.0)
        out_stereo = apply_tape_saturation(stereo, sr=sr, drive=0.0)
        np.testing.assert_array_equal(out_mono, mono)
        np.testing.assert_array_equal(out_stereo, stereo)
        self.assertEqual(out_mono.shape, mono.shape)
        self.assertEqual(out_stereo.shape, stereo.shape)

    def test_drive_raises_thd_and_preserves_shape(self):
        sr = 44100
        t = np.linspace(0, 1.0, sr, endpoint=False)
        tone = 0.6 * np.sin(2 * np.pi * 440.0 * t)
        stereo = np.column_stack((tone, tone))
        wet = apply_tape_saturation(stereo, sr=sr, drive=4.0)
        self.assertEqual(wet.shape, stereo.shape)
        self.assertFalse(np.isnan(wet).any())
        self.assertGreater(_thd(wet[:, 0], sr, 440.0), _thd(tone, sr, 440.0) * 1.5)
        dry_spec = np.abs(np.fft.rfft(tone * np.hanning(tone.shape[0])))
        wet_spec = np.abs(np.fft.rfft(wet[:, 0] * np.hanning(wet.shape[0])))
        self.assertGreater(float(np.mean(np.abs(wet_spec - dry_spec))), 1e-3)

    def test_negative_drive_passthrough(self):
        sr = 22050
        t = np.linspace(0, 0.1, int(sr * 0.1), endpoint=False)
        tone = 0.2 * np.sin(2 * np.pi * 330.0 * t)
        out = apply_tape_saturation(tone, sr=sr, drive=-1.0)
        np.testing.assert_array_equal(out, tone)
        self.assertFalse(np.isnan(out).any())


if __name__ == "__main__":
    unittest.main()
