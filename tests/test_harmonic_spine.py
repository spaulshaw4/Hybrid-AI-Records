"""Harmonic spine: role progressions in the plan, chord-following loops in assembly."""
from __future__ import annotations

import os
import sys

import numpy as np

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.blueprint_track_assembler import (  # noqa: E402
    _carry_foundation_variant,
    _phrase_duty_segments,
    _render_arranged_bus,
    _render_chord_spans,
    chord_root_pc,
    samples_per_bar,
    section_chord_offsets,
)
from engine.local_song_conductor import conduct_arrangement  # noqa: E402
from engine.song_plan import _roman_to_chord, chord_density_for_song, role_progression  # noqa: E402
from engine.stem_role_router import split_pool_by_layer  # noqa: E402

SR = 22050
BPM = 110.0


def test_chord_quality_follows_numeral_case():
    assert _roman_to_chord("C", "major", "IV", 0.2) == "F"
    assert _roman_to_chord("C", "major", "vi", 0.2) == "Am"
    assert _roman_to_chord("E", "minor", "VI", 0.2) == "C"
    assert _roman_to_chord("E", "minor", "i", 0.2) == "Em"
    assert _roman_to_chord("E", "minor", "VI", 0.5) == "Cmaj7"
    assert _roman_to_chord("C", "major", "V", 0.5) == "G7"


def test_verse_holds_tension_and_chorus_resolves_to_tonic():
    assert role_progression("major", "verse", 0.5)[0] == "vi"
    assert role_progression("major", "chorus", 0.5)[0] == "I"
    assert role_progression("minor", "chorus", 0.5)[-1] == "i"
    assert role_progression("dorian", "chorus", 0.5) == role_progression("dorian", "verse", 0.5)


def test_full_song_plan_carries_role_chords_and_two_bar_rhythm():
    plan = conduct_arrangement("anthem", "pop", BPM, 210.0, seed=11, key="C", scale="major")
    sections = {s["name"]: s for s in plan["song_plan"]["sections"]}
    assert sections["verse_2"]["chord_progression"][0].startswith("A")  # vi
    assert sections["chorus"]["chord_progression"][0].startswith("C")  # I
    assert sections["chorus"]["bars_per_chord"] == 2
    roadmap = plan["song_plan"]["harmonic_roadmap"]
    chorus_start = sections["chorus"]["start_bar"]
    bars = [r for r in roadmap if r["section"] == "chorus"][:4]
    assert [b["bar"] for b in bars] == [chorus_start + i for i in range(4)]
    assert bars[0]["chord"] == bars[1]["chord"] != bars[2]["chord"]


def test_g_minor_stays_in_key_and_spells_flats():
    """G minor is Gm–Eb–Bb–F. Not A#/D#, and not a jump to A minor or C major."""
    verse = [
        _roman_to_chord("G", "minor", roman, 0.3)
        for roman in role_progression("minor", "verse", 0.3)
    ]
    assert verse == ["Gm", "Eb", "Bb", "F"]
    offsets = section_chord_offsets(verse, 4, 1, "G", "minor")
    assert offsets == [0, -4, 3, -2]
    assert section_chord_offsets(["F#"], 1, 1, "G", "minor") == [0]
    # C is iv of G minor: a fourth up, the short wrap, still inside the key.
    assert section_chord_offsets(["C"], 1, 1, "G", "minor") == [5]


def test_section_offsets_are_shortest_wrap_from_the_key():
    assert chord_root_pc("F#m7") == 6 and chord_root_pc("Bb") == 10
    offsets = section_chord_offsets(["C", "G", "Am", "F"], 8, 2, "C")
    assert offsets == [0, 0, -5, -5, -3, -3, 5, 5]
    assert section_chord_offsets([], 8, 2, "C") is None


def _dominant_hz(frame):
    spec = np.abs(np.fft.rfft(frame * np.hanning(frame.size)))
    return float(np.fft.rfftfreq(frame.size, 1.0 / SR)[int(np.argmax(spec))])


