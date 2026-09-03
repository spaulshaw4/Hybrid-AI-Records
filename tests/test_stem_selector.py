"""Key-compatibility scoring, tempo clamp behaviour, role fit, seeded picking."""
from __future__ import annotations

import os
import sqlite3
import sys
from random import Random

import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.stem_selector import (  # noqa: E402
    DEAD_RMS_DBFS,
    STRETCH_RATE_MAX,
    STRETCH_RATE_MIN,
    bpm_compatibility,
    centroid_fit,
    fetch_candidate_rows,
    fold_bpm,
    key_compatibility,
    level_fit,
    note_to_semitone,
    pick_variants,
    rank_candidates,
    required_stretch_rate,
    role_from_filename,
    score_candidate,
    select_for_role,
)

SCHEMA = """
CREATE TABLE slice_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT, filename TEXT, stem_type TEXT, detected_key TEXT,
    estimated_bpm REAL, rms_db REAL, spectral_centroid REAL, tags TEXT,
    duration_sec REAL
);
CREATE TABLE slice_history (
    file_path TEXT PRIMARY KEY, last_used TEXT NOT NULL, use_count INTEGER NOT NULL DEFAULT 1
);
"""


# --------------------------------------------------------------------------
# key compatibility
# --------------------------------------------------------------------------


def test_note_parsing_handles_sharps_flats_and_unicode():
    assert note_to_semitone("C") == 0
    assert note_to_semitone("c#") == 1
    assert note_to_semitone("Db") == 1
    assert note_to_semitone("B\u266d") == 10
    assert note_to_semitone("F\u266f") == 6
    assert note_to_semitone("") is None
    assert note_to_semitone("H") is None


def test_exact_root_scores_one():
    assert key_compatibility("D", "D") == 1.0


def test_relative_major_minor_scores_above_fifths():
    relative = key_compatibility("F", "D")  # +3 semitones
    relative_down = key_compatibility("B", "D")  # -3 semitones
    fifth = key_compatibility("A", "D")  # +7 semitones -> folds to 5
    assert relative == relative_down == 0.85
    assert relative > fifth


def test_neighbouring_fifths_both_directions_score_the_same():
    assert key_compatibility("A", "D") == key_compatibility("G", "D") == 0.72


def test_two_steps_around_the_circle_scores_lower_than_a_fifth():
    two_steps = key_compatibility("E", "D")  # whole tone == two fifths
    assert two_steps == 0.45
    assert two_steps < key_compatibility("A", "D")


def test_distant_key_is_heavily_penalised():
    assert key_compatibility("G#", "D") == 0.15


def test_key_scoring_is_symmetric():
    for candidate in ("C", "D", "E", "F#", "A#"):
        for target in ("C", "D", "E", "F#", "A#"):
            assert key_compatibility(candidate, target) == key_compatibility(target, candidate)


def test_missing_target_key_is_neutral_and_missing_candidate_is_penalised():
    assert key_compatibility("D", None) == 0.5
    assert key_compatibility(None, "D") == 0.25


def test_key_scoring_is_mode_agnostic():
    # The index stores a root only; a D-rooted slice must not be rejected
    # because the target was written "D minor".
    assert key_compatibility("D", "D minor") == 1.0


# --------------------------------------------------------------------------
# tempo
# --------------------------------------------------------------------------


def test_half_time_estimate_folds_onto_the_target():
    assert fold_bpm(70.0, 140.0) == pytest.approx(140.0)
    assert fold_bpm(280.0, 140.0) == pytest.approx(140.0)


def test_exact_tempo_scores_one():
    assert bpm_compatibility(140.0, 140.0) == pytest.approx(1.0)


def test_tempo_score_decays_with_distance():
    near = bpm_compatibility(136.0, 140.0)
    far = bpm_compatibility(118.0, 140.0)
    assert 0.0 < far < near < 1.0


def test_folded_tempo_never_needs_a_stretch_outside_the_wsola_clamp():
    # dsp/tempo_time_stretch.py clamps the rate to [0.5, 2.0]. Octave folding
    # must keep every candidate inside that window, otherwise the clamp would
    # silently leave the slice off-tempo.
    for target in (90.0, 120.0, 140.0, 175.0):
        for candidate in (60.8, 68.0, 97.0, 139.7, 206.7, 224.7):
            rate = required_stretch_rate(candidate, target)
            assert STRETCH_RATE_MIN <= rate <= STRETCH_RATE_MAX
            assert bpm_compatibility(candidate, target) > 0.0


def test_a_rate_beyond_the_clamp_scores_zero():
    assert bpm_compatibility(0.0001, 140.0) in (0.0, 0.25)
    assert bpm_compatibility(140.0, 0.0) == 0.5


def test_missing_tempo_data_is_neutral_or_penalised():
    assert bpm_compatibility(140.0, None) == 0.5
    assert bpm_compatibility(None, 140.0) == 0.25


# --------------------------------------------------------------------------
# role fit
# --------------------------------------------------------------------------


