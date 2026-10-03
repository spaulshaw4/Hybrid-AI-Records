"""Harmonic qualification narrows the field; the conductor still chooses.

The scorer no longer picks a winner per section. It returns the subset of
staged loops that are harmonically compatible with that section's chords, and
the conductor's ``bus_variant`` rotation picks from inside the subset with its
anti-repetition intent intact.
"""
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
    VARIANT_QUALIFY_FIT_SLACK,
    assign_harmonic_variants,
    describe_section_variants,
    qualified_variants,
)
from engine.musical_features import chord_pitch_classes  # noqa: E402
from ml.audio_features import TARGET_SR  # noqa: E402


def _write_chord(path: str, chord: str, octaves=(3, 4), seconds: float = 1.5) -> None:
    t = np.linspace(0.0, seconds, int(TARGET_SR * seconds), endpoint=False)
    x = np.zeros_like(t)
    for pc in chord_pitch_classes(chord):
        for octave in octaves:
            midi = 12 * (octave + 1) + pc
            x += np.sin(2 * np.pi * 440.0 * (2.0 ** ((midi - 69) / 12.0)) * t)
    x /= np.max(np.abs(x)) + 1e-9
    sf.write(path, np.stack([x, x], axis=1), TARGET_SR)


def _section(name: str, chords: list[str], variant: int):
    """(arrangement_section, song_plan_section) pair sharing a variant index."""
    arrangement = {"name": name, "bus_variant": {"harmonic": variant, "rhythm": variant}}
    song_plan = {"name": name, "chord_progression": chords, "bars_per_chord": 2}
    return arrangement, song_plan


class TestHarmonicQualification(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # Variant 0 is an F major triad, variant 1 is a B major triad — no
        # shared pitch classes, so chord fit can separate them cleanly.
        self.f_path = os.path.join(self.tmp.name, "v0_f.wav")
        self.b_path = os.path.join(self.tmp.name, "v1_b.wav")
        # A second F voicing: same pitch classes an octave up, so it measures
        # as compatible as the first and both qualify together.
        self.f_alt_path = os.path.join(self.tmp.name, "v1_f_alt.wav")
        _write_chord(self.f_path, "F")
        _write_chord(self.b_path, "B")
        _write_chord(self.f_alt_path, "F", octaves=(4, 5))
        self.pools = {"harmonic": [self.f_path, self.b_path], "rhythm": [self.f_path]}
        self.two_f = {"harmonic": [self.f_path, self.f_alt_path]}

    def tearDown(self):
        self.tmp.cleanup()

    def test_section_moves_off_a_variant_that_does_not_qualify(self):
        """An F-major section pointed at the B loop must be re-pointed to F."""
        arr, sp = _section("chorus", ["F", "Fmaj7"], variant=1)
        moved = assign_harmonic_variants([(arr, 8, 8)], self.pools, [sp])
        self.assertEqual(arr["bus_variant"]["harmonic"], 0)
        self.assertEqual(moved.get("harmonic"), 1)

    def test_qualified_rotation_choice_is_left_alone(self):
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

    def test_identical_progressions_still_land_on_different_variants(self):
        """Same chords give the same qualified set, not the same loop.

        Identical pitch weights mean identical fits, so an argmax would put
        both sections on one loop by construction. Qualification leaves the
        rotation free to take different members of the set.
        """
        a_arr, a_sp = _section("verse", ["Am7", "Fmaj7", "Cmaj7", "Gmaj7"], variant=0)
        b_arr, b_sp = _section("drop", ["Am7", "Fmaj7", "Cmaj7", "Gmaj7"], variant=0)
        assign_harmonic_variants(
            [(a_arr, 8, 8), (b_arr, 8, 8)], self.two_f, [a_sp, b_sp]
        )
        self.assertNotEqual(
            a_arr["bus_variant"]["harmonic"], b_arr["bus_variant"]["harmonic"]
        )

    def test_conductor_verse_two_differentiation_survives(self):
        """``local_song_conductor`` sets verse 2 one variant past verse 1."""
        a_arr, a_sp = _section("verse", ["Am7", "Fmaj7"], variant=0)
        b_arr, b_sp = _section("verse_2", ["Am7", "Fmaj7"], variant=1)
        moved = assign_harmonic_variants(
            [(a_arr, 8, 8), (b_arr, 8, 8)], self.two_f, [a_sp, b_sp]
        )
        self.assertEqual(a_arr["bus_variant"]["harmonic"], 0)
        self.assertEqual(b_arr["bus_variant"]["harmonic"], 1)
        self.assertEqual(moved, {})

    def test_a_clashing_variant_is_never_qualified(self):
        """Variety never costs harmony: a clash stays out of the subset.

        Two F sections share a progression, so the second would normally be
        pushed off the loop the first took. The only alternative clashes, so
        both keep the one loop that fits.
        """
        a_arr, a_sp = _section("verse", ["F", "Fmaj7"], variant=0)
        b_arr, b_sp = _section("verse_2", ["F", "Fmaj7"], variant=0)
        assign_harmonic_variants(
            [(a_arr, 8, 8), (b_arr, 8, 8)], self.pools, [a_sp, b_sp]
        )
        self.assertEqual(a_arr["bus_variant"]["harmonic"], 0)
        self.assertEqual(b_arr["bus_variant"]["harmonic"], 0)

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

    def test_section_variant_dump_counts_distinct_loops(self):
        a_arr, a_sp = _section("verse", ["Am7"], variant=0)
        b_arr, b_sp = _section("verse_2", ["Am7"], variant=1)
        line = describe_section_variants(
            "harmonic", [(a_arr, 8, 8), (b_arr, 8, 8)], [a_sp, b_sp]
        )
        self.assertIn("verse=0", line)
        self.assertIn("verse_2=1", line)
        self.assertIn("2 distinct", line)


class TestQualificationBand(unittest.TestCase):
    def test_band_is_a_real_fraction_of_the_best_fit(self):
        self.assertGreater(VARIANT_QUALIFY_FIT_SLACK, 0.0)
        self.assertLessEqual(VARIANT_QUALIFY_FIT_SLACK, 1.0)

    def test_band_is_scale_free(self):
        """Why a fraction and not a fixed margin: the measure has no fixed unit.

        Measured variant spreads on live renders run 0.038 to 0.177; a fixed
        0.04 admitted everything at the narrow end and only near-ties at the
        wide end.
        """
        wide = qualified_variants([0.80, 0.76, 0.60])
        narrow = qualified_variants([0.400, 0.380, 0.300])
        self.assertEqual(wide, [0, 1])
        self.assertEqual(wide, narrow)

    def test_a_clear_outlier_is_dropped_and_a_tight_cluster_is_not(self):
        """A noise-width spread must not cost the rotation its loops."""
        self.assertEqual(qualified_variants([0.72, 0.70, 0.71, 0.10]), [0, 1, 2])
        self.assertEqual(qualified_variants([0.72, 0.70, 0.71, 0.69]), [0, 1, 2, 3])

    def test_identical_fits_qualify_everything(self):
        """Nothing to choose on harmony: the rotation passes through."""
        self.assertEqual(qualified_variants([0.5, 0.5, 0.5]), [0, 1, 2])

    def test_the_subset_is_never_empty(self):
        self.assertEqual(qualified_variants([0.1]), [0])
        self.assertEqual(qualified_variants([]), [])


if __name__ == "__main__":
    unittest.main()
