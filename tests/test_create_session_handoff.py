"""Create responses expose every session-id alias. HTTP is mocked. No Replicate calls."""
from __future__ import annotations

import os
import sys

import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from api import headless_job_runner as runner  # noqa: E402

_PROMPT = "n" * 60
_ALIASES = ("session_id", "sessionId", "track_id", "id")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("HYBRID_WORKER_TOKEN", raising=False)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    monkeypatch.setattr(runner, "SCRATCH_ROOT", str(scratch))
    monkeypatch.setattr(runner, "_API_LOG", str(tmp_path / "api.log"))
    runner._jobs.clear()
    runner._release_generation_claim()
    runner._active_session_id = None

    class _NoThread:
        def __init__(self, target, args, name, daemon):
            pass

        def start(self):
            pass

    monkeypatch.setattr(runner.threading, "Thread", _NoThread)
    from fastapi.testclient import TestClient

    test_client = TestClient(runner.app)
    yield test_client
    runner._jobs.clear()
    runner._release_generation_claim()
    runner._active_session_id = None


def _assert_handoff(body: dict, *, vocal_present: bool) -> str:
    assert body["success"] is True
    assert body["status"] == "pending"
    assert body["token_cost"] == 1
    assert body["vocal_present"] is vocal_present
    session_id = body["session_id"]
    assert isinstance(session_id, str) and session_id.startswith("ht_")
    for key in _ALIASES:
        assert body[key] == session_id
    assert body["status_url"] == f"/api/tracks/status/{session_id}"
    return session_id


def test_lyria_create_payload_includes_every_session_alias(client):
    response = client.post("/api/tracks/create", json={"prompt": _PROMPT, "duration_sec": 60})
    assert response.status_code == 200, response.text
    body = response.json()
    session_id = _assert_handoff(body, vocal_present=False)
    assert body["engine_used"] == "Lyria"
    job = runner._lookup_job(session_id)
    assert job is not None
    assert job["status"] == "queued"
    assert not os.path.isfile(os.path.join(runner.SCRATCH_ROOT, session_id, f"{session_id}_master.wav"))
    polled = client.get(f"/api/tracks/status/{session_id}")
    assert polled.status_code == 200
    status_body = polled.json()
    for key in _ALIASES:
        assert status_body[key] == session_id


def test_vocal_create_payload_includes_every_session_alias(client):
    response = client.post(
        "/api/tracks/create",
        data={"prompt": _PROMPT, "lyrics": "neon rain", "duration": "210"},
        files={"voice_sample": ("recording.wav", b"RIFF" + b"\x00" * 80, "audio/wav")},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    session_id = _assert_handoff(body, vocal_present=True)
    assert body["engine_used"] == "Lyria"
    assert os.path.isfile(os.path.join(runner.SCRATCH_ROOT, session_id, "ref_vocal.wav"))
    assert not os.path.isfile(os.path.join(runner.SCRATCH_ROOT, session_id, f"{session_id}_master.wav"))
    polled = client.get(f"/api/tracks/status/{session_id}")
    assert polled.status_code == 200
    status_body = polled.json()
    for key in _ALIASES:
        assert status_body[key] == session_id
    assert status_body["vocal_present"] is True


def test_scratch_persist_failure_logs_traceback_and_stays_up(client, monkeypatch, capsys):
    def boom(_job):
        raise OSError("scratch directory creation failed")

    monkeypatch.setattr(runner, "_persist_job", boom)
    response = client.post("/api/tracks/create", json={"prompt": _PROMPT})
    assert response.status_code == 500
    assert "could not persist job" in response.text
    captured = capsys.readouterr()
    assert "Traceback" in captured.err
    assert "scratch directory creation failed" in captured.err
    health = client.get("/health")
    assert health.status_code == 200
