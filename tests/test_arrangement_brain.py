"""Seeded reproducibility, cross-seed variation, section bar math, bus activation."""
from __future__ import annotations

import os
import sys

import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.arrangement_brain import (  # noqa: E402
    MAX_PREDROPS,
    MIN_SECTION_BARS,
    PREDROP_BARS,
    apply_arrangement_to_blueprint,
    arrangement_signature,
    bars_to_seconds,
    build_arrangement,
    derive_seed,
    describe_arrangement,
    seconds_to_bars,
)
from engine.blueprint_schema import validate_blueprint  # noqa: E402
from engine.genre_arrangement_profiles import (  # noqa: E402
    BUSES,
    arrangement_profile,
    family_for_genre,
    normalise_section_role,
)

PROMPT = "Heavy modern rap-rock groove with punchy drums, distorted sub bass, and clean dry vocal chops"


def _plan(seed: int, genre: str | None = "rap_rock", bpm: float = 140.0, duration: float = 60.0):
    return build_arrangement(PROMPT, genre, bpm, duration, seed=seed)


# --------------------------------------------------------------------------
# seed derivation
# --------------------------------------------------------------------------


def test_explicit_seed_wins_over_request_id():
    a, _ = derive_seed(PROMPT, "user-a", explicit_seed=4242)
    b, _ = derive_seed(PROMPT, "user-b", explicit_seed=4242)
    assert a == b == 4242


def test_same_prompt_same_request_id_is_stable():
    a, _ = derive_seed(PROMPT, "session-77")
    b, _ = derive_seed(PROMPT, "session-77")
    assert a == b


def test_two_users_same_prompt_get_different_seeds():
    a, _ = derive_seed(PROMPT, "user-alpha")
    b, _ = derive_seed(PROMPT, "user-beta")
    assert a != b


def test_omitted_request_id_generates_a_fresh_identity():
    a, rid_a = derive_seed(PROMPT)
    b, rid_b = derive_seed(PROMPT)
    assert rid_a != rid_b
    assert a != b


# --------------------------------------------------------------------------
# reproducibility and variation
# --------------------------------------------------------------------------


def test_same_seed_reproduces_the_identical_arrangement():
    assert arrangement_signature(_plan(1234)) == arrangement_signature(_plan(1234))


def test_different_seeds_change_the_section_map():
    signatures = {arrangement_signature(_plan(seed)) for seed in range(40)}
    # Not every seed has to differ, but the space must not collapse to one song.
    assert len(signatures) >= 15


def test_different_seeds_change_bus_activation_numbers():
    a = _plan(7)
    b = _plan(8)
    act_a = [tuple(s["bus_activation"][bus] for bus in BUSES) for s in a["sections"]]
    act_b = [tuple(s["bus_activation"][bus] for bus in BUSES) for s in b["sections"]]
    assert act_a != act_b


def test_different_seeds_change_loop_variant_choices():
    variants = set()
    for seed in range(25):
        plan = _plan(seed)
        variants.add(
            tuple(
                tuple(s["bus_variant"][bus] for bus in BUSES) for s in plan["sections"]
            )
        )
    assert len(variants) >= 15


def test_seed_is_recorded_on_the_arrangement():
    plan = _plan(999)
    assert plan["seed"] == 999


# --------------------------------------------------------------------------
# section bar math
# --------------------------------------------------------------------------


def test_bar_seconds_round_trip_at_140_bpm():
    assert bars_to_seconds(1, 140.0) == pytest.approx(240.0 / 140.0)
    assert seconds_to_bars(60.0, 140.0) == 35


def test_every_section_is_a_whole_bar_count():
    for seed in range(20):
        for section in _plan(seed)["sections"]:
            assert isinstance(section["bars"], int)
            assert section["bars"] >= MIN_SECTION_BARS


def test_total_bars_match_the_requested_duration():
    for seed in range(20):
        plan = _plan(seed, duration=60.0)
        assert plan["total_bars"] == seconds_to_bars(60.0, 140.0)
        assert sum(s["bars"] for s in plan["sections"]) == plan["total_bars"]


def test_short_duration_drops_sections_instead_of_going_sub_bar():
    plan = _plan(3, duration=16.0)
    assert plan["total_bars"] == seconds_to_bars(16.0, 140.0)
    assert all(s["bars"] >= MIN_SECTION_BARS for s in plan["sections"])


def test_longer_duration_grows_the_same_skeleton():
    short = _plan(11, duration=60.0)
    long = _plan(11, duration=180.0)
    assert long["total_bars"] > short["total_bars"]


def test_predrop_sections_are_exactly_two_bars_and_capped():
    for seed in range(30):
        predrops = [s for s in _plan(seed)["sections"] if s["predrop"]]
        assert len(predrops) <= MAX_PREDROPS
        assert all(s["bars"] == PREDROP_BARS for s in predrops)


# --------------------------------------------------------------------------
# bus activation must actually differ across sections
# --------------------------------------------------------------------------


def test_bus_activation_differs_across_sections():
    for seed in range(20):
        plan = _plan(seed)
        maps = {
            tuple(s["bus_activation"][bus] for bus in BUSES) for s in plan["sections"]
        }
        assert len(maps) >= 4, "sections collapsed onto one activation map"


def test_chorus_is_denser_than_intro():
    for seed in range(20):
        plan = _plan(seed)
        intro = next(s for s in plan["sections"] if s["role"] == "intro")
        peaks = [s for s in plan["sections"] if s["role"] in {"chorus", "drop"}]
        assert peaks
        intro_sum = sum(intro["bus_activation"].values())
        assert max(sum(p["bus_activation"].values()) for p in peaks) > intro_sum


