"""Generated lanes become local wavs and land on the bars Gemini asked for."""

import io
import threading

import numpy as np
import soundfile as sf

from engine.preflight_generator import mix_generated_lanes, resolve_blueprint_dependencies
from engine.blueprint_track_assembler import samples_per_bar


def test_resolve_points_a_generate_lane_at_the_downloaded_wav(tmp_path, monkeypatch):
    dest = tmp_path / "gen.wav"
    sf.write(dest, np.ones((16, 1), dtype=np.float64), 1000)

    def fake(prompt, is_vocal, dest_dir=None, duration_sec=None):
        assert not is_vocal
        assert "guitar" in prompt
        return str(dest)

    monkeypatch.setattr("engine.preflight_generator.generate_audio_via_replicate", fake)
    monkeypatch.setattr("engine.preflight_generator._fit_to_bars", lambda *args, **kwargs: None)
    plan = {
        "structure": [
            {
                "lane_assignments": {
                    "10_lead_inst": {
                        "source": "generate",
                        "prompt": "guitar solo",
                        "stem_id": "",
                        "active_bars": [1, 2, 3, 4],
                    },
                    "11_lead_vocal": {
                        "source": "generate",
                        "lyrics": "whiskey line",
                        "active_bars": [1, 2, 3, 4],
                    },
                }
            }
        ]
    }
    resolved = resolve_blueprint_dependencies(plan, str(tmp_path), bpm=120, sr=1000)
    lanes = resolved["structure"][0]["lane_assignments"]
    assert "11_lead_vocal" not in lanes
    lead = lanes["10_lead_inst"]
    assert lead["source"] == "catalog"
    assert lead["path"] == str(dest)
    assert lead["stem_id"] == "gen"


def test_distinct_stems_are_requested_together(tmp_path, monkeypatch):
    gate = threading.Barrier(2)

    def fake(prompt, is_vocal, dest_dir=None, duration_sec=None):
        gate.wait(timeout=2)
        name = "lead" if "guitar" in prompt else "riser"
        path = tmp_path / f"{name}.wav"
        sf.write(path, np.ones((8, 1), dtype=np.float64), 1000)
        return str(path)

    monkeypatch.setattr("engine.preflight_generator.generate_audio_via_replicate", fake)
    monkeypatch.setattr("engine.preflight_generator._fit_to_bars", lambda *args, **kwargs: None)
    plan = {
        "structure": [
            {
                "lane_assignments": {
                    "10_lead_inst": {
                        "source": "generate",
                        "prompt": "guitar solo",
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
    assert lanes["10_lead_inst"]["path"].endswith("lead.wav")
    assert lanes["13_transitions_fx"]["path"].endswith("riser.wav")


def test_bar_fits_run_together(tmp_path, monkeypatch):
    gate = threading.Barrier(2)
    lead = tmp_path / "lead.wav"
    riser = tmp_path / "riser.wav"
    sf.write(lead, np.ones((8, 1), dtype=np.float64), 1000)
    sf.write(riser, np.ones((8, 1), dtype=np.float64), 1000)

    def fake(prompt, is_vocal, dest_dir=None, duration_sec=None):
        return str(lead if "guitar" in prompt else riser)

    def fitted(path, sr, bpm, bars, mono=False):
        gate.wait(timeout=2)

    monkeypatch.setattr("engine.preflight_generator.generate_audio_via_replicate", fake)
    monkeypatch.setattr("engine.preflight_generator._fit_to_bars", fitted)
    plan = {
        "structure": [
            {
                "lane_assignments": {
                    "10_lead_inst": {
                        "source": "generate",
                        "prompt": "guitar solo",
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
    lead = tmp_path / "lead.wav"
    sf.write(lead, np.ones((8, 1), dtype=np.float64), 1000)

    def fake(prompt, is_vocal, dest_dir=None, duration_sec=None):
        if "riser" in prompt:
            raise RuntimeError("musicgen down")
        return str(lead)

    monkeypatch.setattr("engine.preflight_generator.generate_audio_via_replicate", fake)
    monkeypatch.setattr("engine.preflight_generator._fit_to_bars", lambda *args, **kwargs: None)
    plan = {
        "structure": [
            {
                "lane_assignments": {
                    "10_lead_inst": {
                        "source": "generate",
                        "prompt": "guitar solo",
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
    assert lanes["10_lead_inst"]["path"] == str(lead)
    assert lanes["10_lead_inst"]["stem_id"] == "lead"
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


def test_bark_wav_is_decoded_and_resampled_off_24k():
    from engine.preflight_generator import load_and_resample_generated_wav

    native = 24000
    tone = (0.25 * np.sin(np.linspace(0.0, 40.0, native, dtype=np.float64))).astype(np.float32)
    buf = io.BytesIO()
    sf.write(buf, tone, native, format="WAV", subtype="PCM_16")
    raw = buf.getvalue()
    assert raw[:4] == b"RIFF"
    audio = load_and_resample_generated_wav(raw, target_sr=48000)
    assert audio.ndim == 1
    assert abs(int(audio.shape[0]) - 48000) < 80
    assert float(np.max(np.abs(audio[:64]))) < 1.0


def test_lame_padding_is_removed_and_a_real_attack_is_kept():
    from engine.preflight_generator import _drop_mp3_padding, _lame_delay_and_pad

    tag = bytearray(36)
    tag[0:4] = b"LAME"
    delay, padding = 4, 2
    tag[17] = (delay >> 4) & 0xFF
    tag[18] = ((delay & 0x0F) << 4) | ((padding >> 8) & 0x0F)
    tag[19] = padding & 0xFF
    raw = b"Xing" + (0).to_bytes(4, "big") + bytes(tag)
    assert _lame_delay_and_pad(raw) == (4, 2)
    silent = np.array([0.0, 0.0, 0.0, 0.0, 0.4, 0.4, 0.0, 0.0], dtype=np.float32)
    trimmed = _drop_mp3_padding(silent, raw, 44100)
    assert np.allclose(trimmed, [0.4, 0.4])
    attack = np.full(8, 0.4, dtype=np.float32)
    assert np.allclose(_drop_mp3_padding(attack, raw, 44100), attack)
