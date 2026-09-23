"""GlobalSongPlan schema, serialization, and seed reproducibility."""
from __future__ import annotations

import os
import sys

import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.song_plan import (  # noqa: E402
    GlobalSongPlan,
    GenreVector,
    MixIntents,
    SectionPlan,
    build_song_plan,
    parse_key_scale,
    section_retrieval_constraints,
    song_plan_from_dict,
    song_plan_to_dict,
)


def test_parse_key_scale_variants():
    assert parse_key_scale("E_minor") == ("E", "minor")
    assert parse_key_scale("Em") == ("E", "minor")
    assert parse_key_scale("C major") == ("C", "major")
    assert parse_key_scale("F#")[0] == "F#"


def test_build_song_plan_core_metadata_and_structure():
    plan = build_song_plan(
        "Outlaw Country rock anthem",
        "country",
        seed=42,
        request_id="req-1",
        bpm=120,
        key="E_minor",
    )
    assert isinstance(plan, GlobalSongPlan)
    assert plan.bpm == 120
    assert plan.key == "E"
    assert plan.scale == "minor"
    assert plan.time_signature == "4/4"
    assert plan.core_metadata["key"] == "E_minor"
    assert plan.structural_array
    assert len(plan.energy_arc) == len(plan.sections)
    assert plan.total_bars == sum(s.bars for s in plan.sections)
    assert len(plan.harmonic_roadmap) == plan.total_bars
    for section in plan.sections:
        assert 0.0 <= section.energy_level <= 1.0
        assert section.chord_progression
        assert section.active_stems


def test_genre_vector_frozen():
    vec = GenreVector(harmonic_complexity=0.2, spectral_aggression=0.9)
    with pytest.raises(Exception):
        vec.harmonic_complexity = 0.8  # type: ignore[misc]


def test_song_plan_round_trip():
    plan = build_song_plan("ambient drone", "ambient", seed=7, bpm=90, key="A_minor")
    data = song_plan_to_dict(plan)
    restored = song_plan_from_dict(data)
    assert restored.model_dump() == plan.model_dump()


def test_same_seed_same_plan_without_arrangement():
    a = build_song_plan("rap rock groove", "rap_rock", seed=99, bpm=140)
    b = build_song_plan("rap rock groove", "rap_rock", seed=99, bpm=140)
    assert song_plan_to_dict(a) == song_plan_to_dict(b)


def test_aligns_to_arrangement_section_bars():
    arrangement_sections = [
        {"name": "intro", "role": "intro", "bars": 4, "energy": 0.2, "bus_activation": {"rhythm": 0.5, "bass": 0.0, "harmonic": 0.8, "vocal": 0.0}},
        {"name": "verse", "role": "verse", "bars": 8, "energy": 0.5, "bus_activation": {"rhythm": 0.8, "bass": 0.7, "harmonic": 0.6, "vocal": 0.7}},
        {"name": "drop", "role": "drop", "bars": 16, "energy": 1.0, "bus_activation": {"rhythm": 1.0, "bass": 1.0, "harmonic": 0.7, "vocal": 0.4}},
    ]
    plan = build_song_plan(
        "techno",
        "techno",
        seed=1,
        bpm=128,
        key="A_minor",
        arrangement_sections=arrangement_sections,
    )
    assert [s.bars for s in plan.sections] == [4, 8, 16]
    assert plan.total_bars == 28
    assert plan.structural_array == ["intro", "verse", "drop"]
    assert plan.sections[0].energy_level == pytest.approx(0.2)


def test_mix_intents_present_for_module_2():
    plan = build_song_plan("heavy metal", "metal", seed=3, bpm=160, key="D_minor")
    assert isinstance(plan.mix_intents, MixIntents)
    assert 0.0 <= plan.mix_intents.sidechain_kick_bass <= 1.0
    assert plan.mix_intents.shared_reverb_bus >= 0.10


def test_section_retrieval_constraints():
    plan = build_song_plan("pop hook", "pop", seed=5, bpm=100, key="C_major")
    section = plan.sections[0]
    constr = section_retrieval_constraints(section, plan)
    assert constr["bpm"] == plan.bpm
    assert constr["key"] == plan.key
    assert "energy_level" in constr
    assert constr["root_chord"]


def test_section_plan_model():
    section = SectionPlan(
        name="chorus_1",
        start_bar=12,
        bars=8,
        energy_level=0.9,
        chord_progression=["Em", "C", "G", "D"],
        active_stems=["drums", "bass", "lead_vocal"],
        frequency_reservations={"lead_vocal": "1kHz-3kHz"},
    )
    assert section.name == "chorus_1"
