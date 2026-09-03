import os
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.smart_transient_slicer import (  # noqa: E402
    RawSourceError,
    assert_raw_source,
    clamp_phrase_end,
    find_nearest_zero_crossing,
    find_phrase_zero_crossing,
    slice_audio,
    slice_audio_file,
)


class TestPhraseZeroCrossing(unittest.TestCase):
    def test_trough_then_nearby_zc(self):
        sr = 44100
        t = np.arange(int(8.0 * sr), dtype=np.float64) / sr
        sig = 0.6 * np.sin(2.0 * np.pi * 100.0 * t)
        # Breath/rest just after the 4.0s grid: 4.08–4.13 s.
        lo = int(4.08 * sr)
        hi = int(4.13 * sr)
        sig[lo:hi] *= 0.01
        target = int(4.0 * sr)
        trough_center = (lo + hi) // 2

        snapped = find_phrase_zero_crossing(sig, target, sr, search_window_ms=250.0)

        self.assertGreaterEqual(snapped, lo - int(0.015 * sr))
        self.assertLessEqual(snapped, hi + int(0.015 * sr))
        self.assertLess(abs(snapped - trough_center), abs(snapped - target))
        self.assertLess(abs(float(sig[snapped])), 0.08)

    def test_stereo_mean_for_zc(self):
        sr = 8000
        t = np.arange(sr, dtype=np.float64) / sr
        left = np.sin(2.0 * np.pi * 50.0 * t)
        stereo = np.column_stack((left, left))
        target = sr // 2
        zc = find_nearest_zero_crossing(stereo, target, search_window=80)
        self.assertIsNotNone(zc)
        mid = 0.5 * (stereo[zc, 0] + stereo[zc, 1])
        self.assertLess(abs(float(mid)), 0.05)


class TestDurationBounds(unittest.TestCase):
    def test_clamp_caps_long_snap(self):
        sr = 44100
        start = 0
        snapped = int(5.5 * sr)
        end = clamp_phrase_end(start, snapped, int(3.2 * sr), int(4.8 * sr), int(10 * sr))
        self.assertAlmostEqual(end / sr, 4.8, places=3)

    def test_slice_audio_respects_max_dur(self):
        sr = 22050
        n = int(10.0 * sr)
        t = np.arange(n, dtype=np.float64) / sr
        sig = 0.5 * np.sin(2.0 * np.pi * 80.0 * t)
        # Deep trough at 5.5s so a 2s search would want a 5.5s first phrase.
        lo = int(5.45 * sr)
        hi = int(5.55 * sr)
        sig[lo:hi] *= 0.005
        phrases = slice_audio(
            sig,
            sr,
            slice_sec=4.0,
            min_dur=3.2,
            max_dur=4.8,
            search_window_ms=2000.0,
        )
        self.assertGreaterEqual(len(phrases), 1)
        first_sec = phrases[0].shape[0] / sr
        self.assertGreaterEqual(first_sec, 3.2 - 1e-6)
        self.assertLessEqual(first_sec, 4.8 + 1e-6)


class TestSilenceSkip(unittest.TestCase):
    def test_silent_mid_chunk_not_written(self):
        sr = 22050
        tone = 0.4 * np.sin(2.0 * np.pi * 220.0 * np.arange(int(4.0 * sr)) / sr)
        quiet = np.zeros(int(8.0 * sr), dtype=np.float64)
        sig = np.concatenate([tone, quiet, tone])
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "gate_probe.wav")
            out_dir = os.path.join(tmp, "out")
            sf.write(src, sig, sr)
            result = slice_audio_file(src, out_dir, nominal_dur=4.0, min_dur=3.2, max_dur=4.8)
            self.assertEqual(len(result["written"]), 2)
            self.assertGreaterEqual(result["skipped_silent"], 1)
            for path in result["written"]:
                info = sf.info(path)
                self.assertGreaterEqual(info.duration, 3.2 - 0.02)
                self.assertLessEqual(info.duration, 4.8 + 0.02)
                self.assertEqual(info.subtype, "PCM_24")

    def test_refuses_uploaded_slices_path(self):
        with self.assertRaises(RawSourceError):
            assert_raw_source(r"D:\MusicDatasets\uploaded_slices", [], allow=False)


if __name__ == "__main__":
    unittest.main()
