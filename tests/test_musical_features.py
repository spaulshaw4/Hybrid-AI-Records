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
    CONFIDENCE_BYPASS,
    CONFIDENCE_REFERENCE,
    GRID_STEPS,
    PITCH_CLASSES,
    chord_fit,
    chord_pitch_classes,
    chroma_vector,
    confidence_trust,
    downbeat_phase,
    estimate_root,
    groove_fit,
    harmonic_bypass,
    harmonic_fit,
    onset_grid,
    pack_floats,
    plan_pitch_weights,
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


class TestChromaConfidence(unittest.TestCase):
    """A fit is only as good as the chroma it was measured from."""

    def setUp(self):
        self.fit_chroma = chroma_vector(_chord_tone(chord_pitch_classes("Fmaj7")), TARGET_SR)
        self.clash_chroma = chroma_vector(_chord_tone(chord_pitch_classes("F#")), TARGET_SR)
        self.weights = plan_pitch_weights(["Fmaj7", "Fmaj7"])
        # Both clear CONFIDENCE_BYPASS, so the difference is the weighting
        # rather than one of them being dropped.
        self.high = 0.9
        self.low = CONFIDENCE_BYPASS

    def test_identical_chroma_scores_differently_when_confidence_diverges(self):
        """The whole point: same pitch vector, different certainty, different score."""
        self.assertNotEqual(
            chord_fit(self.fit_chroma, "Fmaj7", self.high),
            chord_fit(self.fit_chroma, "Fmaj7", self.low),
        )
        self.assertNotEqual(
            harmonic_fit(self.fit_chroma, self.weights, self.high),
            harmonic_fit(self.fit_chroma, self.weights, self.low),
        )

    def test_confident_good_match_outscores_the_same_match_measured_weakly(self):
        self.assertGreater(
            chord_fit(self.fit_chroma, "Fmaj7", self.high),
            chord_fit(self.fit_chroma, "Fmaj7", self.low),
        )
        self.assertGreater(
            harmonic_fit(self.fit_chroma, self.weights, self.high),
            harmonic_fit(self.fit_chroma, self.weights, self.low),
        )

    def test_confident_clash_is_punished_harder_than_the_same_clash_measured_weakly(self):
        """The blend has to cut both ways, or it is just a penalty on good scores."""
        self.assertLess(
            chord_fit(self.clash_chroma, "Fmaj7", self.high),
            chord_fit(self.clash_chroma, "Fmaj7", self.low),
        )
        self.assertLess(
            harmonic_fit(self.clash_chroma, self.weights, self.high),
            harmonic_fit(self.clash_chroma, self.weights, self.low),
        )

    def test_zero_confidence_is_exactly_the_no_chroma_neutral(self):
        self.assertEqual(chord_fit(self.fit_chroma, "Fmaj7", 0.0), 0.5)
        self.assertEqual(chord_fit(np.zeros(12), "Fmaj7"), 0.5)
        self.assertEqual(harmonic_fit(self.fit_chroma, self.weights, 0.0), 0.5)
        self.assertEqual(harmonic_fit(np.zeros(12), self.weights), 0.5)

    def test_below_the_bypass_threshold_no_harmonic_opinion_is_offered(self):
        just_under = CONFIDENCE_BYPASS - 1e-6
        self.assertTrue(harmonic_bypass(just_under))
        self.assertEqual(chord_fit(self.fit_chroma, "Fmaj7", just_under), 0.5)
        self.assertEqual(chord_fit(self.clash_chroma, "Fmaj7", just_under), 0.5)
        self.assertEqual(harmonic_fit(self.fit_chroma, self.weights, just_under), 0.5)
        self.assertFalse(harmonic_bypass(CONFIDENCE_BYPASS))

    def test_absent_confidence_is_trusted_rather_than_neutralised(self):
        """Rows with no confidence measured their chroma elsewhere (staged audio)."""
        self.assertFalse(harmonic_bypass(None))
        self.assertEqual(confidence_trust(None), 1.0)
        for bad in (None, "", "nonsense", float("nan")):
            self.assertIsInstance(chord_fit(self.fit_chroma, "Fmaj7", bad), float)
        self.assertEqual(
            chord_fit(self.fit_chroma, "Fmaj7", None), chord_fit(self.fit_chroma, "Fmaj7")
        )
        # NaN is a broken reading, not an absent one, so it bypasses.
        self.assertEqual(chord_fit(self.fit_chroma, "Fmaj7", float("nan")), 0.5)

    def test_trust_saturates_at_the_reference_confidence(self):
        """Past the corpus p90 a reading is believed outright, not scaled further."""
        self.assertEqual(confidence_trust(CONFIDENCE_REFERENCE), 1.0)
        self.assertEqual(confidence_trust(1.0), 1.0)
        self.assertEqual(
            chord_fit(self.fit_chroma, "Fmaj7", CONFIDENCE_REFERENCE),
            chord_fit(self.fit_chroma, "Fmaj7"),
        )
        self.assertLess(confidence_trust(CONFIDENCE_BYPASS), 1.0)

    def test_confidence_cannot_rescue_an_unparseable_chord(self):
        self.assertEqual(chord_fit(self.fit_chroma, "not-a-chord", 0.9), 0.5)
        self.assertEqual(chord_fit(self.fit_chroma, "", 0.9), 0.5)


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
