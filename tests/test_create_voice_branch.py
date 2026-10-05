"""Create-route branch: pinned music-01 when voice_sample is present, Lyria otherwise.

HTTP is mocked. Nothing is sent to Replicate.
"""
from __future__ import annotations

import io
import json
import os
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
from services.voice_service import PREDICTIONS_URL, VOICE_AUDIO_FIELD, VOICE_LYRICS_FIELD, VOICE_VERSION  # noqa: E402


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
    started: list = []
    client = _client(monkeypatch, started)
    # Multipart with no voice_sample field. Filename recording.wav is not sent.
    response = client.post("/api/tracks/create", data=_fields(), files={"note": (None, "")})
    assert response.status_code == 200
    body = response.json()
    assert body["engine_used"] == "Lyria"
    assert body["token_cost"] == 1
    assert body["status"] == "pending"
    session_id = body["session_id"]
    assert session_id.startswith("ht_") and len(session_id) == 15
    opts = started[-1][-1]
    assert "voice_sample_path" not in opts
    assert opts["duration_sec"] == pytest.approx(210.0)
    runner._worker(*started[-1])
    job = runner._public_job(runner._lookup_job(session_id))
    assert job["status"] == "completed", job.get("error")
    assert job["engine_used"] == "Lyria"
    assert job["token_cost"] == 1
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
    assert (scratch / session_id / f"{session_id}_master.wav").is_file()


def test_create_with_recording_wav_writes_master_from_one_prediction(live_dirs, monkeypatch):
    scratch, assets = live_dirs
    audio = _gate_wav()
    take = _reference_bytes()
    file_url = "https://api.replicate.com/v1/files/file_take"
    audio_url = "https://replicate.delivery/pb/heart.wav"
    responses = [
        _json_resp({"id": "file_take", "urls": {"get": file_url}}),
        _json_resp({"id": "pred_heart", "status": "succeeded", "output": audio_url}),
        _Resp(audio, {"Content-Type": "audio/wav"}),
    ]
    calls: list = []
    _install_http(monkeypatch, responses, calls)
    started: list = []
    client = _client(monkeypatch, started)
    response = client.post(
        "/api/tracks/create",
        data=_fields(),
        files={"voice_sample": ("recording.wav", take, "audio/wav")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["engine_used"] == "HeartMuLa"
    assert body["token_cost"] == 1
    session_id = body["session_id"]
    ref = scratch / session_id / "ref_vocal.wav"
    assert ref.is_file()
    assert ref.read_bytes() == take
    assert not (scratch / session_id / "recording.wav").exists()
    runner._worker(*started[-1])
    job = runner._public_job(runner._lookup_job(session_id))
    assert job["status"] == "completed", job.get("error")
    assert job["engine_used"] == "HeartMuLa"
    assert job["token_cost"] == 1
    master = scratch / session_id / f"{session_id}_master.wav"
    assert master.is_file()
    assert master.read_bytes() == audio
    assert (assets / f"{session_id}_master.wav").is_file()
    urls = [req.full_url for req in calls]
    assert not any("lyria" in url.lower() or "chatterbox" in url.lower() or "heart_mula" in url for url in urls)
    voice_posts = [req for req in calls if "music-01" in req.full_url and "/predictions" in req.full_url]
    assert len(voice_posts) == 1
    assert voice_posts[0].full_url == PREDICTIONS_URL
    assert VOICE_VERSION in voice_posts[0].full_url
    sent = json.loads(voice_posts[0].data.decode("utf-8"))
    assert sent["input"][VOICE_AUDIO_FIELD] == file_url
    assert sent["input"][VOICE_LYRICS_FIELD] == "neon rain"
    assert "prompt" not in sent["input"]
    assert "audio" not in sent["input"]
    assert "text" not in sent["input"]
    assert take in calls[0].data
    assert b'filename="ref_vocal.wav"' in calls[0].data


def test_heart_mula_failure_is_a_job_error_and_does_not_crash(live_dirs, monkeypatch):
    scratch, _assets = live_dirs
    responses = [
        _json_resp({"urls": {"get": "https://api.replicate.com/v1/files/file_fail"}}),
        _json_resp({"id": "pred_fail", "status": "failed", "error": "model exploded"}),
    ]
    calls: list = []
    _install_http(monkeypatch, responses, calls)
    started: list = []
    client = _client(monkeypatch, started)
    response = client.post(
        "/api/tracks/create",
        data=_fields(),
        files={"voice_sample": ("recording.wav", _reference_bytes(), "audio/wav")},
    )
    assert response.status_code == 200
    session_id = response.json()["session_id"]
    runner._worker(*started[-1])
    job = runner._public_job(runner._lookup_job(session_id))
    assert job["status"] == "failed"
    assert job["error"].startswith("Voice API failed:")
    assert job["detail"] == job["error"]
    assert "model exploded" in job["error"]
    assert job["engine_used"] == "HeartMuLa"
    assert job["token_cost"] == 1
    assert (scratch / session_id / "ref_vocal.wav").is_file()
    assert not (scratch / session_id / f"{session_id}_master.wav").is_file()
    urls = [req.full_url for req in calls]
    assert not any("lyria" in url.lower() or "chatterbox" in url.lower() for url in urls)
    health = client.get("/health")
    assert health.status_code == 200


def test_missing_token_does_not_call_replicate(live_dirs, monkeypatch, capsys):
    calls: list = []
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.delenv("REPLICATE_API_TOKEN", raising=False)
    monkeypatch.delenv("REPLICATE_API_KEY", raising=False)

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
    assert body["sessionId"] == session_id
    runner._worker(*started[-1])
    job = runner._public_job(runner._lookup_job(session_id))
    assert job["status"] == "failed"
    assert "Voice API failed:" in job["error"]
    assert "REPLICATE_API_TOKEN" in job["error"]
    assert job["detail"] == job["error"]
    assert calls == []
    captured = capsys.readouterr()
    assert "CRITICAL REPLICATE ERROR: MissingToken - REPLICATE_API_TOKEN is not configured" in captured.out
    assert "r8_" not in captured.out


def test_model_host_404_is_voice_api_failed(live_dirs, monkeypatch, capsys):
    calls: list = []
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_hybrid")
    monkeypatch.setattr("services.voice_service.time.sleep", lambda _seconds: None)

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        if req.full_url.endswith("/files") and req.get_method() == "POST":
            return _json_resp({"urls": {"get": "https://api.replicate.com/v1/files/file_404"}})
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
    assert session_id.startswith("ht_")
    assert not body.get("error")
    runner._worker(*started[-1])
    job = runner._public_job(runner._lookup_job(session_id))
    assert job["status"] == "failed"
    assert job["error"].startswith("Voice API failed:")
    assert "404" in job["error"]
    assert "ModelNotFoundError" in job["error"]
    assert "r8_hybrid" not in job["error"]
    assert job["token_cost"] == 1
    captured = capsys.readouterr()
    assert "CRITICAL REPLICATE ERROR:" in captured.out
    assert "r8_hybrid" not in captured.out
    assert not any("lyria" in req.full_url.lower() for req in calls)
    health = client.get("/health")
    assert health.status_code == 200
