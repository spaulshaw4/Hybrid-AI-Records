import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.vocal_pitch_corrector import (  # noqa: E402
    estimate_median_f0,
    get_scale_notes,
    requested_semitone_shift,
    snap_frequency_to_scale,
    tune_vocal_buffer,
)


def _sine(hz: float, sr: int = 44100, seconds: float = 0.6, amp: float = 0.45) -> np.ndarray:
    t = np.linspace(0.0, seconds, int(sr * seconds), endpoint=False)
    return (amp * np.sin(2.0 * np.pi * hz * t)).astype(np.float64)


class TestVocalPitchCorrector(unittest.TestCase):
    def test_a_minor_scale_degrees(self):
        notes = get_scale_notes("A", "minor")
        self.assertEqual(notes, ["A", "B", "C", "D", "E", "F", "G"])
        self.assertEqual(get_scale_notes("Db", "dorian")[0], "C#")

    def test_a440_sine_in_a_minor_is_noop(self):
        sr = 44100
        tone = _sine(440.0, sr=sr)
        snapped = snap_frequency_to_scale(440.0, "A", "minor")
        self.assertAlmostEqual(snapped, 440.0, delta=0.5)
        self.assertLess(abs(requested_semitone_shift(440.0, "A", "minor")), 0.05)
        out = tune_vocal_buffer(tone, sr=sr, key="A", scale="minor")
        self.assertIs(out, tone)

    def test_c5_vs_a_minor_requests_plausible_small_shift(self):
        sr = 44100
        c5 = 523.2511306011972
        tone = _sine(c5, sr=sr)
        f0 = estimate_median_f0(tone, sr=sr)
        self.assertIsNotNone(f0)
        self.assertGreater(f0, 480.0)
        self.assertLess(f0, 570.0)
        # C is already in A minor, so the requested correction stays tiny
        # (unlike a 3-st root jump from C toward A).
        shift = requested_semitone_shift(float(f0), "A", "minor")
        self.assertLessEqual(abs(shift), 4.0)
        self.assertLess(abs(shift), 1.25)
        out = tune_vocal_buffer(tone, sr=sr, key="A", scale="minor")
        self.assertEqual(out.shape, tone.shape)
        sharp = requested_semitone_shift(554.3652619537442, "A", "minor")
        self.assertGreater(abs(sharp), 0.2)
        self.assertLessEqual(abs(sharp), 1.0)

    def test_empty_and_silence_passthrough(self):
        empty = np.zeros(0, dtype=np.float64)
        self.assertIs(tune_vocal_buffer(empty, sr=44100, key="A", scale="minor"), empty)
        silence = np.zeros(44100, dtype=np.float64)
        self.assertIs(tune_vocal_buffer(silence, sr=44100, key="A", scale="minor"), silence)
        tiny = np.full((22050, 2), 1e-9)
        self.assertIs(tune_vocal_buffer(tiny, sr=44100, key="F#", scale="dorian"), tiny)

    def test_stereo_shape_and_shift_clip(self):
        sr = 44100
        tone = _sine(277.18, sr=sr, seconds=0.4)
        stereo = np.column_stack((tone, tone * 0.8))
        out = tune_vocal_buffer(stereo, sr=sr, key="A", scale="phrygian")
        self.assertEqual(out.shape, stereo.shape)
        self.assertFalse(np.isnan(out).any())
        self.assertLessEqual(abs(requested_semitone_shift(80.0, "C", "major")), 4.0)


if __name__ == "__main__":
    unittest.main()