def test_chord_spans_shift_the_loop_and_keep_the_grid():
    bar = samples_per_bar(SR, BPM)
    t = np.arange(2 * bar + 400) / SR
    loop = np.column_stack([0.3 * np.sin(2 * np.pi * 220.0 * t)] * 2)
    shifts = [0, 0, 5, 5]
    out = _render_chord_spans(loop, "x.wav", 4 * bar, 0, shifts, bar, SR, BPM, 441, {})
    assert out.shape[0] == 4 * bar + 441
    first = _dominant_hz(out[bar // 2 : bar // 2 + 8192, 0])
    third = _dominant_hz(out[2 * bar + bar // 2 : 2 * bar + bar // 2 + 8192, 0])
    assert abs(first - 220.0) < 8.0
    assert abs(third - 220.0 * 2 ** (5 / 12)) < 10.0
    seam = 2 * bar
    jump = float(np.max(np.abs(np.diff(out[seam - 50 : seam + 500, 0]))))
    assert jump < 0.1


def test_country_song_stays_on_triads():
    density = chord_density_for_song("outlaw_country", "whiskey in G minor", 0.85)
    assert density == 0.40
    assert _roman_to_chord("G", "minor", "i", density) == "Gm"
    assert "9" not in _roman_to_chord("G", "minor", "VI", density)


def test_phrase_slice_plays_forward_instead_of_retriggering(tmp_path):
    """A short phrase file plays once from its read head. It does not restart every bar."""
    import soundfile as sf

    sr = 1000
    bpm = 240.0
    bar = samples_per_bar(sr, bpm)
    phrase = np.linspace(0.2, 0.8, 250, dtype=np.float64)
    path = tmp_path / "guitar_phrase.wav"
    sf.write(path, phrase, sr)
    total = 8 * bar
    plan = [({"name": "verse", "role": "verse", "bars": 8, "bus_variant": {"harmonic": 0}}, 8, total)]
    audio, _used = _render_arranged_bus(
        "harmonic",
        [str(path)],
        plan,
        total,
        sr,
        bpm,
        1,
        None,
        None,
        0,
        duty_cycle=(4, 4, 2),
    )
    rendered = audio[:, 0]
    assert np.max(np.abs(rendered[:250] - phrase)) < 1e-4
    assert float(np.max(np.abs(rendered[250:bar]))) == 0.0
    assert float(np.max(np.abs(rendered[bar : bar + 250]))) == 0.0


def test_second_phrase_continues_the_file(tmp_path):
    import soundfile as sf

    sr = 1000
    bpm = 240.0
    bar = samples_per_bar(sr, bpm)
    phrase = np.linspace(0.0, 1.0, 9 * bar, dtype=np.float64)
    path = tmp_path / "vocal_phrase.wav"
    sf.write(path, phrase, sr)
    total = 16 * bar
    plan = [({"name": "verse", "role": "verse", "bars": 16, "bus_variant": {"harmonic": 0}}, 16, total)]
    audio, _used = _render_arranged_bus(
        "harmonic",
        [str(path)],
        plan,
        total,
        sr,
        bpm,
        1,
        None,
        None,
        0,
        duty_cycle=(4, 4, 2),
    )
    rendered = audio[:, 0]
    assert np.max(np.abs(rendered[: 4 * bar] - phrase[: 4 * bar])) < 1e-4
    assert float(np.max(np.abs(rendered[4 * bar : 8 * bar]))) == 0.0
    assert np.max(np.abs(rendered[8 * bar : 12 * bar] - phrase[4 * bar : 8 * bar])) < 1e-4


def test_vocal_phrase_rests_and_does_not_tile_the_section():
    bar = 1000
    segments = _phrase_duty_segments(8, bar, 8 * bar, 0, 2)
    assert segments == [(0, 4 * bar, 0)]
    longer = _phrase_duty_segments(16, bar, 16 * bar, 0, 2)
    assert [variant for _start, _length, variant in longer] == [0, 1]
    assert longer[1][0] == 8 * bar


def test_chorus_keeps_the_verse_drum_groove():
    verse = {"name": "verse", "role": "verse", "bus_variant": {"rhythm": 1}}
    chorus = {"name": "chorus", "role": "chorus", "bus_variant": {"rhythm": 0}}
    _carry_foundation_variant([(verse, 8, 8), (chorus, 8, 8)])
    assert chorus["bus_variant"]["rhythm"] == 1


def test_vocal_files_do_not_fill_the_harmonic_bed():
    pools = split_pool_by_layer(
        [
            r"D:\corpus\vocal\vocal_rap_140.wav",
            r"D:\corpus\rhythm\drums_loop.wav",
        ]
    )
    assert pools["vocal"] == [r"D:\corpus\vocal\vocal_rap_140.wav"]
    assert pools["harmonic"] == []
    assert all("vocal" not in path for path in pools["rhythm"])
