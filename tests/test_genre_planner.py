"""Executive genre planner — arrangement authority over the picker."""
from __future__ import annotations

import os
import sys

import numpy as np

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.genre_planner import (  # noqa: E402
    dsp_rules_from_section,
    get_arrangement_blueprint,
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


def test_rap_verse_mutes_kick_and_chorus_drops_808():
    verse = rules_for_named_section("trap", "verse_1")
    assert verse["kick_muted"] is True
    assert verse["bass_active"] is True
    chorus = rules_for_named_section("trap", "chorus")
    assert chorus["kick_muted"] is False
    assert chorus["bass_active"] is True
    assert chorus["stereo_width"] >= 1.1


def test_rock_verse_is_tight_chorus_is_wide_bridge_breaks_down():
    verse = rules_for_named_section("heavy rock", "verse")
    chorus = rules_for_named_section("heavy rock", "chorus")
    bridge = rules_for_named_section("heavy rock", "bridge")
    assert verse["stereo_width"] < chorus["stereo_width"]
    assert chorus["stereo_width"] >= 1.2
    assert bridge["breakdown"] is True
    assert bridge["drums_active"] is False
    assert bridge["bass_active"] is False


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
    bridge = apply_executive_mix(dry, rules_for_named_section("rock", "bridge"), sr, 120.0)
    assert float(np.max(np.abs(bridge["rhythm"]))) == 0.0
    assert float(np.max(np.abs(bridge["bass"]))) == 0.0

    chorus = apply_executive_mix(dry, rules_for_named_section("rock", "chorus"), sr, 120.0)
    mid = (chorus["harmonic"][:, 0] + chorus["harmonic"][:, 1]) * 0.5
    side = (chorus["harmonic"][:, 0] - chorus["harmonic"][:, 1]) * 0.5
    dry_side = (dry["harmonic"][:, 0] - dry["harmonic"][:, 1]) * 0.5
    assert float(np.sqrt(np.mean(side**2))) > float(np.sqrt(np.mean(dry_side**2)))
    assert float(np.sqrt(np.mean(mid**2))) > 0.0
