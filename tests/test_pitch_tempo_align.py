import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.pitch_key_aligner import (  # noqa: E402
    NOTE_MAP,
    NOTE_NAMES,
    align_slice_to_target_key,
    calculate_semitone_shift,
    detect_slice_key,
    normalise_root_note,
    pitch_shift_slice,
    shortest_semitone_delta,
)
from dsp.tempo_time_stretch import (  # noqa: E402
    clip_stretch_rate,
    estimate_slice_bpm,
    fold_bpm_octave,
    lock_slice_to_tempo,
    time_stretch_wsola,
)


def _click_train(sr: int, bpm: float, seconds: float) -> np.ndarray:
    n = int(sr * seconds)
    clicks = np.zeros(n, dtype=np.float64)
    interval = max(1, int(round(sr * 60.0 / bpm)))
    clicks[::interval] = 0.95
    return clicks


class TestPitchKeyAligner(unittest.TestCase):
    def test_detects_a440(self):
        sr = 44100
        t = np.linspace(0, 1.0, sr, endpoint=False)
        tone = 0.5 * np.sin(2 * np.pi * 440 * t)
        idx, name = detect_slice_key(tone, sr=sr)
        self.assertEqual(NOTE_NAMES[idx], "A")
        self.assertEqual(name, "A")

    def test_c_vs_a_requests_plausible_delta(self):
        sr = 44100
        t = np.linspace(0, 1.5, int(sr * 1.5), endpoint=False)
        c4 = 0.5 * np.sin(2 * np.pi * 261.6256 * t)
        idx, name = detect_slice_key(c4, sr=sr)
        self.assertEqual(name, "C")
        delta = shortest_semitone_delta(idx, NOTE_NAMES.index("A"))
        self.assertEqual(delta, -3)
        self.assertIn(delta, range(-6, 6))

    def test_shortest_path_wraps(self):
        self.assertEqual(shortest_semitone_delta(11, 0), 1)
        self.assertEqual(shortest_semitone_delta(0, 11), -1)
        self.assertEqual(shortest_semitone_delta(0, 6), -6)
        self.assertEqual(shortest_semitone_delta(0, 5), 5)

    def test_flat_aliases(self):
        self.assertEqual(NOTE_MAP["DB"], "C#")
        self.assertEqual(NOTE_MAP["EB"], "D#")
        self.assertEqual(NOTE_MAP["GB"], "F#")
        self.assertEqual(NOTE_MAP["AB"], "G#")
        self.assertEqual(NOTE_MAP["BB"], "A#")
        self.assertEqual(normalise_root_note("Db"), "C#")
        self.assertEqual(normalise_root_note("eb"), "D#")
        self.assertEqual(normalise_root_note("Gb"), "F#")
        self.assertEqual(normalise_root_note("Ab"), "G#")
        self.assertEqual(normalise_root_note("Bb"), "A#")
        self.assertEqual(normalise_root_note("Cb"), "B")

    def test_calculate_semitone_shift_wraps_minus6_plus5(self):
        self.assertEqual(calculate_semitone_shift("C", "A"), -3)
        self.assertEqual(calculate_semitone_shift("B", "C"), 1)
        self.assertEqual(calculate_semitone_shift("C", "F#"), -6)
        self.assertEqual(calculate_semitone_shift("C", "F"), 5)
        self.assertEqual(calculate_semitone_shift("Db", "C#"), 0)
        self.assertEqual(calculate_semitone_shift("", "A"), 0)

    def test_empty_or_missing_target_passthrough(self):
        rng = np.random.default_rng(3)
        audio = rng.standard_normal(1024)
        self.assertIs(align_slice_to_target_key(audio, ""), audio)
        self.assertIs(align_slice_to_target_key(audio, None), audio)
        empty = np.zeros(0, dtype=np.float64)
        self.assertIs(align_slice_to_target_key(empty, "A"), empty)

    def test_detected_key_override(self):
        sr = 44100
        t = np.linspace(0, 0.4, int(sr * 0.4), endpoint=False)
        tone = 0.4 * np.sin(2 * np.pi * 440 * t)
        out = align_slice_to_target_key(tone, "A", sr=sr, detected_key="A")
        self.assertIs(out, tone)
        shifted = align_slice_to_target_key(tone, "C", sr=sr, detected_key="A")
        self.assertEqual(shifted.shape, tone.shape)
        self.assertFalse(np.array_equal(shifted, tone))

    def test_tiny_semitone_is_noop(self):
        rng = np.random.default_rng(0)
        audio = rng.standard_normal(2048)
        out = pitch_shift_slice(audio, 0.04, sr=44100)
        self.assertIs(out, audio)

    def test_align_keeps_shape_mono_and_stereo(self):
        sr = 44100
        t = np.linspace(0, 0.5, int(sr * 0.5), endpoint=False)
        tone = 0.4 * np.sin(2 * np.pi * 440 * t)
        stereo = np.column_stack((tone, tone))
        aligned = align_slice_to_target_key(stereo, "C", sr=sr)
        self.assertEqual(aligned.shape, stereo.shape)
        mono = align_slice_to_target_key(tone, "C", sr=sr)
        self.assertEqual(mono.shape, tone.shape)

    def test_quiet_and_no_chroma_unchanged(self):
        sr = 44100
        quiet = np.zeros((sr, 2), dtype=np.float64)
        out = align_slice_to_target_key(quiet, "A", sr=sr)
        self.assertIs(out, quiet)
        tiny = np.full((sr, 2), 1e-9)
        out_tiny = align_slice_to_target_key(tiny, "F#", sr=sr)
        self.assertIs(out_tiny, tiny)


