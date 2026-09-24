"""Executive genre planner — arrangement authority over the picker."""
from __future__ import annotations

import os
import sys

import numpy as np

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.genre_planner import (  # noqa: E402
    GENRE_BLUEPRINTS,
    dsp_rules_from_section,
    genre_from_plan,
    get_arrangement_blueprint,
    get_section_blueprint,
    rules_for_bar,
    rules_for_named_section,
)


def test_blueprint_scales_to_total_bars_and_covers_hit_roles():
    plan = get_arrangement_blueprint("rap", 64)
    assert plan["authority"] == "genre_planner"
    assert plan["family"] == "hiphop_rnb"
    assert plan["style"] == "subtractive"
    assert plan["total_bars"] == 64
    assert sum(int(s["bars"]) for s in plan["sections"]) == 64
    roles = {s["role"] for s in plan["sections"]}
    assert "intro" in roles
    assert "verse" in roles or "chorus" in roles


def test_section_blueprint_uses_name_not_global_clock():
    intro = get_section_blueprint("cyberpunk_darksynth", "intro_1")
    verse = get_section_blueprint("cyberpunk_darksynth", "verse_2")
    chorus = get_section_blueprint("cyberpunk_darksynth", "chorus_final")
    assert intro["drums_muted"] is True
    assert intro["bass_muted"] is True
    assert intro["stereo_width"] == 0.8
    assert verse["bass_muted"] is True
    assert verse["stereo_width"] == 1.0
    assert chorus["stereo_width"] == 1.3


def test_genre_from_plan_reads_core_metadata():
    assert genre_from_plan({"core_metadata": {"genre": "cyberpunk_darksynth"}}) == "cyberpunk_darksynth"
    assert genre_from_plan({"source_genres": [{"slug": "electroswing"}]}) == "electroswing"


def test_unmapped_genre_falls_back_to_electroswing():
    verse = get_section_blueprint("pop", "verse_2")
    assert verse["genre"] == "electroswing"
    assert verse["drums_muted"] is False
    assert verse["bass_muted"] is False
    assert verse["sidechain_pump"] == 0.2


def test_cyberpunk_darksynth_maps_neon_intro_to_adrenalized_chorus():
    intro = get_section_blueprint("Cyberpunk / Darksynth", "intro")
    verse = get_section_blueprint("cyberpunkdarks", "verse_2")
    pre = get_section_blueprint("darksynth", "pre_chorus")
    chorus = get_section_blueprint("darksynth", "chorus_1")
    assert intro["drums_muted"] is True
    assert intro["bass_muted"] is True
    assert intro["sidechain_pump"] == 0.0
    assert intro["lowpass_freq"] == 800.0
    assert intro["stereo_width"] == 0.8
    assert GENRE_BLUEPRINTS["cyberpunk_darksynth"]["verse_1"]["sidechain_pump"] == 0.4
    assert verse["drums_muted"] is False
    assert verse["bass_muted"] is True
    assert verse["sidechain_pump"] == 0.4
    assert verse["lowpass_freq"] == 2000.0
    assert pre["sidechain_pump"] == 0.7
    assert pre["lowpass_freq"] == 5000.0
    assert chorus["sidechain_pump"] == 1.0
    assert chorus["lowpass_freq"] is None
    assert chorus["stereo_width"] == 1.3
    assert chorus["drums_active"] is True
    assert chorus["bass_active"] is True


def test_electroswing_maps_speakeasy_intro_to_roaring_chorus():
    intro = get_section_blueprint("electro swing", "intro_1")
    verse = get_section_blueprint("electroswing", "verse_2")
    pre = get_section_blueprint("Electroswing", "pre_chorus")
    chorus = get_section_blueprint("electroswing", "chorus_final")
    assert intro["drums_muted"] is True
    assert intro["bass_muted"] is False
    assert intro["lowpass_freq"] == 1000.0
    assert intro["stereo_width"] == 0.5
    assert intro["sidechain_pump"] == 0.0
    assert verse["drums_muted"] is False
    assert verse["lowpass_freq"] is None
    assert pre["drums_muted"] is True
    assert pre["role"] == "pre_chorus"
    assert chorus["sidechain_pump"] == 0.5
    assert chorus["stereo_width"] == 1.25


def test_rap_and_rock_use_electroswing_until_mapped():
    verse = rules_for_named_section("trap", "verse_1")
    chorus = rules_for_named_section("trap", "chorus")
    assert verse["genre"] == "electroswing"
    assert verse["bass_active"] is True
    assert chorus["stereo_width"] == 1.25

    rock_chorus = rules_for_named_section("heavy rock", "chorus")
    rock_bridge = rules_for_named_section("heavy rock", "bridge")
    assert rock_chorus["stereo_width"] == 1.25
    assert rock_bridge["bass_muted"] is True
    assert rock_bridge["drums_muted"] is False


def test_bar_lookup_follows_scaled_layout():
    plan = get_arrangement_blueprint("pop", 40)
    first = rules_for_bar(plan, 0)
    last = rules_for_bar(plan, 39)
    assert first["role"] == "intro"
    assert last["role"] == "outro"
    assert dsp_rules_from_section(first)["drums_active"] is False


def test_planner_dsp_drops_bridge_rhythm_and_widens_chorus():
    from engine.genre_planner import apply_executive_mix

    sr = 8000
    n = 2000
    t = np.arange(n) / sr
    dry = {
        "rhythm": np.column_stack([0.4 * np.sin(2 * np.pi * 80.0 * t)] * 2),
        "bass": 0.4 * np.sin(2 * np.pi * 55.0 * t),
        "harmonic": np.column_stack(
            (0.3 * np.sin(2 * np.pi * 440.0 * t), 0.3 * np.sin(2 * np.pi * 554.0 * t))
        ),
        "lead": np.column_stack([0.2 * np.sin(2 * np.pi * 880.0 * t)] * 2),
    }
    bridge = apply_executive_mix(dry, get_section_blueprint("cyberpunk_darksynth", "bridge"), sr, 120.0)
    assert float(np.max(np.abs(bridge["rhythm"]))) == 0.0
    assert float(np.max(np.abs(bridge["bass"]))) > 0.0

    chorus = apply_executive_mix(dry, get_section_blueprint("cyberpunk_darksynth", "chorus_1"), sr, 120.0)
    mid = (chorus["harmonic"][:, 0] + chorus["harmonic"][:, 1]) * 0.5
    side = (chorus["harmonic"][:, 0] - chorus["harmonic"][:, 1]) * 0.5
    dry_side = (dry["harmonic"][:, 0] - dry["harmonic"][:, 1]) * 0.5
    assert float(np.sqrt(np.mean(side**2))) > float(np.sqrt(np.mean(dry_side**2)))
    assert float(np.sqrt(np.mean(mid**2))) > 0.0
