"""Per-section variant choice must follow each section's own chords."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.blueprint_track_assembler import (  # noqa: E402
    VARIANT_FIT_TOLERANCE,
    assign_harmonic_variants,
)
from engine.musical_features import chord_pitch_classes  # noqa: E402
from ml.audio_features import TARGET_SR  # noqa: E402


def _write_chord(path: str, chord: str, seconds: float = 1.5) -> None:
    t = np.linspace(0.0, seconds, int(TARGET_SR * seconds), endpoint=False)
    x = np.zeros_like(t)
    for pc in chord_pitch_classes(chord):
        for octave in (3, 4):
            midi = 12 * (octave + 1) + pc
            x += np.sin(2 * np.pi * 440.0 * (2.0 ** ((midi - 69) / 12.0)) * t)
    x /= np.max(np.abs(x)) + 1e-9
    sf.write(path, np.stack([x, x], axis=1), TARGET_SR)


def _section(name: str, chords: list[str], variant: int):
    """(arrangement_section, song_plan_section) pair sharing a variant index."""
    arrangement = {"name": name, "bus_variant": {"harmonic": variant, "rhythm": variant}}
    song_plan = {"name": name, "chord_progression": chords, "bars_per_chord": 2}
    return arrangement, song_plan


class TestHarmonicVariants(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # Variant 0 is an F major triad, variant 1 is a B major triad — no
        # shared pitch classes, so chord fit can separate them cleanly.
        self.f_path = os.path.join(self.tmp.name, "v0_f.wav")
        self.b_path = os.path.join(self.tmp.name, "v1_b.wav")
        _write_chord(self.f_path, "F")
        _write_chord(self.b_path, "B")
        self.pools = {"harmonic": [self.f_path, self.b_path], "rhythm": [self.f_path]}

    def tearDown(self):
        self.tmp.cleanup()

    def test_section_moves_to_the_variant_that_fits_its_chords(self):
        """An F-major section pointed at the B loop must be re-pointed to F."""
        arr, sp = _section("chorus", ["F", "Fmaj7"], variant=1)
        moved = assign_harmonic_variants([(arr, 8, 8)], self.pools, [sp])
        self.assertEqual(arr["bus_variant"]["harmonic"], 0)
        self.assertEqual(moved.get("harmonic"), 1)

    def test_already_fitting_section_is_left_alone(self):
        arr, sp = _section("chorus", ["F", "Fmaj7"], variant=0)
        moved = assign_harmonic_variants([(arr, 8, 8)], self.pools, [sp])
        self.assertEqual(arr["bus_variant"]["harmonic"], 0)
        self.assertNotIn("harmonic", moved)

    def test_two_sections_can_land_on_different_variants(self):
        """The whole point: per-section harmony, not one loop for the track."""
        a_arr, a_sp = _section("verse", ["F", "Fmaj7"], variant=1)
        b_arr, b_sp = _section("bridge", ["B", "B"], variant=0)
        assign_harmonic_variants(
            [(a_arr, 8, 8), (b_arr, 8, 8)], self.pools, [a_sp, b_sp]
        )
        self.assertEqual(a_arr["bus_variant"]["harmonic"], 0)
        self.assertEqual(b_arr["bus_variant"]["harmonic"], 1)

    def test_rhythm_bus_is_never_reassigned(self):
        """Drums carry no pitch; reassigning them would churn for nothing."""
        arr, sp = _section("chorus", ["F"], variant=0)
        arr["bus_variant"]["rhythm"] = 0
        assign_harmonic_variants([(arr, 8, 8)], self.pools, [sp])
        self.assertEqual(arr["bus_variant"]["rhythm"], 0)
        self.assertNotIn("rhythm", assign_harmonic_variants([(arr, 8, 8)], self.pools, [sp]))

    def test_single_variant_pool_is_a_no_op(self):
        arr, sp = _section("chorus", ["B"], variant=0)
        moved = assign_harmonic_variants([(arr, 8, 8)], {"harmonic": [self.f_path]}, [sp])
        self.assertEqual(moved, {})
        self.assertEqual(arr["bus_variant"]["harmonic"], 0)

    def test_sections_without_chords_are_untouched(self):
        arr, sp = _section("intro", [], variant=1)
        moved = assign_harmonic_variants([(arr, 8, 8)], self.pools, [sp])
        self.assertEqual(moved, {})
        self.assertEqual(arr["bus_variant"]["harmonic"], 1)

    def test_mismatched_plan_lengths_are_refused(self):
        arr, sp = _section("chorus", ["F"], variant=1)
        self.assertEqual(assign_harmonic_variants([(arr, 8, 8)], self.pools, [sp, sp]), {})
        self.assertEqual(arr["bus_variant"]["harmonic"], 1)

    def test_silent_variants_leave_the_rotation_alone(self):
        silent_a = os.path.join(self.tmp.name, "s0.wav")
        silent_b = os.path.join(self.tmp.name, "s1.wav")
        for p in (silent_a, silent_b):
            sf.write(p, np.zeros((TARGET_SR, 2)), TARGET_SR)
        arr, sp = _section("chorus", ["F"], variant=1)
        moved = assign_harmonic_variants(
            [(arr, 8, 8)], {"harmonic": [silent_a, silent_b]}, [sp]
        )
        self.assertEqual(moved, {})
        self.assertEqual(arr["bus_variant"]["harmonic"], 1)

    def test_tolerance_is_a_real_band(self):
        self.assertGreater(VARIANT_FIT_TOLERANCE, 0.0)
        self.assertLess(VARIANT_FIT_TOLERANCE, 0.5)


if __name__ == "__main__":
    unittest.main()
