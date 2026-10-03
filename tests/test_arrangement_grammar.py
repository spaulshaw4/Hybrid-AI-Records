"""Ten arrangement archetypes, and the subgenre deltas that inherit them."""
from __future__ import annotations

import os
import sys

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.blueprint_track_assembler import _fill_window_bars  # noqa: E402
from engine.genre_arrangement_profiles import (  # noqa: E402
    ARCHETYPES,
    bass_open_steps,
    comping_open_steps,
    resolve_genre_grammar,
)
from engine.song_plan import _grammar_chord  # noqa: E402


def test_ten_archetypes_are_the_whole_tree():
    assert len(ARCHETYPES) == 10
    assert "driving_rock_metal" in ARCHETYPES
    assert "ambient_drone_minimal" in ARCHETYPES


def test_subgenre_inherits_parent_and_keeps_its_delta():
    outlaw = resolve_genre_grammar("outlaw_country")
    assert outlaw.archetype == "roots_americana"
    assert outlaw.bpm_range == (96, 126)
    assert outlaw.allowed_chords == ["triad", "dom7"]
    assert "maj7" in outlaw.forbidden_chords
    assert outlaw.bass_behavior == "alternating_root_fifth"
    assert outlaw.max_consecutive_repeats == 1

    thrash = resolve_genre_grammar("thrash_metal")
    assert thrash.archetype == "driving_rock_metal"
    assert thrash.bpm_range == (170, 220)
    assert thrash.forbidden_chords == ["maj7", "dom7", "add9"]
    assert thrash.comping_style == "palm_mute_driving_eighths"


def test_unlisted_genres_classify_by_token():
    assert resolve_genre_grammar("uk_techno").archetype == "four_on_the_floor_club"
    assert resolve_genre_grammar("doom_metal").archetype == "driving_rock_metal"
    assert resolve_genre_grammar("roots_reggae").archetype == "island_syncopated"
    assert resolve_genre_grammar("amapiano").archetype == "afro_groove_log"
    assert resolve_genre_grammar("made_up_genre").archetype == "driving_rock_metal"


def test_outlaw_country_spells_triads_and_dominant_sevenths_only():
    grammar = resolve_genre_grammar("Outlaw Country")
    assert _grammar_chord("G", "minor", "i", grammar) == "Gm"
    assert _grammar_chord("G", "minor", "VI", grammar) == "Eb"
    assert _grammar_chord("G", "major", "V", grammar) == "D7"
    assert _grammar_chord("G", "major", "I", grammar) == "G7"
    spelled = _grammar_chord("G", "minor", "VI", grammar)
    assert "maj7" not in spelled and "maj9" not in spelled and "sus" not in spelled


def test_rock_uses_power_chords_and_refuses_jazz_colors():
    grammar = resolve_genre_grammar("symphonic_rock")
    assert _grammar_chord("E", "minor", "i", grammar) == "Em"
    assert _grammar_chord("E", "minor", "VI", grammar) == "C5"
    assert "maj9" not in grammar.allowed_chords


def test_reggae_skank_is_the_and_and_bass_rests_on_beat_one():
    grammar = resolve_genre_grammar("reggae")
    assert comping_open_steps(grammar.comping_style) == {2, 6, 10, 14}
    bass = bass_open_steps(grammar.bass_behavior)
    assert bass is not None and 0 not in bass and 4 in bass


def test_fill_window_is_the_end_of_the_block_while_the_vocal_rests():
    assert _fill_window_bars(8, 4, 4) == [6, 7]
    assert _fill_window_bars(8, 8, 2) == []
    assert _fill_window_bars(16, 2, 6)[:2] == [6, 7]
