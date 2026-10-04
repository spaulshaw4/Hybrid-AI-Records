"""Lyria 3 Pro generate path. HTTP is mocked; nothing is sent to Replicate."""
from __future__ import annotations

import http.client
import io
import json
import os
import sys
import types
import urllib.error
import urllib.request

import numpy as np
import pytest
import soundfile as sf

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.gemini_arranger import lyric_replicate_token  # noqa: E402
from engine.generate_track_headless import (  # noqa: E402
    LYRIC_SANITIZE_SYSTEM,
    LYRIC_SANITIZE_URL,
    LYRIA_POLL_SEC,
    LYRIA_PREDICTIONS_URL,
    _is_lyria_gateway_drop,
    compose_lyria_prompt,
    lyria_output_url,
    generation_token_charge,
    render_lyria_master,
    sanitize_lyrics_for_lyria,
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


def _echo_sanitize(req):
    """Succeed a Gemini preflight by echoing the lyrics, so Lyria fixtures stay put."""
    if "gemini-2.5-flash" not in getattr(req, "full_url", ""):
        return None
    payload = json.loads(req.data.decode("utf-8"))
    return _json_resp(
        {
            "id": "san_echo",
            "status": "succeeded",
            "output": payload["input"]["prompt"],
        }
    )


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
        echoed = _echo_sanitize(req)
        if echoed is not None:
            assert timeout is not None and timeout <= 5.0
            return echoed
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
    assert calls[0].full_url == LYRIC_SANITIZE_URL
    assert calls[0].get_header("Authorization") == "Bearer r8_hybrid"
    assert "r8_lyric" not in (calls[0].get_header("Authorization") or "")
    sanitize_body = json.loads(calls[0].data.decode("utf-8"))
    assert sanitize_body["input"]["prompt"] == "neon rain"
    assert sanitize_body["input"]["system_instruction"] == LYRIC_SANITIZE_SYSTEM
    assert calls[1].full_url == LYRIA_PREDICTIONS_URL
    assert calls[1].get_method() == "POST"
    assert calls[1].get_header("Authorization") == "Bearer r8_hybrid"
    assert "r8_lyric" not in (calls[1].get_header("Authorization") or "")
    assert calls[1].get_header("Content-type") == "application/json"
    assert calls[1].get_header("Prefer") == "wait"
    assert json.loads(calls[1].data.decode("utf-8")) == {
        "input": {"prompt": "dark synth\nnight drive\n\nneon rain"}
    }
    assert calls[2].full_url == poll_url
    assert calls[2].get_method() == "GET"
    assert calls[2].data is None
    assert calls[2].get_header("Authorization") == "Bearer r8_hybrid"
    assert calls[3].full_url == audio_url
    assert calls[3].get_method() == "GET"
    assert calls[3].get_header("Authorization") is None
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
        echoed = _echo_sanitize(req)
        if echoed is not None:
            return echoed
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
    assert len(calls) == 3
    assert calls[0].full_url == LYRIC_SANITIZE_URL
    assert calls[0].get_header("Authorization") == "Bearer r8_same"
    assert calls[1].get_header("Authorization") == "Bearer r8_same"
    assert calls[1].full_url == LYRIA_PREDICTIONS_URL
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
        echoed = _echo_sanitize(req)
        if echoed is not None:
            return echoed
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
    assert calls[0].full_url == LYRIC_SANITIZE_URL
    assert calls[1].full_url == LYRIA_PREDICTIONS_URL
    assert json.loads(calls[1].data.decode("utf-8")) == {
        "input": {"prompt": "dark synth\nprompt field\n\nneon rain"}
    }
    assert calls[2].full_url == poll_url
    assert calls[3].full_url == audio_url
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


def test_main_exits_zero_after_printing_lyria_master(tmp_path, monkeypatch, capsys):
    from engine.generate_track_headless import main

    saved = tmp_path / "ht_exit" / "ht_exit_master.wav"
    saved.parent.mkdir()
    saved.write_bytes(b"RIFF" + b"\0" * 32)
    assert saved.stat().st_size > 0

    def fake_render(*_args, **_kwargs):
        return str(saved)

    def boom(*_args, **_kwargs):
        raise AssertionError("legacy stem code ran")

    monkeypatch.setattr("engine.generate_track_headless.render_lyria_master", fake_render)
    monkeypatch.setattr("engine.generate_track_headless.assemble_from_blueprint", boom)
    monkeypatch.setattr("engine.generate_track_headless.execute_prompt_pipeline", boom)
    monkeypatch.setattr("engine.generate_track_headless.split_pool_by_layer", boom)
    with pytest.raises(SystemExit) as exc:
        main(["--prompt", "Outlaw Country", "--session", "ht_exit", "--scratch", str(tmp_path)])
    assert exc.value.code == 0
    assert f"[LYRIA] master={saved}" in capsys.readouterr().out


def test_sanitize_lyrics_land_in_the_lyria_prompt(tmp_path, monkeypatch):
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_hybrid")
    monkeypatch.setenv("LYRIC_ENGINE_API_KEY", "r8_lyric")
    original = "[Verse]\nGoing easy on the whiskey"
    sanitized = "[Verse]\nGoing easy on the bottle"
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        if "gemini-2.5-flash" in req.full_url:
            assert timeout is not None and timeout <= 5.0
            assert req.get_header("Authorization") == "Bearer r8_hybrid"
            assert "r8_lyric" not in (req.get_header("Authorization") or "")
            body = json.loads(req.data.decode("utf-8"))
            assert body["input"]["prompt"] == original
            assert body["input"]["system_instruction"] == LYRIC_SANITIZE_SYSTEM
            assert req.get_header("Prefer") == "wait"
            return _json_resp({"id": "san", "status": "succeeded", "output": sanitized})
        if req.full_url == LYRIA_PREDICTIONS_URL:
            sent = json.loads(req.data.decode("utf-8"))["input"]["prompt"]
            assert "whiskey" not in sent.lower()
            assert sent == f"outlaw country\n\n{sanitized}"
            return _json_resp(
                {
                    "id": "pred_done",
                    "status": "succeeded",
                    "output": "https://replicate.delivery/pb/done.wav",
                }
            )
        return _Resp(_pcm_wav_bytes(), {"Content-Type": "audio/wav"})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    saved = render_lyria_master(
        str(tmp_path),
        style="outlaw country",
        prompt=original,
        lyrics=original,
        session_id="ht_whiskey",
    )
    assert saved.endswith("ht_whiskey_master.wav")
    assert calls[0].full_url == LYRIC_SANITIZE_URL
    assert calls[1].full_url == LYRIA_PREDICTIONS_URL
    _assert_master_wav(saved)


def test_sanitize_polls_then_returns_lyrics(monkeypatch):
    monkeypatch.setattr("engine.generate_track_headless.time.sleep", lambda _seconds: None)
    poll_url = "https://api.replicate.com/v1/predictions/san_poll"
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req.full_url)
        if req.get_method() == "POST":
            return _json_resp({"id": "san_poll", "status": "processing", "urls": {"get": poll_url}})
        return _json_resp({"id": "san_poll", "status": "succeeded", "output": "[Chorus]\nrye"})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    out = sanitize_lyrics_for_lyria("[Chorus]\nwhiskey", token="r8_hybrid")
    assert out == "[Chorus]\nrye"
    assert calls == [LYRIC_SANITIZE_URL, poll_url]


