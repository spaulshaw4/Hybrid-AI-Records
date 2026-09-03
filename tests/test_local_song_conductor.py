"""Seed reproducibility and Intro→Verse→Build→Drop section variation."""
from __future__ import annotations

import os
import sys

import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.genre_arrangement_profiles import BUSES  # noqa: E402
from engine.local_song_conductor import (  # noqa: E402
    CONDUCTOR_NAME,
    INDEX_HONESTY,
    REQUIRED_ROLES,
    SKELETON_NAME,
    apply_conducted_blueprint,
    conduct_arrangement,
    conduct_profile,
    conduct_signature,
    derive_seed,
    describe_conducted,
)

PROMPT = "Heavy modern rap-rock groove with punchy drums, distorted sub bass, and clean dry vocal chops"


def _plan(seed: int, genre: str | None = "rap_rock", bpm: float = 140.0, duration: float = 60.0):
    return conduct_arrangement(PROMPT, genre, bpm, duration, seed=seed)


def test_same_seed_reproduces_the_identical_section_map():
    assert conduct_signature(_plan(1234)) == conduct_signature(_plan(1234))


def test_different_seeds_change_the_section_map():
    signatures = {conduct_signature(_plan(seed)) for seed in range(40)}
    assert len(signatures) >= 15


def test_different_seeds_change_bus_activation_numbers():
    a = _plan(7)
    b = _plan(8)
    act_a = [tuple(s["bus_activation"][bus] for bus in BUSES) for s in a["sections"]]
    act_b = [tuple(s["bus_activation"][bus] for bus in BUSES) for s in b["sections"]]
    assert act_a != act_b


def test_seed_is_recorded_and_conductor_is_named():
    plan = _plan(999)
    assert plan["seed"] == 999
    assert plan["conductor"] == CONDUCTOR_NAME
    assert plan["skeleton"] == SKELETON_NAME
    assert "no bass" in plan["index_honesty"]


def test_sixty_seconds_at_140_bpm_is_intro_verse_build_drop():
    plan = _plan(3, duration=60.0)
    roles = [s["role"] for s in plan["sections"] if not s.get("predrop")]
    for role in REQUIRED_ROLES:
        assert role in roles, f"missing {role} in {roles}"
    assert roles.index("intro") < roles.index("verse")
    assert roles.index("verse") < roles.index("build")
    assert roles.index("build") < roles.index("drop")


def test_bus_activation_differs_across_sections():
    for seed in range(20):
        plan = _plan(seed)
        maps = {
            tuple(s["bus_activation"][bus] for bus in BUSES) for s in plan["sections"]
        }
        assert len(maps) >= 4, "sections collapsed onto one activation map"


def test_drop_is_denser_than_intro():
    for seed in range(20):
        plan = _plan(seed)
        intro = next(s for s in plan["sections"] if s["role"] == "intro")
        drops = [s for s in plan["sections"] if s["role"] == "drop"]
        assert drops
        intro_sum = sum(intro["bus_activation"].values())
        assert max(sum(d["bus_activation"].values()) for d in drops) > intro_sum


def test_activation_stays_in_unit_range():
    for seed in range(15):
        for section in _plan(seed)["sections"]:
            for bus in BUSES:
                assert 0.0 <= section["bus_activation"][bus] <= 1.0


def test_genre_matrix_changes_energy_not_the_ivbd_roles():
    techno = _plan(555, genre="techno")
    ambient = _plan(555, genre="ambient")
    core = lambda plan: tuple(s["role"] for s in plan["sections"] if not s.get("predrop"))
    for plan in (techno, ambient):
        roles = core(plan)
        for role in REQUIRED_ROLES:
            assert role in roles
    assert conduct_signature(techno) != conduct_signature(ambient)


def test_documented_defaults_when_matrix_is_empty(monkeypatch):
    import engine.local_song_conductor as conductor

    monkeypatch.setattr(conductor, "load_dsp_matrix", lambda: {})
    profile = conductor.conduct_profile("techno")
    assert profile["family"] == "conductor_default"
    assert profile["mastering_source"] == "documented_defaults"
    assert profile["energy_gamma"] == pytest.approx(0.90)
    assert profile["bus_target_rms_dbfs"]["bass"] == pytest.approx(-15.5)


def test_matrix_profile_keeps_ivbd_archetypes():
    profile = conduct_profile("techno")
    roles = [step[0] for step in profile["archetypes"][0]]
    assert roles[:4] == ["intro", "verse", "build", "drop"]


def test_derive_seed_explicit_wins():
    a, _ = derive_seed(PROMPT, "user-a", explicit_seed=4242)
    b, _ = derive_seed(PROMPT, "user-b", explicit_seed=4242)
    assert a == b == 4242


def test_describe_lists_every_section_and_honesty():
    plan = _plan(5)
    text = describe_conducted(plan)
    for section in plan["sections"]:
        assert section["name"] in text
    assert "pitch class" in text or "no bass" in text
    assert INDEX_HONESTY.split(".")[0] in text or "no bass" in text


def test_conducted_blueprint_keeps_bus_maps():
    plan = _plan(31)
    blueprint = {
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
                "query_tags": {},
                "dsp_filters": {},
            }
        ],
    }
    out = apply_conducted_blueprint(blueprint, plan)
    assert out["arrangement"]["conductor"] == CONDUCTOR_NAME
    assert out["arrangement"]["skeleton"] == SKELETON_NAME
    assert len(out["sections"]) == len(plan["sections"])
    for original, section in zip(plan["sections"], out["sections"]):
        assert section["bus_activation"] == original["bus_activation"]
        assert section["bars"] == original["bars"]