def test_activation_stays_in_unit_range():
    for seed in range(20):
        for section in _plan(seed)["sections"]:
            for bus in BUSES:
                assert 0.0 <= section["bus_activation"][bus] <= 1.0


def test_predrop_mutes_at_least_two_buses():
    found = False
    for seed in range(40):
        for section in _plan(seed)["sections"]:
            if not section["predrop"]:
                continue
            found = True
            silent = [b for b in BUSES if section["bus_activation"][b] <= 0.0]
            assert len(silent) >= 2
    assert found, "no pre-drop was ever generated across 40 seeds"


def test_bass_can_drop_out_for_the_intro():
    intros_without_bass = 0
    for seed in range(30):
        intro = next(s for s in _plan(seed)["sections"] if s["role"] == "intro")
        if intro["bus_activation"]["bass"] == 0.0:
            intros_without_bass += 1
    assert intros_without_bass > 0


def test_outro_has_no_vocal():
    for seed in range(15):
        outro = [s for s in _plan(seed)["sections"] if s["role"] == "outro"]
        for section in outro:
            assert section["bus_activation"]["vocal"] == 0.0


# --------------------------------------------------------------------------
# genre drives the skeleton
# --------------------------------------------------------------------------


def test_genres_map_to_distinct_arrangement_families():
    assert family_for_genre("nu_metal") == "rock_metal"
    assert family_for_genre("hip_hop") == "hiphop_rnb"
    assert family_for_genre("rap_rock") == "hiphop_rnb"
    assert family_for_genre("techno") == "electronic_club"
    assert family_for_genre("ambient") == "cinematic_ambient"
    assert family_for_genre("jazz_fusion") == "jazz_roots"
    assert family_for_genre("heavy_alternative_rock") == "rock_metal"


def test_same_seed_different_genre_produces_a_different_skeleton():
    shapes = {}
    for genre in ("nu_metal", "techno", "ambient", "jazz", "hip_hop"):
        plan = build_arrangement(PROMPT, genre, 140.0, 60.0, seed=555)
        shapes[genre] = tuple((s["role"], s["bars"]) for s in plan["sections"])
    assert len(set(shapes.values())) == len(shapes)


def test_genre_profile_sets_distinct_bus_level_targets():
    metal = arrangement_profile("nu_metal")["bus_target_rms_dbfs"]
    hiphop = arrangement_profile("hip_hop")["bus_target_rms_dbfs"]
    ambient = arrangement_profile("ambient")["bus_target_rms_dbfs"]
    assert hiphop["bass"] > metal["bass"]
    assert ambient["harmonic"] > metal["harmonic"]
    assert ambient["rhythm"] < metal["rhythm"]


def test_ambient_keeps_drums_quieter_than_metal():
    ambient = build_arrangement(PROMPT, "ambient", 120.0, 90.0, seed=21)
    metal = build_arrangement(PROMPT, "nu_metal", 120.0, 90.0, seed=21)
    a_rhythm = max(s["bus_activation"]["rhythm"] for s in ambient["sections"])
    m_rhythm = max(s["bus_activation"]["rhythm"] for s in metal["sections"])
    assert a_rhythm < m_rhythm


def test_section_role_normalisation():
    assert normalise_section_role("verse_2") == "verse"
    assert normalise_section_role("drop_chorus") == "drop"
    assert normalise_section_role("Pre-Chorus") == "pre_chorus"
    assert normalise_section_role("hook") == "chorus"
    assert normalise_section_role("ending") == "outro"


# --------------------------------------------------------------------------
# blueprint integration
# --------------------------------------------------------------------------


def _base_blueprint() -> dict:
    return {
        "track_metadata": {
            "title": "t",
            "bpm": 140,
            "root_key": "D",
            "genre": "rap_rock",
            "total_bars": 32,
        },
        "sections": [
            {
                "name": "intro",
                "slice_count": 4,
                "energy": 0.3,
                "volume_weights": {"rhythm": 0.3, "harmonic": 0.7, "lead": 0.2, "vocal": 0.0},
                "query_tags": {"rhythm": ["drums"], "harmonic": [], "lead": [], "vocal": []},
                "dsp_filters": {"lowpass_hz": 4000, "reverb_send": 0.4, "saturation_drive": 0.1},
            },
            {
                "name": "chorus",
                "slice_count": 8,
                "energy": 0.9,
                "volume_weights": {"rhythm": 0.9, "harmonic": 0.8, "lead": 0.8, "vocal": 0.6},
                "query_tags": {"rhythm": ["heavy"], "harmonic": [], "lead": [], "vocal": ["vocal"]},
                "dsp_filters": {"lowpass_hz": 20000, "reverb_send": 0.15, "saturation_drive": 0.4},
            },
        ],
    }


def test_arrangement_survives_blueprint_validation():
    plan = _plan(31)
    blueprint = apply_arrangement_to_blueprint(_base_blueprint(), plan)
    validated = validate_blueprint(blueprint, enforce_section_span=False)
    assert len(validated["sections"]) == len(plan["sections"])
    for original, section in zip(plan["sections"], validated["sections"]):
        assert section["bars"] == original["bars"]
        assert section["bus_activation"] == pytest.approx(original["bus_activation"])
        assert section["bus_variant"] == original["bus_variant"]
    assert validated["arrangement"]["seed"] == plan["seed"]


def test_apply_arrangement_carries_query_tags_forward():
    plan = _plan(32)
    blueprint = apply_arrangement_to_blueprint(_base_blueprint(), plan)
    tagged = [s for s in blueprint["sections"] if s["query_tags"]]
    assert tagged


def test_describe_arrangement_lists_every_section():
    plan = _plan(5)
    text = describe_arrangement(plan)
    for section in plan["sections"]:
        assert section["name"] in text