def test_sub_bass_wants_a_low_centroid():
    assert centroid_fit(240.0, "bass") > centroid_fit(2600.0, "bass")


def test_vocal_chop_wants_an_upper_mid_centroid():
    assert centroid_fit(2600.0, "vocal") > centroid_fit(200.0, "vocal")


def test_silent_centroid_scores_zero():
    assert centroid_fit(0.0, "bass") == 0.0


def test_dead_slices_score_zero_overall():
    row = {
        "detected_key": "D",
        "estimated_bpm": 140.0,
        "rms_db": -120.0,
        "spectral_centroid": 0.0,
    }
    assert level_fit(-120.0, "vocal") == 0.0
    assert score_candidate(row, "vocal", "D", 140.0)["score"] == 0.0


def test_level_fit_prefers_the_usable_window():
    assert level_fit(-22.0, "vocal") == 1.0
    assert level_fit(-50.0, "vocal") < 1.0
    assert level_fit(DEAD_RMS_DBFS - 1.0, "vocal") == 0.0


def test_role_from_filename_rejects_the_full_mixture():
    assert role_from_filename("bass_s4_00008.wav") == "bass"
    assert role_from_filename("808_loop_01.wav") == "bass"
    assert role_from_filename("sub_heavy_01.wav") == "bass"
    assert role_from_filename("drums_s4_00001.wav") == "rhythm"
    assert role_from_filename("vocals_s4_00003.wav") == "vocal"
    assert role_from_filename("other_s4_00004.wav") == "harmonic"
    assert role_from_filename("mixture_s4_00000.wav") is None
    assert role_from_filename("subject_pad.wav") != "bass"


def test_a_perfectly_matched_row_outscores_a_mismatched_one():
    good = {
        "detected_key": "D", "estimated_bpm": 140.0,
        "rms_db": -22.0, "spectral_centroid": 250.0,
    }
    bad = {
        "detected_key": "G#", "estimated_bpm": 97.0,
        "rms_db": -50.0, "spectral_centroid": 6000.0,
    }
    assert score_candidate(good, "bass", "D", 140.0)["score"] > score_candidate(
        bad, "bass", "D", 140.0
    )["score"]


# --------------------------------------------------------------------------
# selection against a real sqlite index
# --------------------------------------------------------------------------


@pytest.fixture()
def index_db(tmp_path):
    db_path = tmp_path / "corpus_index.sqlite"
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    rows = []
    keys = ["D", "F", "A", "G#", "C"]
    for i in range(30):
        for role, stem, centroid in (
            ("bass", "harmonic", 240.0),
            ("drums", "rhythm", 3400.0),
            ("other", "harmonic", 2200.0),
            ("vocals", "vocal", 2600.0),
            ("mixture", "harmonic", 2000.0),
        ):
            name = f"{role}_s4_{i:05d}.wav"
            path = tmp_path / name
            path.write_bytes(b"")
            rows.append(
                (
                    str(path), name, stem, keys[i % len(keys)],
                    120.0 + i, -24.0 - (i % 5), centroid + i * 10.0,
                    f"{role} corpus", 4.0,
                )
            )
    conn.executemany(
        "INSERT INTO slice_index (file_path, filename, stem_type, detected_key, "
        "estimated_bpm, rms_db, spectral_centroid, tags, duration_sec) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        rows,
    )
    conn.commit()
    return conn


def test_bass_role_never_returns_a_mixture_or_a_drum(index_db):
    rows = fetch_candidate_rows(index_db, "bass")
    assert rows
    assert all(row["filename"].startswith("bass") for row in rows)


def test_harmonic_role_excludes_bass_and_mixture(index_db):
    rows = fetch_candidate_rows(index_db, "harmonic")
    assert rows
    assert all(row["filename"].startswith("other") for row in rows)


def test_ranking_puts_the_best_musical_fit_first(index_db):
    rows = fetch_candidate_rows(index_db, "bass")
    ranked = rank_candidates(rows, "bass", "D", 140.0, centroid_target_hz=250.0)
    assert ranked
    assert ranked[0]["score"] >= ranked[-1]["score"]
    assert ranked[0]["detected_key"] in {"D", "F", "B", "A", "G"}


def test_same_seed_picks_the_same_stems(index_db):
    a = select_for_role(index_db, "bass", "D", 140.0, 3, Random(2024), centroid_target_hz=250.0)
    b = select_for_role(index_db, "bass", "D", 140.0, 3, Random(2024), centroid_target_hz=250.0)
    assert [x["file_path"] for x in a] == [x["file_path"] for x in b]


def test_different_seeds_pick_different_stems(index_db):
    picks = set()
    for seed in range(20):
        chosen = select_for_role(
            index_db, "bass", "D", 140.0, 2, Random(seed), centroid_target_hz=250.0
        )
        picks.add(tuple(sorted(x["file_path"] for x in chosen)))
    assert len(picks) > 1


