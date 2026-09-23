"""Full-length song form, grid-locked loop seams, and vocal ad-lib policy."""
from __future__ import annotations

import os
import sqlite3
import sys

import numpy as np
import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.blueprint_track_assembler import (  # noqa: E402
    ADLIB_SPACING_BARS,
    apply_slice_crossfade,
    is_adlib_vocal,
    loop_period_samples,
    place_adlib_phrases,
    samples_per_bar,
    tile_loop_on_grid,
)
from engine.local_song_conductor import (  # noqa: E402
    FULL_SONG_SKELETON,
    conduct_arrangement,
)
from engine.stem_selector import fetch_candidate_rows  # noqa: E402

SR = 22050
BPM = 110.0


def test_bars_formula_for_three_thirty_at_110_bpm():
    assert round(210 * 110 / 240) == 96


def test_long_render_uses_full_song_form_with_96_bars():
    plan = conduct_arrangement("anthem", "pop", BPM, 210.0, seed=11)
    assert plan["skeleton"] == FULL_SONG_SKELETON
    assert plan["total_bars"] == 96
    roles = [s["role"] for s in plan["sections"]]
    assert roles == ["intro", "verse", "chorus", "verse", "chorus", "bridge", "chorus", "outro"]


def test_full_song_sections_contrast():
    plan = conduct_arrangement("anthem", "pop", BPM, 210.0, seed=11)
    by_name = {s["name"]: s for s in plan["sections"]}
    assert by_name["intro"]["bus_activation"]["rhythm"] == 0.0
    assert by_name["bridge"]["bus_activation"]["rhythm"] == 0.0
    assert by_name["chorus_3"]["bus_activation"]["rhythm"] == 1.0
    assert by_name["outro"]["bus_activation"]["vocal"] == 0.0


def test_short_render_keeps_the_ivbd_skeleton():
    plan = conduct_arrangement("anthem", "pop", BPM, 60.0, seed=11)
    assert plan["skeleton"] != FULL_SONG_SKELETON


def test_slice_crossfade_tapers_both_edges():
    audio = np.ones((SR, 2))
    faded = apply_slice_crossfade(audio, fade_ms=20.0, sr=SR)
    n = int(round(0.02 * SR))
    assert faded[0, 0] == pytest.approx(0.0, abs=1e-9)
    assert faded[-1, 0] == pytest.approx(0.0, abs=1e-9)
    assert faded[n + 5, 0] == pytest.approx(1.0)
    assert faded[n // 2, 0] == pytest.approx(np.sin(np.pi / 4), abs=0.05)


def test_grid_loop_period_is_whole_bars_and_never_drifts():
    bar = samples_per_bar(SR, BPM)
    # 2.1 bars of material -> period snaps to 2 bars.
    t = np.arange(int(2.1 * bar)) / SR
    loop = np.column_stack([np.sin(2 * np.pi * 220 * t)] * 2)
    assert loop_period_samples(loop.shape[0], SR, BPM) == 2 * bar
    tiled = tile_loop_on_grid(loop, 16 * bar, SR, BPM)
    assert tiled.shape[0] == 16 * bar
    # Every repeat starts at the same sample offset (grid-locked, no 20 ms creep).
    first = tiled[100 : 100 + 64, 0]
    for k in range(1, 8):
        start = k * 2 * bar + 100
        np.testing.assert_allclose(tiled[start : start + 64, 0], first, atol=1e-9)


def test_grid_loop_seam_has_no_step():
    bar = samples_per_bar(SR, BPM)
    t = np.arange(int(2.3 * bar)) / SR
    loop = np.column_stack([np.sin(2 * np.pi * 97.0 * t)] * 2)
    tiled = tile_loop_on_grid(loop, 6 * bar, SR, BPM)
    seam = 2 * bar
    jump = abs(tiled[seam, 0] - tiled[seam - 1, 0])
    typical = float(np.max(np.abs(np.diff(tiled[: bar, 0]))))
    assert jump <= typical * 1.5


def test_short_chant_is_classified_as_adlib():
    bar = samples_per_bar(SR, BPM)
    assert is_adlib_vocal("vocal_phrase_001.wav", bar // 2, SR, BPM)
    assert is_adlib_vocal("oh_yeah_adlib_4bar.wav", 8 * bar, SR, BPM)
    assert not is_adlib_vocal("lead_verse_take.wav", 4 * bar, SR, BPM)
    # A 4.0 s corpus_4s vocal slice at 110 BPM (~1.83 bars) stays a looped line.
    assert not is_adlib_vocal("vocals_s4_00041.wav", int(4.0 * SR), SR, BPM)


def test_adlibs_are_one_shots_not_a_loop():
    bar = samples_per_bar(SR, BPM)
    phrase = np.ones((bar // 2, 2)) * 0.5
    out = place_adlib_phrases(phrase, 16 * bar, SR, BPM)
    active = np.max(np.abs(out), axis=1) > 1e-6
    hits = int(np.sum(np.diff(active.astype(int)) == 1)) + int(active[0])
    assert hits == 16 // ADLIB_SPACING_BARS
    # First hit lands on the last bar of the first phrase, not bar 1.
    assert not active[: (ADLIB_SPACING_BARS - 1) * bar - 1].any()


def test_vocal_selector_rejects_rows_filed_under_harmonic_folder(tmp_path):
    db = sqlite3.connect(str(tmp_path / "idx.sqlite"))
    db.executescript(
        """
        CREATE TABLE slice_index (id INTEGER PRIMARY KEY, file_path TEXT, filename TEXT,
          stem_type TEXT, detected_key TEXT, estimated_bpm REAL, rms_db REAL,
          spectral_centroid REAL, tags TEXT, duration_sec REAL);
        CREATE TABLE slice_history (file_path TEXT, last_used TEXT, use_count INTEGER);
        """
    )
    rows = [
        (r"D:\corpus_4s\harmonic\123_phrase_0001.wav", "123_phrase_0001.wav", "vocal", None),
        (r"D:\corpus\vocal\lead_take_01.wav", "lead_take_01.wav", "vocal", 110.0),
    ]
    for path, name, stem, bpm in rows:
        db.execute(
            "INSERT INTO slice_index (file_path, filename, stem_type, estimated_bpm, rms_db,"
            " spectral_centroid, detected_key, duration_sec) VALUES (?,?,?,?,?,?,?,?)",
            (path, name, stem, bpm, -18.0, 2500.0, "A", 4.0),
        )
    picked = [r["file_path"] for r in fetch_candidate_rows(db, "vocal", use_cooldown=False)]
    assert picked == [r"D:\corpus\vocal\lead_take_01.wav"]
