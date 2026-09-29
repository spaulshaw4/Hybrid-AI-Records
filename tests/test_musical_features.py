"""Chroma and groove must reflect real content, not just execute."""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.musical_features import (  # noqa: E402
    GRID_STEPS,
    PITCH_CLASSES,
    chord_fit,
    chord_pitch_classes,
    chroma_vector,
    downbeat_phase,
    estimate_root,
    groove_fit,
    onset_grid,
    pack_floats,
    unpack_floats,
)
from ml.audio_features import TARGET_SR  # noqa: E402


def _note_hz(pitch_class: int, octave: int = 4) -> float:
    midi = 12 * (octave + 1) + pitch_class
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def _chord_tone(pcs, seconds: float = 2.0, sr: int = TARGET_SR) -> np.ndarray:
    t = np.linspace(0.0, seconds, int(sr * seconds), endpoint=False)
    x = np.zeros_like(t)
    for pc in pcs:
        for octave in (3, 4):
            x += np.sin(2 * np.pi * _note_hz(pc, octave) * t)
    return x / (np.max(np.abs(x)) + 1e-9)


def _pulse(bpm: float, hits_per_bar: int, seconds: float = 4.0, sr: int = TARGET_SR) -> np.ndarray:
    n = int(sr * seconds)
    x = np.zeros(n, dtype=np.float64)
    bar = 4.0 * 60.0 / bpm
    step = bar / hits_per_bar
    click = max(8, int(0.010 * sr))
    t = 0.0
    rng = np.random.default_rng(0)
    while t < seconds:
        start = int(t * sr)
        end = min(n, start + click)
        if end > start:
            x[start:end] += rng.normal(0, 1, end - start) * np.hanning(end - start)
        t += step
    return x / (np.max(np.abs(x)) + 1e-9)


class TestChroma(unittest.TestCase):
    def test_c_major_chroma_peaks_on_its_own_tones(self):
        pcs = chord_pitch_classes("C")  # C E G
        chroma = chroma_vector(_chord_tone(pcs), TARGET_SR)
        top3 = set(np.argsort(chroma)[-3:].tolist())
        self.assertEqual(top3, set(pcs), f"chroma peaked on {top3}, expected {set(pcs)}")

    def test_chord_fit_prefers_the_matching_chord(self):
        c_major = chroma_vector(_chord_tone(chord_pitch_classes("C")), TARGET_SR)
        self.assertGreater(chord_fit(c_major, "C"), chord_fit(c_major, "F#"))
        self.assertGreater(chord_fit(c_major, "C"), 0.8)

    def test_fmaj7_slice_beats_am7_slice_on_an_fmaj7_bar(self):
        """The exact call the picker has to make and currently cannot."""
        f_slice = chroma_vector(_chord_tone(chord_pitch_classes("Fmaj7")), TARGET_SR)
        a_slice = chroma_vector(_chord_tone(chord_pitch_classes("Am7")), TARGET_SR)
        self.assertGreater(chord_fit(f_slice, "Fmaj7"), chord_fit(a_slice, "Fmaj7"))

    def test_estimate_root_finds_the_tonic_and_mode(self):
        root, minor, conf = estimate_root(
            chroma_vector(_chord_tone(chord_pitch_classes("Amin")), TARGET_SR)
        )
        self.assertEqual(PITCH_CLASSES[root], "A")
        self.assertTrue(minor)
        self.assertGreater(conf, 0.0)

    def test_silence_is_neutral_not_a_clash(self):
        silent = chroma_vector(np.zeros(TARGET_SR), TARGET_SR)
        self.assertEqual(chord_fit(silent, "Fmaj7"), 0.5)
        self.assertEqual(chord_fit(np.zeros(12), "anything"), 0.5)

    def test_flat_and_sharp_spellings_agree(self):
        self.assertEqual(set(chord_pitch_classes("Bb")), set(chord_pitch_classes("A#")))


class TestGroove(unittest.TestCase):
    def test_four_on_the_floor_lands_on_quarter_buckets(self):
        grid = onset_grid(_pulse(120.0, 4), TARGET_SR, 120.0)
        quarters = grid[[0, 4, 8, 12]].sum()
        offbeats = grid[[1, 3, 5, 7, 9, 11, 13, 15]].sum()
        self.assertGreater(quarters, offbeats)

    def test_groove_fit_separates_four_on_floor_from_half_time(self):
        four = onset_grid(_pulse(120.0, 4), TARGET_SR, 120.0)
        half = onset_grid(_pulse(120.0, 2), TARGET_SR, 120.0)
        self.assertGreater(groove_fit(four, four), groove_fit(four, half))

    def test_unknown_tempo_yields_no_opinion(self):
        grid = onset_grid(_pulse(120.0, 4), TARGET_SR, 0.0)
        self.assertEqual(grid.shape, (GRID_STEPS,))
        self.assertEqual(float(grid.sum()), 0.0)
        self.assertEqual(groove_fit(grid, np.ones(GRID_STEPS)), 0.5)

    def test_downbeat_phase_in_unit_range(self):
        phase = downbeat_phase(onset_grid(_pulse(120.0, 4), TARGET_SR, 120.0))
        self.assertGreaterEqual(phase, 0.0)
        self.assertLess(phase, 1.0)


class TestPacking(unittest.TestCase):
    def test_roundtrip(self):
        vec = np.linspace(0.0, 1.0, 12)
        np.testing.assert_allclose(unpack_floats(pack_floats(vec), 12), vec, atol=1e-5)

    def test_malformed_is_zeros(self):
        self.assertEqual(float(unpack_floats("not,numbers", 12).sum()), 0.0)
        self.assertEqual(float(unpack_floats(None, 12).sum()), 0.0)
        self.assertEqual(float(unpack_floats("1,2,3", 12).sum()), 0.0)


if __name__ == "__main__":
    unittest.main()
