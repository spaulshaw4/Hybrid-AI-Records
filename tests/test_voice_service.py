"""HeartMuLa voice track. HTTP is mocked; nothing is sent to Replicate."""
from __future__ import annotations

import json
import os
import sys
import urllib.request

import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from services.voice_service import (  # noqa: E402
    FILES_URL,
    PREDICTIONS_URL,
    VOICE_VERSION,
    VoiceInputError,
    process_voice_track,
)


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


def _reference_bytes() -> bytes:
    return b"RIFF" + b"\x00" * 80


def _install_http(monkeypatch, responses: list, calls: list):
    monkeypatch.setattr("engine.gemini_arranger._load_env_quiet", lambda: None)
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_hybrid")
    monkeypatch.setenv("LYRIC_ENGINE_API_KEY", "r8_lyric")
    monkeypatch.setenv("ENGINE_API_KEY", "r8_lyric")

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        assert timeout is not None and timeout > 0
        if not responses:
            raise AssertionError(f"unexpected HTTP call to {req.full_url}")
        return responses.pop(0)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)


def test_bad_input_does_not_call_the_model(tmp_path, monkeypatch):
    calls: list = []
    _install_http(monkeypatch, [], calls)
    monkeypatch.setattr("services.voice_service.SCRATCH_ROOT", str(tmp_path))
    reference = tmp_path / "take.wav"
    reference.write_bytes(_reference_bytes())

    with pytest.raises(VoiceInputError, match="lyrics"):
        process_voice_track(str(reference), "  ", "ht_voice01")
    with pytest.raises(VoiceInputError, match="missing"):
        process_voice_track(str(tmp_path / "missing.wav"), "neon rain", "ht_voice01")
    for bad_session in ("", ".", "..", "ht/evil", r"ht\evil", "ht.voice"):
        with pytest.raises(VoiceInputError, match="session"):
            process_voice_track(str(reference), "neon rain", bad_session)
    assert calls == []


def test_mocked_output_url_is_saved_under_scratch(tmp_path, monkeypatch):
    monkeypatch.setattr("services.voice_service.SCRATCH_ROOT", str(tmp_path))
    audio = b"RIFFmock-vocal-bytes" + b"\x00" * 32
    file_url = "https://api.replicate.com/v1/files/file_test"
    audio_url = "https://replicate.delivery/pb/out.wav"
    poll_url = "https://api.replicate.com/v1/predictions/pred_voice"
    responses = [
        _json_resp({"id": "file_test", "urls": {"get": file_url}}),
        _json_resp(
            {
                "id": "pred_voice",
                "status": "processing",
                "urls": {"get": poll_url},
            }
        ),
        _json_resp({"id": "pred_voice", "status": "succeeded", "output": [audio_url]}),
        _Resp(audio, {"Content-Type": "audio/wav"}),
    ]
    calls: list = []
    _install_http(monkeypatch, responses, calls)
    slept: list[float] = []
    monkeypatch.setattr("services.voice_service.time.sleep", lambda seconds: slept.append(seconds))

    reference = tmp_path / "take.wav"
    reference.write_bytes(_reference_bytes())
    saved = process_voice_track(str(reference), "neon rain", "ht_voice01")

    assert saved == str(tmp_path / "ht_voice01" / "ht_voice01_vocal.wav")
    assert os.path.isfile(saved)
    with open(saved, "rb") as handle:
        assert handle.read() == audio
    assert slept == [2.0]
    assert calls[0].full_url == FILES_URL
    assert calls[0].get_method() == "POST"
    assert calls[0].get_header("Authorization") == "Bearer r8_hybrid"
    assert "r8_lyric" not in (calls[0].get_header("Authorization") or "")
    assert b'name="content"' in calls[0].data
    assert _reference_bytes() in calls[0].data
    assert calls[1].full_url == PREDICTIONS_URL
    assert VOICE_VERSION in calls[1].full_url
    assert "/versions/" in calls[1].full_url
    assert calls[1].get_header("Authorization") == "Bearer r8_hybrid"
    assert calls[1].get_header("Prefer") == "wait"
    assert calls[1].get_header("User-agent") == "hybrid-voice/1.0"
    assert json.loads(calls[1].data.decode("utf-8")) == {
        "input": {"voice_file": file_url, "lyrics": "neon rain"}
    }
    assert calls[2].full_url == poll_url
    assert calls[2].get_method() == "GET"
    assert calls[3].full_url == audio_url
    assert calls[3].get_method() == "GET"


