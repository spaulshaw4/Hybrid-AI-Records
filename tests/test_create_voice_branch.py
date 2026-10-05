"""Create-route branch: instrumental Lyria bed plus ffmpeg when a take is present.

HTTP is mocked and ffmpeg is stubbed. Nothing is sent to Replicate.
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

import numpy as np
import pytest
import soundfile as sf

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from api import headless_job_runner as runner  # noqa: E402


class _Resp:
    def __init__(self, body: bytes, headers: dict | None = None):
        self._body = body
        self.headers = headers or {}

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0 or size >= len(self._body):
            data = self._body
            self._body = b""
            return data
        data = self._body[:size]
        self._body = self._body[size:]
        return data

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _json_resp(payload: dict) -> _Resp:
    return _Resp(json.dumps(payload).encode("utf-8"), {"Content-Type": "application/json"})


def _gate_wav() -> bytes:
    frames = 48000
    audio = np.zeros((frames, 2), dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, audio, 48000, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _reference_bytes() -> bytes:
    return b"RIFF" + b"\x00" * 80


def _echo_sanitize(req):
    url = getattr(req, "full_url", "")
    if "gemini-2.5-flash" not in url:
        return None
    payload = json.loads(req.data.decode("utf-8"))
    return _json_resp({"id": "san_echo", "status": "succeeded", "output": payload["input"]["prompt"]})


def _install_http(monkeypatch, responses: list, calls: list):
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_hybrid")
    monkeypatch.setattr("engine.generate_track_headless.time.sleep", lambda _seconds: None)
    monkeypatch.setattr("services.voice_service.time.sleep", lambda _seconds: None)

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        echoed = _echo_sanitize(req)
        if echoed is not None:
            return echoed
        if not responses:
            raise AssertionError(f"unexpected HTTP call to {req.full_url}")
        return responses.pop(0)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)


def _client(monkeypatch, started: list):
    monkeypatch.delenv("HYBRID_WORKER_TOKEN", raising=False)

    class _NoThread:
        def __init__(self, target, args, name, daemon):
            started.append(args)

        def start(self):
            pass

    monkeypatch.setattr(runner.threading, "Thread", _NoThread)
    from fastapi.testclient import TestClient

    return TestClient(runner.app)


def _fields(**extra: str) -> dict[str, str]:
    body = {
        "prompt": "night drive " + ("x" * 50),
        "lyrics": "neon rain",
        "duration": "210",
        "tempo": "110",
        "weirdness": "20",
        "audio_influence": "75",
        "style_influence": "65",
        "style": "outlaw country",
    }
    body.update(extra)
    return body


@pytest.fixture()
def live_dirs(tmp_path, monkeypatch):
    scratch = tmp_path / "scratch"
    assets = tmp_path / "assets"
    scratch.mkdir()
    assets.mkdir()
    monkeypatch.setattr(runner, "SCRATCH_ROOT", str(scratch))
    monkeypatch.setattr(runner, "ASSETS_ROOT", str(assets))
    monkeypatch.setattr(runner, "DELIVERIES_ROOT", str(tmp_path / "deliveries"))
    monkeypatch.setattr(runner, "_API_LOG", str(tmp_path / "api.log"))
    monkeypatch.setattr(runner, "_log", lambda _msg: None)
    runner._jobs.clear()
    runner._release_generation_claim()
    runner._active_session_id = None
    return scratch, assets


_SINGER_FIELDS = {
    "voice_file",
    "voice",
    "singer",
    "singer_id",
    "reference_audio",
    "audio",
    "audio_file",
    "vocal",
    "vocal_file",
    "speaker",
    "speaker_wav",
    "voice_id",
    "lyrics",
    "text",
    "ref_audio",
    "voice_sample",
}


def _aliases(body: dict, session_id: str) -> None:
    assert body["session_id"] == session_id
    assert body["sessionId"] == session_id
    assert body["track_id"] == session_id
    assert body["id"] == session_id
    assert "Create did not return a session id" not in str(body.get("error") or "")


def _forbid_ffmpeg(monkeypatch) -> None:
    def fake_run(*args, **kwargs):
        raise AssertionError(f"ffmpeg mix ran: {args[0] if args else kwargs}")

    monkeypatch.setattr(runner.subprocess, "run", fake_run)


def test_create_without_voice_sample_uses_lyria_only(live_dirs, monkeypatch):
    scratch, _assets = live_dirs
    audio = _gate_wav()
    audio_url = "https://replicate.delivery/pb/lyria.wav"
    responses = [
        _json_resp({"id": "pred_lyria", "status": "succeeded", "output": audio_url}),
        _Resp(audio, {"Content-Type": "audio/wav"}),
    ]
    calls: list = []
    _install_http(monkeypatch, responses, calls)
    _forbid_ffmpeg(monkeypatch)
    started: list = []
    client = _client(monkeypatch, started)
    # Multipart with no voice_sample field. Filename recording.wav is not sent.
    response = client.post("/api/tracks/create", data=_fields(), files={"note": (None, "")})
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["engine_used"] == "Lyria"
    assert body["token_cost"] == 1
    assert body["vocal_present"] is False
    assert body["status"] == "pending"
    session_id = body["session_id"]
    _aliases(body, session_id)
    assert session_id.startswith("ht_") and len(session_id) == 15
    opts = started[-1][-1]
    assert "voice_sample_path" not in opts
    assert opts["duration_sec"] == pytest.approx(210.0)
    runner._worker(*started[-1])
    job = runner._public_job(runner._lookup_job(session_id))
    assert job["status"] == "completed", job.get("error")
    assert job["engine_used"] == "Lyria"
    assert job["token_cost"] == 1
    _aliases(job, session_id)
    urls = [req.full_url for req in calls]
    assert any("lyria-3-pro" in url and url.endswith("/predictions") for url in urls)
    assert not any(
        "heart_mula" in url or "music-01" in url or "musicgen" in url or "chatterbox" in url.lower()
        for url in urls
    )
    lyria_posts = [
        req
        for req in calls
        if "lyria-3-pro" in req.full_url and req.full_url.endswith("/predictions")
    ]
    assert len(lyria_posts) == 1
    assert not (scratch / session_id / "ref_vocal.wav").is_file()
    assert not (scratch / session_id / "bed_instrumental.wav").is_file()
    assert (scratch / session_id / f"{session_id}_master.wav").is_file()


def _stub_ffmpeg(monkeypatch, ffmpeg_calls: list, *, code: int = 0, stderr: str = "", write_master: bool = True):
    mixed = _gate_wav()

    def fake_run(cmd, **kwargs):
        ffmpeg_calls.append(list(cmd))
        if write_master and cmd:
            with open(cmd[-1], "wb") as handle:
                handle.write(mixed)
        return subprocess.CompletedProcess(cmd, code, stdout="", stderr=stderr)

    monkeypatch.setattr(runner.subprocess, "run", fake_run)
    return mixed


def test_create_with_recording_wav_mixes_the_take_over_one_instrumental_bed(live_dirs, monkeypatch):
    scratch, assets = live_dirs
    audio = _gate_wav()
    take = _reference_bytes()
    audio_url = "https://replicate.delivery/pb/bed.wav"
    responses = [
        _json_resp({"id": "pred_bed", "status": "succeeded", "output": audio_url}),
        _Resp(audio, {"Content-Type": "audio/wav"}),
    ]
    calls: list = []
    ffmpeg_calls: list = []
    _install_http(monkeypatch, responses, calls)
    mixed = _stub_ffmpeg(monkeypatch, ffmpeg_calls)
    started: list = []
    client = _client(monkeypatch, started)
    # 420 would be two Lyria passes on the text path. A take stays one call.
    response = client.post(
        "/api/tracks/create",
        data=_fields(duration="420"),
        files={"voice_sample": ("recording.wav", take, "audio/wav")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["status"] == "pending"
    assert body["engine_used"] == "Lyria"
    assert body["token_cost"] == 1
    assert body["vocal_present"] is True
    session_id = body["session_id"]
    _aliases(body, session_id)
    ref = scratch / session_id / "ref_vocal.wav"
    assert ref.is_file()
    assert ref.read_bytes() == take
    assert not (scratch / session_id / "recording.wav").exists()
    runner._worker(*started[-1])
    job = runner._public_job(runner._lookup_job(session_id))
    assert job["status"] == "completed", job.get("error")
    assert job["engine_used"] == "Lyria"
    assert job["token_cost"] == 1
    assert job["vocal_present"] is True
    _aliases(job, session_id)
    polled = client.get(f"/api/tracks/status/{session_id}").json()
    _aliases(polled, session_id)
    bed = scratch / session_id / "bed_instrumental.wav"
    master = scratch / session_id / f"{session_id}_master.wav"
    assert bed.is_file()
    assert master.is_file()
    assert master.read_bytes() == mixed
    assert ref.read_bytes() == take
    assert (assets / f"{session_id}_master.wav").read_bytes() == mixed
    assert len(ffmpeg_calls) == 1
    cmd = ffmpeg_calls[0]
    inputs = [cmd[index + 1] for index, flag in enumerate(cmd) if flag == "-i"]
    assert inputs[0].endswith("bed_instrumental.wav")
    assert inputs[1].endswith("ref_vocal.wav")
    assert cmd[-1].endswith(f"{session_id}_master.wav")
    assert runner._VOCAL_MIX_FILTER in cmd
    urls = [req.full_url for req in calls]
    assert not any(
        "music-01" in url or "heart_mula" in url or "chatterbox" in url.lower() or url.rstrip("/").endswith("/files")
        for url in urls
    )
    lyria_posts = [
        req
        for req in calls
        if "lyria-3-pro" in req.full_url and req.full_url.endswith("/predictions")
    ]
    assert len(lyria_posts) == 1
    sent = json.loads(lyria_posts[0].data.decode("utf-8"))
    assert set(sent["input"]) == {"prompt"}
    for field in _SINGER_FIELDS:
        assert field not in sent["input"]
    prompt_text = sent["input"]["prompt"].lower()
    assert "neon rain" not in prompt_text
    assert "instrumental" in prompt_text
    assert "no singer" in prompt_text
    assert "110" in sent["input"]["prompt"]
    assert "outlaw country" in prompt_text
    assert "ref_vocal" not in prompt_text
    for req in calls:
        payload = getattr(req, "data", None) or b""
        if isinstance(payload, str):
            payload = payload.encode()
        assert take not in payload


def test_ffmpeg_mix_failure_is_a_job_error_and_keeps_the_session(live_dirs, monkeypatch, capsys):
    scratch, _assets = live_dirs
    audio = _gate_wav()
    take = _reference_bytes()
    audio_url = "https://replicate.delivery/pb/bed.wav"
    responses = [
        _json_resp({"id": "pred_bed", "status": "succeeded", "output": audio_url}),
        _Resp(audio, {"Content-Type": "audio/wav"}),
    ]
    calls: list = []
    ffmpeg_calls: list = []
    _install_http(monkeypatch, responses, calls)
    _stub_ffmpeg(
        monkeypatch,
        ffmpeg_calls,
        code=1,
        stderr="filter graph failed: Invalid argument\n",
        write_master=False,
    )
    started: list = []
    client = _client(monkeypatch, started)
    response = client.post(
        "/api/tracks/create",
        data=_fields(),
        files={"voice_sample": ("recording.wav", take, "audio/wav")},
    )
    assert response.status_code == 200
    body = response.json()
    session_id = body["session_id"]
    _aliases(body, session_id)
    assert body["vocal_present"] is True
    assert body["token_cost"] == 1
    runner._worker(*started[-1])
    job = runner._public_job(runner._lookup_job(session_id))
    assert job["status"] == "failed"
    assert job["error"].startswith("Voice API failed:")
    assert "Invalid argument" in job["error"]
    assert job["detail"] == job["error"]
    assert "Create did not return a session id" not in job["error"]
    assert job["engine_used"] == "Lyria"
    assert job["token_cost"] == 1
    _aliases(job, session_id)
    polled = client.get(f"/api/tracks/status/{session_id}")
    assert polled.status_code == 200
    _aliases(polled.json(), session_id)
    ref = scratch / session_id / "ref_vocal.wav"
    assert ref.is_file()
    assert ref.read_bytes() == take
    assert (scratch / session_id / "bed_instrumental.wav").is_file()
    assert len(ffmpeg_calls) == 1
    captured = capsys.readouterr()
    assert "Traceback" in captured.err
    health = client.get("/health")
    assert health.status_code == 200


def test_missing_token_does_not_call_replicate(live_dirs, monkeypatch, capsys):
    calls: list = []
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.delenv("REPLICATE_API_TOKEN", raising=False)
    monkeypatch.delenv("REPLICATE_API_KEY", raising=False)
    _forbid_ffmpeg(monkeypatch)

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        raise AssertionError("Replicate was called")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    started: list = []
    client = _client(monkeypatch, started)
    response = client.post(
        "/api/tracks/create",
        data=_fields(),
        files={"voice_sample": ("recording.wav", _reference_bytes(), "audio/wav")},
    )
    assert response.status_code == 200
    body = response.json()
    session_id = body["session_id"]
    assert session_id.startswith("ht_")
    _aliases(body, session_id)
    assert body["vocal_present"] is True
    assert body["token_cost"] == 1
    runner._worker(*started[-1])
    job = runner._public_job(runner._lookup_job(session_id))
    assert job["status"] == "failed"
    assert "REPLICATE_API_TOKEN" in job["error"]
    assert "Create did not return a session id" not in job["error"]
    _aliases(job, session_id)
    assert calls == []
    captured = capsys.readouterr()
    assert "Traceback" in captured.err
    assert "r8_" not in captured.out
    health = client.get("/health")
    assert health.status_code == 200


def test_lyria_404_fails_the_job_without_dropping_the_session(live_dirs, monkeypatch, capsys):
    calls: list = []
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_hybrid")
    monkeypatch.setattr("engine.generate_track_headless.time.sleep", lambda _seconds: None)
    _forbid_ffmpeg(monkeypatch)

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        raise urllib.error.HTTPError(
            req.full_url,
            404,
            "Not Found",
            hdrs=None,
            fp=io.BytesIO(b'{"title":"ModelNotFoundError","detail":"model not found","status":404}'),
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    started: list = []
    client = _client(monkeypatch, started)
    response = client.post(
        "/api/tracks/create",
        data=_fields(),
        files={"voice_sample": ("recording.wav", _reference_bytes(), "audio/wav")},
    )
    assert response.status_code == 200
    body = response.json()
    session_id = body["session_id"]
    _aliases(body, session_id)
    assert body["vocal_present"] is True
    assert not body.get("error")
    runner._worker(*started[-1])
    job = runner._public_job(runner._lookup_job(session_id))
    assert job["status"] == "failed"
    assert "404" in job["error"]
    assert "Create did not return a session id" not in job["error"]
    assert "r8_hybrid" not in job["error"]
    assert job["token_cost"] == 1
    _aliases(job, session_id)
    captured = capsys.readouterr()
    assert "Traceback" in captured.err
    assert "r8_hybrid" not in captured.out
    assert any("lyria-3-pro" in req.full_url for req in calls)
    for req in calls:
        assert "music-01" not in req.full_url
        payload = getattr(req, "data", None) or b""
        if isinstance(payload, str):
            payload = payload.encode()
        assert b"voice_file" not in payload
    health = client.get("/health")
    assert health.status_code == 200