class TestTempoTimeStretch(unittest.TestCase):
    def test_fold_half_and_double(self):
        self.assertAlmostEqual(fold_bpm_octave(60.0, 120.0), 120.0)
        self.assertAlmostEqual(fold_bpm_octave(240.0, 120.0), 120.0)
        self.assertAlmostEqual(fold_bpm_octave(120.0, 120.0), 120.0)

    def test_click_train_folds_toward_target(self):
        sr = 44100
        target = 120.0
        for source in (60.0, 120.0, 240.0):
            clicks = _click_train(sr, source, seconds=8.0)
            est = estimate_slice_bpm(clicks, sr=sr)
            folded = fold_bpm_octave(est, target)
            self.assertGreater(folded, 80.0, msg=f"source={source} est={est}")
            self.assertLess(folded, 160.0, msg=f"source={source} est={est}")

    def test_tempo_lock_exact_length(self):
        sr = 44100
        clicks = _click_train(sr, 100.0, seconds=3.2)
        stereo = np.column_stack((clicks, clicks))
        locked = lock_slice_to_tempo(stereo, target_bpm=100.0, sr=sr, target_samples=176400)
        self.assertEqual(len(locked), 176400)
        self.assertEqual(locked.shape, (176400, 2))
        default_len = lock_slice_to_tempo(stereo, target_bpm=100.0, sr=sr)
        self.assertEqual(len(default_len), int(4 * sr))

    def test_rate_one_identical(self):
        rng = np.random.default_rng(1)
        audio = rng.standard_normal(8000)
        out = time_stretch_wsola(audio, 1.0, sr=44100)
        self.assertIs(out, audio)
        near = time_stretch_wsola(audio, 1.005, sr=44100)
        self.assertIs(near, audio)

    def test_rate_clipped_at_half(self):
        self.assertEqual(clip_stretch_rate(0.25), 0.5)
        self.assertEqual(clip_stretch_rate(0.5), 0.5)
        self.assertEqual(clip_stretch_rate(4.0), 2.0)
        rng = np.random.default_rng(2)
        audio = rng.standard_normal(3000)
        self.assertEqual(
            len(time_stretch_wsola(audio, 0.25, sr=44100)),
            len(time_stretch_wsola(audio, 0.5, sr=44100)),
        )

    def test_original_bpm_supplied(self):
        sr = 44100
        clicks = _click_train(sr, 80.0, seconds=2.0)
        stereo = np.column_stack((clicks, clicks))
        target_samples = 20000
        locked = lock_slice_to_tempo(
            stereo,
            target_bpm=120.0,
            sr=sr,
            target_samples=target_samples,
            original_bpm=120.0,
        )
        self.assertEqual(len(locked), target_samples)
        self.assertEqual(locked.shape[1], 2)
        prefix = min(target_samples, len(stereo))
        np.testing.assert_array_equal(locked[:prefix], stereo[:prefix])
        empty = np.zeros(0, dtype=np.float64)
        self.assertIs(lock_slice_to_tempo(empty, target_bpm=120.0), empty)
        self.assertIs(lock_slice_to_tempo(stereo, target_bpm=0.0), stereo)
        mono = lock_slice_to_tempo(clicks, target_bpm=80.0, sr=sr, original_bpm=80.0, target_samples=4096)
        self.assertEqual(mono.shape, (4096,))


if __name__ == "__main__":
    unittest.main()
