"""Generated lanes become local wavs and land on the bars Gemini asked for."""

import threading

import numpy as np
import soundfile as sf

from engine.preflight_generator import mix_generated_lanes, resolve_blueprint_dependencies
from engine.blueprint_track_assembler import samples_per_bar


def test_resolve_points_a_generate_lane_at_the_downloaded_wav(tmp_path, monkeypatch):
    dest = tmp_path / "gen.wav"
    sf.write(dest, np.ones((16, 1), dtype=np.float64), 1000)

    def fake(prompt, is_vocal, dest_dir=None, duration_sec=None):
        assert is_vocal
        assert "whiskey" in prompt
        return str(dest)

    monkeypatch.setattr("engine.preflight_generator.generate_audio_via_replicate", fake)
    monkeypatch.setattr("engine.preflight_generator._fit_to_bars", lambda *args, **kwargs: None)
    plan = {
        "structure": [
            {
                "lane_assignments": {
                    "11_lead_vocal": {
                        "source": "generate",
                        "lyrics": "whiskey line",
                        "stem_id": "",
                        "active_bars": [1, 2, 3, 4],
                    }
                }
            }
        ]
    }
    resolved = resolve_blueprint_dependencies(plan, str(tmp_path), bpm=120, sr=1000)
    vocal = resolved["structure"][0]["lane_assignments"]["11_lead_vocal"]
    assert vocal["source"] == "catalog"
    assert vocal["path"] == str(dest)
    assert vocal["stem_id"] == "gen"


def test_distinct_stems_are_requested_together(tmp_path, monkeypatch):
    gate = threading.Barrier(2)

    def fake(prompt, is_vocal, dest_dir=None, duration_sec=None):
        gate.wait(timeout=2)
        path = tmp_path / f"{'vocal' if is_vocal else 'riser'}.wav"
        sf.write(path, np.ones((8, 1), dtype=np.float64), 1000)
        return str(path)

    monkeypatch.setattr("engine.preflight_generator.generate_audio_via_replicate", fake)
    monkeypatch.setattr("engine.preflight_generator._fit_to_bars", lambda *args, **kwargs: None)
    plan = {
        "structure": [
            {
                "lane_assignments": {
                    "11_lead_vocal": {
                        "source": "generate",
                        "lyrics": "vocal line",
                        "active_bars": [1, 2],
                    },
                    "13_transitions_fx": {
                        "source": "generate",
                        "prompt": "riser",
                        "active_bars": [3, 4],
                    },
                }
            }
        ]
    }
    resolved = resolve_blueprint_dependencies(plan, str(tmp_path), bpm=120, sr=1000)
    lanes = resolved["structure"][0]["lane_assignments"]
    assert lanes["11_lead_vocal"]["path"].endswith("vocal.wav")
    assert lanes["13_transitions_fx"]["path"].endswith("riser.wav")


def test_bar_fits_run_together(tmp_path, monkeypatch):
    gate = threading.Barrier(2)
    vocal = tmp_path / "vocal.wav"
    riser = tmp_path / "riser.wav"
    sf.write(vocal, np.ones((8, 1), dtype=np.float64), 1000)
    sf.write(riser, np.ones((8, 1), dtype=np.float64), 1000)

    def fake(prompt, is_vocal, dest_dir=None, duration_sec=None):
        return str(vocal if is_vocal else riser)

    def fitted(path, sr, bpm, bars):
        gate.wait(timeout=2)

    monkeypatch.setattr("engine.preflight_generator.generate_audio_via_replicate", fake)
    monkeypatch.setattr("engine.preflight_generator._fit_to_bars", fitted)
    plan = {
        "structure": [
            {
                "lane_assignments": {
                    "11_lead_vocal": {
                        "source": "generate",
                        "lyrics": "vocal line",
                        "active_bars": [1, 2],
                    },
                    "13_transitions_fx": {
                        "source": "generate",
                        "prompt": "riser",
                        "active_bars": [3, 4],
                    },
                }
            }
        ]
    }
    resolved = resolve_blueprint_dependencies(plan, str(tmp_path), bpm=120, sr=1000)
    assert resolved["structure"][0]["lane_assignments"]["13_transitions_fx"]["path"] == str(riser)


def test_one_failed_stem_keeps_the_other(tmp_path, monkeypatch):
    vocal = tmp_path / "vocal.wav"
    sf.write(vocal, np.ones((8, 1), dtype=np.float64), 1000)

    def fake(prompt, is_vocal, dest_dir=None, duration_sec=None):
        if not is_vocal:
            raise RuntimeError("musicgen down")
        return str(vocal)

    monkeypatch.setattr("engine.preflight_generator.generate_audio_via_replicate", fake)
    monkeypatch.setattr("engine.preflight_generator._fit_to_bars", lambda *args, **kwargs: None)
    plan = {
        "structure": [
            {
                "lane_assignments": {
                    "11_lead_vocal": {
                        "source": "generate",
                        "lyrics": "vocal line",
                        "active_bars": [1, 2],
                    },
                    "13_transitions_fx": {
                        "source": "generate",
                        "prompt": "riser",
                        "active_bars": [3, 4],
                    },
                }
            }
        ]
    }
    resolved = resolve_blueprint_dependencies(plan, str(tmp_path), bpm=120, sr=1000)
    lanes = resolved["structure"][0]["lane_assignments"]
    assert lanes["11_lead_vocal"]["path"] == str(vocal)
    assert lanes["11_lead_vocal"]["stem_id"] == "vocal"
    assert "13_transitions_fx" not in lanes


def test_a_failed_generation_drops_that_lane(monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("no token")

    monkeypatch.setattr("engine.preflight_generator.generate_audio_via_replicate", boom)
    plan = {
        "structure": [
            {
                "lane_assignments": {
                    "13_transitions_fx": {
                        "source": "generate",
                        "prompt": "riser",
                        "active_bars": [1],
                    }
                }
            }
        ]
    }
    resolved = resolve_blueprint_dependencies(plan, bpm=86, sr=44100)
    assert resolved["structure"][0]["lane_assignments"] == {}


def test_generated_audio_is_placed_on_the_requested_bars(tmp_path):
    sr = 1000
    bpm = 240.0
    bar = samples_per_bar(sr, bpm)
    tone = np.full((bar, 1), 0.5, dtype=np.float64)
    path = tmp_path / "gen_vocal.wav"
    sf.write(path, tone, sr)
    arrangement = {
        "structure": [
            {
                "lane_assignments": {
                    "11_lead_vocal": {
                        "path": str(path),
                        "active_bars": [1],
                    }
                }
            }
        ]
    }
    lanes = mix_generated_lanes(arrangement, [bar * 4], sr, bpm, 1, bar * 4)
    vocal = lanes["11_lead_vocal"][:, 0]
    assert np.max(np.abs(vocal[:bar] - 0.5)) < 1e-6
    assert float(np.max(np.abs(vocal[bar:]))) == 0.0
