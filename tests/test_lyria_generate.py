"""Lyria 3 Pro generate path. HTTP is mocked; nothing is sent to Replicate."""
from __future__ import annotations

import json
import os
import sys
import urllib.request

import pytest

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

    audio = b"ID3" + b"\x00" * 64
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
        _Resp(audio, {"Content-Type": "audio/mpeg"}),
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
    assert saved.endswith(os.path.join("ht_lyria_master.mp3")) or saved.endswith("ht_lyria_master.mp3")
    with open(saved, "rb") as handle:
        assert handle.read() == audio


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
        return _Resp(b"ID3" + b"\x00" * 8, {"Content-Type": "audio/mpeg"})

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
    assert saved.endswith("ht_equal_master.mp3")


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

    audio = b"ID3" + b"\x00" * 128
    poll_url = "https://api.replicate.com/v1/predictions/job1"
    audio_url = "https://replicate.delivery/pb/job1.mp3"
    responses = [
        _json_resp({"id": "job1", "status": "processing", "urls": {"get": poll_url}}),
        _json_resp({"id": "job1", "status": "succeeded", "output": audio_url}),
        _Resp(audio, {"Content-Type": "audio/mpeg"}),
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
    assert public["audio_filename"] == f"{session}_master.mp3"
    assert public["master_url"] == f"/api/stream/{session}_master.mp3"
    assert public["mp3_url"] == public["master_url"]
    assert (assets / f"{session}_master.mp3").read_bytes() == audio
    assert calls[0].full_url == LYRIA_PREDICTIONS_URL
    assert json.loads(calls[0].data.decode("utf-8")) == {
        "input": {"prompt": "dark synth\nprompt field\n\nneon rain"}
    }
    assert calls[1].full_url == poll_url
    assert calls[2].full_url == audio_url