def test_sanitize_timeout_keeps_original_lyrics(monkeypatch, capsys):
    clock = {"t": 0.0}
    monkeypatch.setattr("engine.generate_track_headless.time.monotonic", lambda: clock["t"])

    def fake_urlopen(req, timeout=None):
        assert timeout is not None and timeout <= 5.0
        clock["t"] = 5.1
        return _json_resp(
            {
                "id": "slow",
                "status": "processing",
                "urls": {"get": "https://api.replicate.com/v1/predictions/slow"},
            }
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    original = "[Verse]\nwhiskey night"
    assert sanitize_lyrics_for_lyria(original, token="r8_hybrid") == original
    err = capsys.readouterr().err
    assert "sanitize skipped" in err
    assert "using original lyrics" in err


def test_sanitize_error_keeps_original_lyrics(monkeypatch, capsys):
    def fake_urlopen(req, timeout=None):
        raise TimeoutError("timed out")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    original = "[Bridge]\nbourbon"
    assert sanitize_lyrics_for_lyria(original, token="r8_hybrid") == original
    assert "sanitize skipped" in capsys.readouterr().err


def test_blank_lyrics_skip_the_preflight(tmp_path, monkeypatch):
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_hybrid")
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        assert "gemini-2.5-flash" not in req.full_url
        if req.get_method() == "POST":
            return _json_resp(
                {
                    "id": "pred_done",
                    "status": "succeeded",
                    "output": "https://replicate.delivery/pb/done.wav",
                }
            )
        return _Resp(_pcm_wav_bytes(), {"Content-Type": "audio/wav"})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    render_lyria_master(str(tmp_path), style="outlaw country", lyrics="", session_id="ht_nolyrics")
    assert len(calls) == 2
    assert calls[0].full_url == LYRIA_PREDICTIONS_URL


def _succeeded_lyria(req):
    if req.get_method() == "POST":
        return _json_resp(
            {
                "id": "pred_done",
                "status": "succeeded",
                "output": "https://replicate.delivery/pb/done.wav",
            }
        )
    return _Resp(_pcm_wav_bytes(), {"Content-Type": "audio/wav"})


def test_prediction_retries_remote_disconnected_then_succeeds(tmp_path, monkeypatch):
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_hybrid")
    slept: list[float] = []
    monkeypatch.setattr("engine.generate_track_headless.time.sleep", lambda seconds: slept.append(seconds))
    posts = {"n": 0}

    def fake_urlopen(req, timeout=None):
        if req.full_url == LYRIA_PREDICTIONS_URL:
            posts["n"] += 1
            if posts["n"] == 1:
                raise http.client.RemoteDisconnected("Remote end closed connection without response")
        return _succeeded_lyria(req)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    saved = render_lyria_master(str(tmp_path), style="outlaw country", lyrics="", session_id="ht_retry")
    assert saved.endswith("ht_retry_master.wav")
    assert posts["n"] == 2
    assert slept == [3.0]
    _assert_master_wav(saved)


def test_prediction_retries_urlerror_wrapped_disconnect(tmp_path, monkeypatch):
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_hybrid")
    monkeypatch.setattr("engine.generate_track_headless.time.sleep", lambda _seconds: None)
    posts = {"n": 0}

    def fake_urlopen(req, timeout=None):
        if req.full_url == LYRIA_PREDICTIONS_URL:
            posts["n"] += 1
            if posts["n"] == 1:
                raise urllib.error.URLError(http.client.RemoteDisconnected("closed"))
        return _succeeded_lyria(req)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    render_lyria_master(str(tmp_path), style="outlaw country", lyrics="", session_id="ht_wrapped")
    assert posts["n"] == 2


def test_prediction_stops_after_two_gateway_retries(tmp_path, monkeypatch):
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_hybrid")
    slept: list[float] = []
    monkeypatch.setattr("engine.generate_track_headless.time.sleep", lambda seconds: slept.append(seconds))
    posts = {"n": 0}

    def fake_urlopen(req, timeout=None):
        if req.full_url == LYRIA_PREDICTIONS_URL:
            posts["n"] += 1
            raise http.client.RemoteDisconnected("closed")
        return _succeeded_lyria(req)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(http.client.RemoteDisconnected):
        render_lyria_master(str(tmp_path), style="outlaw country", lyrics="", session_id="ht_giveup")
    assert posts["n"] == 3
    assert slept == [3.0, 3.0]


def test_prediction_does_not_retry_http_errors(tmp_path, monkeypatch):
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_hybrid")
    slept: list[float] = []
    monkeypatch.setattr("engine.generate_track_headless.time.sleep", lambda seconds: slept.append(seconds))
    posts = {"n": 0}

    def fake_urlopen(req, timeout=None):
        posts["n"] += 1
        raise urllib.error.HTTPError(req.full_url, 500, "err", hdrs=None, fp=io.BytesIO(b"no"))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(RuntimeError, match="HTTP 500"):
        render_lyria_master(str(tmp_path), style="outlaw country", lyrics="", session_id="ht_http")
    assert posts["n"] == 1
    assert slept == []


def test_gateway_drop_includes_requests_connection_error(monkeypatch):
    class RequestsConnectionError(OSError):
        pass

    fake_requests = types.ModuleType("requests")
    fake_exc = types.ModuleType("requests.exceptions")
    fake_exc.ConnectionError = RequestsConnectionError
    fake_requests.exceptions = fake_exc
    monkeypatch.setitem(sys.modules, "requests", fake_requests)
    monkeypatch.setitem(sys.modules, "requests.exceptions", fake_exc)
    assert _is_lyria_gateway_drop(RequestsConnectionError("reset"))
    assert not _is_lyria_gateway_drop(RuntimeError("HTTP 422"))


_LONG_LYRICS = "[Verse]\nalpha verse line\n\n[Chorus]\nbravo chorus line"


class _FakeSegment:
    """Stand-in for pydub so the stitch contract can run without ffmpeg."""

    crossfades: list[int] = []
    exports: list[str] = []

    def __init__(self, path: str):
        self.path = path

    @classmethod
    def from_wav(cls, path: str):
        return cls(path)

    def __len__(self) -> int:
        return 20000

    def __getitem__(self, _item):
        return self

    def append(self, _other, crossfade: int = 0):
        type(self).crossfades.append(int(crossfade))
        return self

    def export(self, path: str, format: str = "wav"):
        assert format == "wav"
        type(self).exports.append(path)
        with open(path, "wb") as handle:
            handle.write(b"RIFF" + b"\0" * 32)
        return path


def _install_fake_pydub(monkeypatch) -> None:
    _FakeSegment.crossfades = []
    _FakeSegment.exports = []
    fake = types.ModuleType("pydub")
    fake.AudioSegment = _FakeSegment
    monkeypatch.setitem(sys.modules, "pydub", fake)


def _prime_lyria(monkeypatch) -> None:
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_hybrid")
    monkeypatch.setenv("LYRIC_ENGINE_API_KEY", "r8_lyric")
    monkeypatch.setattr("engine.generate_track_headless.time.sleep", lambda _seconds: None)


def _scripted_lyria(monkeypatch, wavs: list[bytes], *, fail_on_post: int | None = None):
    """Return a list that records every Lyria prediction POST."""
    posts: list = []
    downloads = list(wavs)

    def fake_urlopen(req, timeout=None):
        echoed = _echo_sanitize(req)
        if echoed is not None:
            return echoed
        if getattr(req, "full_url", "") == LYRIA_PREDICTIONS_URL and req.get_method() == "POST":
            posts.append(req)
            if fail_on_post is not None and len(posts) == fail_on_post:
                return _json_resp({"id": f"pred_{len(posts)}", "status": "failed", "error": "pass failed"})
            return _json_resp(
                {
                    "id": f"pred_{len(posts)}",
                    "status": "succeeded",
                    "output": f"https://replicate.delivery/pb/pass{len(posts)}.wav",
                }
            )
        if not downloads:
            raise AssertionError(f"unexpected HTTP call to {req.full_url}")
        return _Resp(downloads.pop(0), {"Content-Type": "audio/wav"})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return posts


@pytest.mark.parametrize("seconds", [90, 180, 210, 240, 300, 420, None])
def test_generation_token_charge_is_one_for_every_preset(seconds):
    assert generation_token_charge(seconds) == 1


def test_clamp_duration_accepts_ten_second_steps_from_90_to_420():
    from services.composition import clamp_duration
    from engine.generate_track_headless import clamp_lyria_duration

    for seconds in (90, 100, 180, 210, 240, 300, 410, 420):
        assert clamp_duration(seconds) == seconds
        assert clamp_lyria_duration(seconds) == seconds
    assert clamp_duration(89) == 90
    assert clamp_duration(50) == 90
    assert clamp_duration(421) == 420
    assert clamp_duration(215) == 220
    assert clamp_duration(None) == 210
    assert clamp_lyria_duration(None) == 210
    assert generation_token_charge(90) == 1
    assert generation_token_charge(240) == 1
    assert generation_token_charge(420) == 1


def test_stitch_helper_uses_pydub_append_crossfade_1000():
    path = os.path.join(_REPO, "services", "composition.py")
    text = open(path, encoding="utf-8").read()
    assert "part1 = AudioSegment.from_wav(part1_path)" in text
    assert "part2 = AudioSegment.from_wav(part2_path)" in text
    assert "full_master = part1.append(part2, crossfade=1000)" in text
    assert 'full_master.export(master_output_path, format="wav")' in text


@pytest.mark.parametrize("seconds", [90, 180, 210])
def test_short_presets_make_one_lyria_prediction(tmp_path, monkeypatch, seconds):
    _prime_lyria(monkeypatch)
    posts = _scripted_lyria(monkeypatch, [_pcm_wav_bytes()])
    session = f"ht_{seconds}"
    saved = render_lyria_master(
        str(tmp_path),
        style="dark synth",
        prompt="night drive",
        lyrics=_LONG_LYRICS,
        session_id=session,
        duration_sec=seconds,
    )
    assert len(posts) == 1
    body = json.loads(posts[0].data.decode("utf-8"))
    assert list(body) == ["input"]
    assert list(body["input"]) == ["prompt"]
    assert "alpha verse line" in body["input"]["prompt"]
    assert "bravo chorus line" in body["input"]["prompt"]
    assert saved.endswith(f"{session}_master.wav")
    assert os.path.isfile(saved)
    assert not (tmp_path / "part1.wav").exists()
    assert not (tmp_path / "part2.wav").exists()


@pytest.mark.parametrize("seconds", [240, 300, 420])
def test_long_presets_make_two_predictions_and_crossfade_1000(tmp_path, monkeypatch, seconds):
    _prime_lyria(monkeypatch)
    _install_fake_pydub(monkeypatch)
    posts = _scripted_lyria(monkeypatch, [_pcm_wav_bytes(), _pcm_wav_bytes()])
    session = f"ht_{seconds}"
    saved = render_lyria_master(
        str(tmp_path),
        style="dark synth",
        prompt="night drive",
        lyrics=_LONG_LYRICS,
        session_id=session,
        duration_sec=seconds,
    )
    assert len(posts) == 2
    first = json.loads(posts[0].data.decode("utf-8"))["input"]["prompt"]
    second = json.loads(posts[1].data.decode("utf-8"))["input"]["prompt"]
    assert list(json.loads(posts[0].data.decode("utf-8"))) == ["input"]
    assert "alpha verse line" in first
    assert "bravo chorus line" not in first
    assert "15-second ending" in second
    assert "bravo chorus line" in second
    assert "alpha verse line" not in second
    assert _FakeSegment.crossfades == [1000]
    assert (tmp_path / "part1.wav").is_file()
    assert (tmp_path / "part2.wav").is_file()
    assert saved == str(tmp_path / f"{session}_master.wav")
    assert os.path.isfile(saved)
    assert any(path.endswith(f"{session}_master.wav") for path in _FakeSegment.exports)


def test_pass_two_failure_raises_like_a_single_lyria_failure(tmp_path, monkeypatch):
    _prime_lyria(monkeypatch)
    _install_fake_pydub(monkeypatch)
    posts = _scripted_lyria(monkeypatch, [_pcm_wav_bytes()], fail_on_post=2)
    with pytest.raises(RuntimeError, match="Lyria prediction failed"):
        render_lyria_master(
            str(tmp_path),
            style="dark synth",
            lyrics=_LONG_LYRICS,
            session_id="ht_pass2",
            duration_sec=420,
        )
    assert len(posts) == 2
    assert (tmp_path / "part1.wav").is_file()
    assert not (tmp_path / "part2.wav").exists()
    assert not (tmp_path / "ht_pass2_master.wav").exists()
    assert _FakeSegment.crossfades == []
