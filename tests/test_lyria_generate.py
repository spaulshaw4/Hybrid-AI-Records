"""Lyria 3 Pro generate path. HTTP is mocked; nothing is sent to Replicate."""
from __future__ import annotations

import io
import json
import os
import sys
import urllib.request

import numpy as np
import pytest
import soundfile as sf

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.gemini_arranger import lyric_replicate_token  # noqa: E402
from engine.generate_track_headless import (  # noqa: E402
    LYRIA_POLL_SEC,
    LYRIA_PREDICTIONS_URL,
    compose_lyria_prompt,
    lyria_output_url,
    render_lyria_master,
)


class _Resp:
    def __init__(self, body: bytes, headers: dict | None = None):
        self._body = body
        self.headers = headers or {}

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _json_resp(payload: dict) -> _Resp:
    return _Resp(json.dumps(payload).encode("utf-8"), {"Content-Type": "application/json"})


def _pcm_wav_bytes(sample_rate: int = 44100, seconds: float = 0.05) -> bytes:
    """Stereo PCM WAV. Not 48 kHz, so the master must be resampled.

    ``seconds=0.05`` stays under 100KB so the write path can be tested without
    the Gate 1 size check. Publish tests pass a longer duration.
    """
    frames = int(sample_rate * seconds)
    t = np.arange(frames, dtype=np.float64) / float(sample_rate)
    stereo = np.column_stack(
        [
            0.2 * np.sin(2.0 * np.pi * 440.0 * t),
            0.1 * np.sin(2.0 * np.pi * 660.0 * t),
        ]
    )
    buf = io.BytesIO()
    sf.write(buf, stereo, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _assert_master_wav(path: str) -> None:
    info = sf.info(path)
    assert info.samplerate == 48000
    assert info.format == "WAV"
    assert str(info.subtype).startswith("PCM")
    with open(path, "rb") as handle:
        header = handle.read(12)
    assert header[:4] == b"RIFF"
    assert header[8:12] == b"WAVE"
    data, rate = sf.read(path, always_2d=True)
    assert rate == 48000
    assert data.shape[0] > 0
    assert data.shape[1] in (1, 2)


def test_compose_uses_job_style_prompt_and_lyrics():
    assert compose_lyria_prompt("dark synth", "", "neon rain") == "dark synth\n\nneon rain"
    assert compose_lyria_prompt("", "night drive", "neon rain") == "night drive\n\nneon rain"
    # A prompt that only repeats the lyrics is not written twice.
    assert compose_lyria_prompt("dark synth", "neon rain", "neon rain") == "dark synth\n\nneon rain"
    assert compose_lyria_prompt("dark synth", "wide stereo", "neon rain") == (
        "dark synth\nwide stereo\n\nneon rain"
    )
    assert compose_lyria_prompt("style only", "", "") == "style only"
    with pytest.raises(ValueError, match="empty"):
        compose_lyria_prompt("  ", "", "")


def test_output_url_accepts_a_string_or_a_one_item_list():
    assert lyria_output_url("https://cdn.example/a.mp3") == "https://cdn.example/a.mp3"
    assert lyria_output_url(["https://cdn.example/a.mp3"]) == "https://cdn.example/a.mp3"
    with pytest.raises(RuntimeError, match="audio URL"):
        lyria_output_url(["https://cdn.example/a.mp3", "https://cdn.example/b.mp3"])


def test_lyria_posts_polls_downloads_and_skips_the_bounce(tmp_path, monkeypatch):
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_hybrid")
    monkeypatch.setenv("LYRIC_ENGINE_API_KEY", "r8_lyric")
    monkeypatch.setenv("ENGINE_API_KEY", "r8_lyric")
    slept: list[float] = []
    monkeypatch.setattr(
        "engine.generate_track_headless.time.sleep",
        lambda seconds: slept.append(seconds),
    )

    def boom(*_args, **_kwargs):
        raise AssertionError("13-lane bounce ran")

    monkeypatch.setattr("engine.blueprint_track_assembler.assemble_arranged_buses", boom)
    monkeypatch.setattr("engine.blueprint_track_assembler._bounce_console_lanes", boom)
    monkeypatch.setattr("engine.generate_track_headless.assemble_from_blueprint", boom)

    audio = _pcm_wav_bytes()
    poll_url = "https://api.replicate.com/v1/predictions/pred_test"
    audio_url = "https://replicate.delivery/pb/out.mp3"
    responses = [
        _json_resp(
            {
                "id": "pred_test",
                "status": "processing",
                "urls": {"get": poll_url},
            }
        ),
        _json_resp(
            {
                "id": "pred_test",
                "status": "succeeded",
                "output": [audio_url],
            }
        ),
        _Resp(audio, {"Content-Type": "audio/wav"}),
    ]
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        if not responses:
            raise AssertionError(f"unexpected HTTP call to {req.full_url}")
        return responses.pop(0)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    saved = render_lyria_master(
        str(tmp_path),
        style="dark synth",
        prompt="night drive",
        lyrics="neon rain",
        session_id="ht_lyria",
        poll_sec=LYRIA_POLL_SEC,
    )

    assert slept == [LYRIA_POLL_SEC]
    assert calls[0].full_url == LYRIA_PREDICTIONS_URL
    assert calls[0].get_method() == "POST"
    assert calls[0].get_header("Authorization") == "Bearer r8_hybrid"
    assert "r8_lyric" not in (calls[0].get_header("Authorization") or "")
    assert calls[0].get_header("Content-type") == "application/json"
    assert calls[0].get_header("Prefer") == "wait"
    assert json.loads(calls[0].data.decode("utf-8")) == {
        "input": {"prompt": "dark synth\nnight drive\n\nneon rain"}
    }
    assert calls[1].full_url == poll_url
    assert calls[1].get_method() == "GET"
    assert calls[1].data is None
    assert calls[1].get_header("Authorization") == "Bearer r8_hybrid"
    assert calls[2].full_url == audio_url
    assert calls[2].get_method() == "GET"
    assert calls[2].get_header("Authorization") is None
    assert saved.endswith(os.path.join("ht_lyria_master.wav")) or saved.endswith("ht_lyria_master.wav")
    _assert_master_wav(saved)


def test_lyric_key_alone_does_not_call_lyria(tmp_path, monkeypatch):
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.delenv("REPLICATE_API_TOKEN", raising=False)
    monkeypatch.delenv("REPLICATE_API_KEY", raising=False)
    monkeypatch.setenv("LYRIC_ENGINE_API_KEY", "r8_lyric")
    monkeypatch.setenv("ENGINE_API_KEY", "r8_lyric")

    def fake_urlopen(*_args, **_kwargs):
        raise AssertionError("Lyria was called without REPLICATE_API_TOKEN")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(RuntimeError, match="REPLICATE_API_TOKEN"):
        render_lyria_master(
            str(tmp_path),
            style="dark synth",
            lyrics="neon rain",
            session_id="ht_nolyric",
        )


def test_equal_lyric_and_hybrid_token_still_posts_the_hybrid_token(tmp_path, monkeypatch):
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_same")
    monkeypatch.setenv("LYRIC_ENGINE_API_KEY", "r8_same")
    monkeypatch.setenv("ENGINE_API_KEY", "r8_same")
    assert lyric_replicate_token() == ""
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        if req.get_method() == "POST":
            return _json_resp(
                {
                    "id": "pred_done",
                    "status": "succeeded",
                    "output": "https://replicate.delivery/pb/done.mp3",
                }
            )
        return _Resp(_pcm_wav_bytes(), {"Content-Type": "audio/wav"})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    saved = render_lyria_master(
        str(tmp_path),
        style="dark synth",
        lyrics="line one",
        session_id="ht_equal",
    )
    assert len(calls) == 2
    assert calls[0].get_header("Authorization") == "Bearer r8_same"
    assert calls[0].full_url == LYRIA_PREDICTIONS_URL
    assert saved.endswith("ht_equal_master.wav")
    _assert_master_wav(saved)


def test_worker_publishes_master_and_mp3_urls(tmp_path, monkeypatch):
    from api import headless_job_runner as runner

    scratch = tmp_path / "scratch"
    assets = tmp_path / "assets"
    scratch.mkdir()
    assets.mkdir()
    monkeypatch.setattr(runner, "SCRATCH_ROOT", str(scratch))
    monkeypatch.setattr(runner, "ASSETS_ROOT", str(assets))
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_hybrid")
    monkeypatch.setenv("LYRIC_ENGINE_API_KEY", "r8_lyric")
    monkeypatch.setattr("engine.generate_track_headless.time.sleep", lambda _seconds: None)

    def boom(*_args, **_kwargs):
        raise AssertionError("13-lane bounce ran")

    monkeypatch.setattr(runner, "_run_headless", boom)
    monkeypatch.setattr(runner, "_run_master_pipeline", boom)
    monkeypatch.setattr(runner, "_try_module5_delivery", boom)
    monkeypatch.setattr("engine.blueprint_track_assembler.assemble_arranged_buses", boom)
    monkeypatch.setattr("engine.blueprint_track_assembler._bounce_console_lanes", boom)
    monkeypatch.setattr("engine.generate_track_headless.assemble_from_blueprint", boom)

    # One second at 44.1 kHz resamples to 48000 stereo PCM16 frames (>100KB).
    audio = _pcm_wav_bytes(seconds=1.0)
    poll_url = "https://api.replicate.com/v1/predictions/job1"
    audio_url = "https://replicate.delivery/pb/job1.wav"
    responses = [
        _json_resp({"id": "job1", "status": "processing", "urls": {"get": poll_url}}),
        _json_resp({"id": "job1", "status": "succeeded", "output": audio_url}),
        _Resp(audio, {"Content-Type": "audio/wav"}),
    ]
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        return responses.pop(0)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    session = "ht_joblyria01"
    job = {"session_id": session, "status": "queued", "genre_hint": "rock", "error": None}
    with runner._registry_lock:
        runner._jobs[session] = job
    runner._worker(
        session,
        "prompt field",
        "rock",
        False,
        {"style": "dark synth", "lyrics": "neon rain"},
    )
    public = runner._public_job(runner._lookup_job(session))
    assert public["status"] == "completed", public.get("error")
    assert public["audio_filename"] == f"{session}_master.wav"
    assert public["master_url"] == f"/api/stream/{session}_master.wav"
    assert public["audio_mime"] == "audio/wav"
    assert public.get("mp3_url") in {None, ""}
    _assert_master_wav(str(assets / f"{session}_master.wav"))
    assert calls[0].full_url == LYRIA_PREDICTIONS_URL
    assert json.loads(calls[0].data.decode("utf-8")) == {
        "input": {"prompt": "dark synth\nprompt field\n\nneon rain"}
    }
    assert calls[1].full_url == poll_url
    assert calls[2].full_url == audio_url
    published = assets / f"{session}_master.wav"
    assert published.stat().st_size > 100 * 1024


def test_write_lyria_wav_allows_short_tones_and_gate_is_size_only(tmp_path):
    from engine.generate_track_headless import _write_lyria_wav, assert_lyria_master_wav

    short = tmp_path / "short_tone.wav"
    _write_lyria_wav(str(short), np.zeros(480, dtype=np.float64))
    assert short.stat().st_size < 100 * 1024
    info = sf.info(str(short))
    assert info.samplerate == 48000
    assert info.format == "WAV"
    assert str(info.subtype).startswith("PCM")
    with pytest.raises(RuntimeError, match="100KB"):
        assert_lyria_master_wav(str(short))

    # Gate 1 does not require a RIFF header, a sample rate, or a bar count.
    fat = tmp_path / "fat_master.wav"
    fat.write_bytes(b"\0" * (100 * 1024 + 1))
    assert_lyria_master_wav(str(fat))
    exact = tmp_path / "exact_100kb.wav"
    exact.write_bytes(b"\0" * (100 * 1024))
    with pytest.raises(RuntimeError, match="100KB"):
        assert_lyria_master_wav(str(exact))
    with pytest.raises(RuntimeError, match="missing"):
        assert_lyria_master_wav(str(tmp_path / "absent.wav"))


def test_main_exits_zero_after_printing_lyria_master(tmp_path, monkeypatch):
    from engine.generate_track_headless import main

    saved = tmp_path / "ht_exit_master.wav"
    saved.write_bytes(b"RIFF" + b"\0" * 32)

    def fake_render(*_args, **_kwargs):
        return str(saved)

    def boom(*_args, **_kwargs):
        raise AssertionError("legacy stem code ran")

    monkeypatch.setattr("engine.generate_track_headless.render_lyria_master", fake_render)
    monkeypatch.setattr("engine.generate_track_headless.assemble_from_blueprint", boom)
    with pytest.raises(SystemExit) as exc:
        main(["--prompt", "Outlaw Country", "--session", "ht_exit", "--scratch", str(tmp_path)])
    assert exc.value.code == 0