def _route_client(monkeypatch, tmp_path, responses: list, calls: list):
    monkeypatch.setattr("services.voice_service.SCRATCH_ROOT", str(tmp_path))
    monkeypatch.delenv("HYBRID_WORKER_TOKEN", raising=False)
    _install_http(monkeypatch, responses, calls)
    from fastapi.testclient import TestClient

    from api import headless_job_runner as runner

    # Route failures must not append to the live API log.
    monkeypatch.setattr(runner, "_log", lambda _msg: None)
    monkeypatch.setattr(runner, "_API_LOG", str(tmp_path / "api.log"))
    return TestClient(runner.app)


def test_route_returns_ready_and_vocal_path(tmp_path, monkeypatch):
    audio = b"RIFFroute-vocal" + b"\x00" * 24
    file_url = "https://api.replicate.com/v1/files/file_route"
    audio_url = "https://replicate.delivery/pb/route.wav"
    responses = [
        _json_resp({"urls": {"get": file_url}}),
        _json_resp({"id": "pred_route", "status": "succeeded", "output": audio_url}),
        _Resp(audio),
    ]
    calls: list = []
    client = _route_client(monkeypatch, tmp_path, responses, calls)
    response = client.post(
        "/api/voice/process",
        data={"lyrics": "neon rain", "session_id": "ht_voice01"},
        files={"file": ("take.wav", _reference_bytes(), "audio/wav")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["vocal_path"].endswith(os.path.join("ht_voice01", "ht_voice01_vocal.wav"))
    assert os.path.isfile(body["vocal_path"])
    with open(body["vocal_path"], "rb") as handle:
        assert handle.read() == audio
    assert VOICE_VERSION in calls[1].full_url


def test_route_rejects_missing_input_without_calling_the_model(tmp_path, monkeypatch):
    calls: list = []

    def boom(req, timeout=None):
        calls.append(req)
        raise AssertionError("model was called")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    monkeypatch.setattr("services.voice_service.SCRATCH_ROOT", str(tmp_path))
    monkeypatch.delenv("HYBRID_WORKER_TOKEN", raising=False)
    from fastapi.testclient import TestClient

    from api import headless_job_runner as runner

    monkeypatch.setattr(runner, "_log", lambda _msg: None)
    monkeypatch.setattr(runner, "_API_LOG", str(tmp_path / "api.log"))
    client = TestClient(runner.app)
    empty_lyrics = client.post(
        "/api/voice/process",
        data={"lyrics": "   "},
        files={"file": ("take.wav", _reference_bytes(), "audio/wav")},
    )
    missing_file = client.post("/api/voice/process", data={"lyrics": "neon rain"})
    bad_session = client.post(
        "/api/voice/process",
        data={"lyrics": "neon rain", "session_id": ".."},
        files={"file": ("take.wav", _reference_bytes(), "audio/wav")},
    )
    assert empty_lyrics.status_code == 400
    assert empty_lyrics.json()["status"] == "error"
    assert "lyrics" in empty_lyrics.json()["error"]
    assert missing_file.status_code == 400
    assert "file" in missing_file.json()["error"]
    assert bad_session.status_code == 400
    assert calls == []


def test_route_turns_a_replicate_error_into_json(tmp_path, monkeypatch):
    responses = [
        _json_resp({"urls": {"get": "https://api.replicate.com/v1/files/file_fail"}}),
        _json_resp({"id": "pred_fail", "status": "failed", "error": "model exploded"}),
    ]
    calls: list = []
    client = _route_client(monkeypatch, tmp_path, responses, calls)
    response = client.post(
        "/api/voice/process",
        data={"lyrics": "neon rain", "session_id": "ht_voice01"},
        files={"file": ("take.wav", _reference_bytes(), "audio/wav")},
    )
    assert response.status_code == 502
    body = response.json()
    assert body["status"] == "error"
    assert "failed" in body["error"]
    assert "r8_hybrid" not in body["error"]
    assert not os.path.isfile(tmp_path / "ht_voice01" / "ht_voice01_vocal.wav")
    assert calls
