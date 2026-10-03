"""Gemini writes the arrangement. Python places the samples."""

import os

import numpy as np

from engine.arrangement_planner import (
    bar_start_sample,
    generate_arrangement_plan_with_gemini,
    place_stem_on_bars,
    strip_preroll,
    validate_arrangement_plan,
)
from engine.blueprint_track_assembler import samples_per_bar


def test_unknown_stems_are_dropped_and_the_lead_stays_out_of_the_vocal():
    catalog = [
        {"stem_id": "vx_a", "lane": "11_lead_vocal", "bars": 2},
        {"stem_id": "gt_lick", "lane": "10_lead_inst", "bars": 2},
    ]
    raw = {
        "song_id": "outlaw_whiskey_01",
        "structure": [
            {
                "section": "verse_1",
                "start_bar": 1,
                "end_bar": 8,
                "lane_assignments": {
                    "11_lead_vocal": {"stem_id": "vx_a", "active_bars": [1, 2, 3, 4, 5, 6]},
                    "10_lead_fills": {"stem_id": "gt_lick", "active_bars": [1, 2, 7, 8]},
                    "01_kick": "not_in_catalog",
                },
            }
        ],
    }
    plan = validate_arrangement_plan(
        raw,
        catalog,
        bpm=86,
        key="G_minor",
        genre="outlaw country",
        sections=[{"name": "verse_1", "bars": 8}],
    )
    lanes = plan["structure"][0]["lane_assignments"]
    assert lanes["11_lead_vocal"]["active_bars"] == [1, 2]
    assert lanes["10_lead_inst"]["active_bars"] == [7, 8]
    assert "01_kick" not in lanes
    assert plan["bpm"] == 86.0
    assert plan["key"] == "G_minor"


def test_gemini_receives_metadata_not_samples(monkeypatch):
    seen = {}

    def fake(system, user, timeout=25.0):
        seen["user"] = user
        return {
            "structure": [
                {
                    "lane_assignments": {
                        "11_lead_vocal": {"stem_id": "vx_a", "active_bars": [1, 2]},
                    }
                }
            ]
        }

    monkeypatch.setattr("engine.gemini_arranger.complete_json", fake)
    plan = generate_arrangement_plan_with_gemini(
        "outlaw country",
        [{"stem_id": "vx_a", "lane": "11_lead_vocal", "bars": 2}],
        86.0,
        "G_minor",
        sections=[{"name": "verse_1", "bars": 8}],
    )
    assert "vx_a" in seen["user"]
    assert "48000" not in seen["user"]
    assert os.path.sep not in seen["user"]
    assert plan["structure"][0]["lane_assignments"]["11_lead_vocal"]["stem_id"] == "vx_a"


def test_arrangement_posts_to_replicate_with_the_lyric_key(monkeypatch):
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("LYRIC_ENGINE_API_KEY", "r8_lyric")
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_hybrid")
    monkeypatch.setenv("GEMINI_API_KEY", "google-native")
    seen = {}

    def fake_http(url, token, payload, timeout=120.0):
        seen["url"] = url
        seen["token"] = token
        return {
            "id": "pred",
            "status": "succeeded",
            "output": (
                '{"structure":[{"lane_assignments":{"11_lead_vocal":'
                '{"stem_id":"vx_a","active_bars":[1,2]}}}]}'
            ),
        }

    monkeypatch.setattr("engine.gemini_arranger._http_json", fake_http)
    plan = generate_arrangement_plan_with_gemini(
        "outlaw country",
        [{"stem_id": "vx_a", "lane": "11_lead_vocal", "bars": 2}],
        86.0,
        "G_minor",
        sections=[{"name": "verse_1", "bars": 8}],
    )
    assert seen["token"] == "r8_lyric"
    assert "api.replicate.com" in seen["url"]
    assert "generativelanguage" not in seen["url"]
    assert plan["structure"][0]["lane_assignments"]["11_lead_vocal"]["stem_id"] == "vx_a"


def test_hybrid_replicate_token_is_refused_for_gemini(monkeypatch):
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("LYRIC_ENGINE_API_KEY", "r8_same")
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_same")
    monkeypatch.delenv("ENGINE_API_KEY", raising=False)
    import pytest
    from engine.gemini_arranger import complete_json

    with pytest.raises(RuntimeError, match="LYRIC_ENGINE_API_KEY"):
        complete_json("system", "user")


def test_preroll_moves_the_attack_to_sample_zero():
    sr = 1000
    audio = np.zeros(200, dtype=np.float64)
    audio[40:] = 0.5
    trimmed = strip_preroll(audio, sr, window_ms=100)
    assert trimmed.shape[0] == 160
    assert float(trimmed[0]) == 0.5


def test_each_active_run_retriggers_the_head_of_the_stem():
    sr = 1000
    bpm = 240.0
    bar = samples_per_bar(sr, bpm)
    stem = np.linspace(0.2, 0.9, bar // 2, dtype=np.float64)
    placed = place_stem_on_bars(stem, sr, bpm, [1, 5], total_samples=8 * bar)
    rendered = placed[:, 0]
    assert np.max(np.abs(rendered[: stem.shape[0]] - stem)) < 1e-6
    assert float(np.max(np.abs(rendered[stem.shape[0] : bar]))) == 0.0
    second = bar_start_sample(5, bpm, sr)
    assert np.max(np.abs(rendered[second : second + stem.shape[0]] - stem)) < 1e-6
    assert float(np.max(np.abs(rendered[bar : second]))) == 0.0