def test_selection_returns_distinct_files(index_db):
    chosen = select_for_role(index_db, "vocal", "D", 140.0, 4, Random(9))
    paths = [x["file_path"] for x in chosen]
    assert len(paths) == len(set(paths)) == 4


def test_cooldown_pushes_recently_used_slices_down(index_db):
    rows = fetch_candidate_rows(index_db, "vocal")
    target = rows[0]["file_path"]
    index_db.execute(
        "INSERT INTO slice_history (file_path, last_used, use_count) VALUES (?, ?, ?)",
        (target, "2020-01-01T00:00:00Z", 400),
    )
    index_db.commit()
    ranked = rank_candidates(
        fetch_candidate_rows(index_db, "vocal"), "vocal", "D", 140.0
    )
    heavy = next(r for r in ranked if r["file_path"] == target)
    assert heavy["rank_key"] < heavy["score"]


def test_reproducible_mode_ignores_render_history(index_db):
    """An explicit seed must survive the corpus being rendered in between."""
    before = select_for_role(
        index_db, "vocal", "D", 140.0, 3, Random(1), use_cooldown=False
    )
    index_db.executemany(
        "INSERT OR REPLACE INTO slice_history (file_path, last_used, use_count) "
        "VALUES (?, ?, ?)",
        [(row["file_path"], "2026-01-01T00:00:00Z", 99) for row in before],
    )
    index_db.commit()
    after = select_for_role(
        index_db, "vocal", "D", 140.0, 3, Random(1), use_cooldown=False
    )
    assert [r["file_path"] for r in before] == [r["file_path"] for r in after]


def test_cooldown_mode_moves_away_after_heavy_use(index_db):
    used = select_for_role(index_db, "vocal", "D", 140.0, 3, Random(1), use_cooldown=True)
    index_db.executemany(
        "INSERT OR REPLACE INTO slice_history (file_path, last_used, use_count) "
        "VALUES (?, ?, ?)",
        [(row["file_path"], "2026-01-01T00:00:00Z", 500) for row in used],
    )
    index_db.commit()
    later = select_for_role(index_db, "vocal", "D", 140.0, 3, Random(1), use_cooldown=True)
    assert set(r["file_path"] for r in later) != set(r["file_path"] for r in used)


def test_ranking_is_deterministic_without_cooldown(index_db):
    a = rank_candidates(
        fetch_candidate_rows(index_db, "bass", use_cooldown=False),
        "bass", "D", 140.0, use_cooldown=False,
    )
    b = rank_candidates(
        fetch_candidate_rows(index_db, "bass", use_cooldown=False),
        "bass", "D", 140.0, use_cooldown=False,
    )
    assert [x["file_path"] for x in a] == [x["file_path"] for x in b]


def test_pick_variants_on_an_empty_ranking_is_empty():
    assert pick_variants([], 3, Random(1)) == []


def test_bass_role_matches_808_and_sub_filenames(tmp_path):
    """stem_type has no bass; 808 / sub filenames must still feed the bass bus."""
    db_path = tmp_path / "idx.sqlite"
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    rows = []
    for name, stem, centroid in (
        ("808_s4_00001.wav", "harmonic", 180.0),
        ("sub_heavy_00002.wav", "harmonic", 160.0),
        ("other_s4_00003.wav", "harmonic", 2200.0),
        ("mixture_s4_00000.wav", "harmonic", 2000.0),
    ):
        path = tmp_path / name
        path.write_bytes(b"")
        rows.append(
            (str(path), name, stem, "D", 140.0, -22.0, centroid, name.replace("_", " "), 4.0)
        )
    conn.executemany(
        "INSERT INTO slice_index (file_path, filename, stem_type, detected_key, "
        "estimated_bpm, rms_db, spectral_centroid, tags, duration_sec) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        rows,
    )
    conn.commit()
    found = fetch_candidate_rows(conn, "bass")
    names = {row["filename"] for row in found}
    assert "808_s4_00001.wav" in names
    assert "sub_heavy_00002.wav" in names
    assert "mixture_s4_00000.wav" not in names
    assert "other_s4_00003.wav" not in names


def test_bass_falls_back_to_low_centroid_harmonic(tmp_path):
    db_path = tmp_path / "idx.sqlite"
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    rows = []
    for name, centroid in (("other_low_00001.wav", 180.0), ("other_air_00002.wav", 3200.0)):
        path = tmp_path / name
        path.write_bytes(b"")
        rows.append(
            (str(path), name, "harmonic", "D", 140.0, -22.0, centroid, "other pad", 4.0)
        )
    conn.executemany(
        "INSERT INTO slice_index (file_path, filename, stem_type, detected_key, "
        "estimated_bpm, rms_db, spectral_centroid, tags, duration_sec) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        rows,
    )
    conn.commit()
    assert fetch_candidate_rows(conn, "bass") == []
    picks = select_for_role(conn, "bass", "D", 140.0, 1, Random(3), centroid_target_hz=250.0)
    assert picks
    assert picks[0]["filename"] == "other_low_00001.wav"
