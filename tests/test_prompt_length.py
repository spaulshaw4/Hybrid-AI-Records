"""Composition prompt cap on POST /api/tracks/create.

The worker thread is replaced so a long prompt is accepted or rejected
without starting Lyria or HeartMuLa.
"""
from __future__ import annotations

import os
import sys

import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from api import headless_job_runner as runner  # noqa: E402
from engine.generate_track_headless import compose_lyria_prompt  # noqa: E402


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
    runner._jobs.clear()
    runner._release_generation_claim()
    runner._active_session_id = None
    return scratch, assets


def _reset_queue() -> None:
    with runner._registry_lock:
        runner._jobs.clear()
    runner._release_generation_claim()
    runner._active_session_id = None


def _forbid_paid_render(*_args, **_kwargs):
    raise AssertionError("paid render started")


def test_prompt_cap_is_5000_and_lyrics_max_stays_5000():
    assert runner.MIN_PROMPT == 50
    assert runner.MAX_PROMPT == 5000
    assert runner.LYRICS_MAX == 5000
    assert runner.PROMPT_TOO_SHORT == "Prompt must be at least 50 characters."


def test_create_accepts_prompt_up_to_5000_and_rejects_5001(live_dirs, monkeypatch):
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    monkeypatch.delenv("HYBRID_WORKER_TOKEN", raising=False)
    monkeypatch.setattr(
        "engine.generate_track_headless.render_lyria_master",
        _forbid_paid_render,
    )
    monkeypatch.setattr(
        "services.voice_service.render_heart_mula_master",
        _forbid_paid_render,
        raising=False,
    )
    started: list[tuple] = []

    class _NoThread:
        def __init__(self, target, args, name, daemon):
            started.append(args)

        def start(self):
            pass

    monkeypatch.setattr(runner.threading, "Thread", _NoThread)
    client = TestClient(runner.app)

    _reset_queue()
    before_short = len(started)
    too_short = client.post(
        "/api/tracks/create",
        json={"prompt": "q" * 49, "lyrics": "l" * 2000},
    )
    assert too_short.status_code == 400
    assert too_short.json()["detail"] == "Prompt must be at least 50 characters."
    assert len(started) == before_short

    _reset_queue()
    prompt_50 = "b" * 50
    at_min = client.post(
        "/api/tracks/create",
        json={"prompt": prompt_50, "lyrics": "short lyric"},
    )
    assert at_min.status_code == 200, at_min.text
    assert started[-1][1] == prompt_50
    assert started[-1][4]["lyrics"] == "short lyric"

    _reset_queue()
    prompt_499 = "c" * 499
    mid_low = client.post("/api/tracks/create", json={"prompt": prompt_499})
    assert mid_low.status_code == 200, mid_low.text
    assert started[-1][1] == prompt_499

    _reset_queue()
    prompt_500 = "d" * 500
    mid_500 = client.post("/api/tracks/create", json={"prompt": prompt_500})
    assert mid_500.status_code == 200, mid_500.text
    assert started[-1][1] == prompt_500

    _reset_queue()
    prompt_2001 = "a" * 2001
    accepted = client.post("/api/tracks/create", json={"prompt": prompt_2001})
    assert accepted.status_code == 200, accepted.text
    assert started[-1][1] == prompt_2001

    _reset_queue()
    prompt_1200 = "p" * 1200
    lyrics_1800 = "l" * 1800
    combined = client.post(
        "/api/tracks/create",
        json={"prompt": prompt_1200, "lyrics": lyrics_1800},
    )
    assert combined.status_code == 200, combined.text
    assert started[-1][1] == prompt_1200
    assert started[-1][4]["lyrics"] == lyrics_1800
    composed = compose_lyria_prompt("", prompt_1200, lyrics_1800)
    assert composed == f"{prompt_1200}\n\n{lyrics_1800}"
    assert len(composed) == 3002

    _reset_queue()
    prompt_3000 = "m" * 3000
    mid = client.post("/api/tracks/create", json={"prompt": prompt_3000})
    assert mid.status_code == 200, mid.text
    assert started[-1][1] == prompt_3000
    assert compose_lyria_prompt("", prompt_3000, "") == prompt_3000

    _reset_queue()
    at_cap = client.post("/api/tracks/create", json={"prompt": "z" * 5000})
    assert at_cap.status_code == 200, at_cap.text
    assert len(started[-1][1]) == 5000

    _reset_queue()
    before = len(started)
    rejected = client.post("/api/tracks/create", json={"prompt": "q" * 5001})
    assert rejected.status_code == 400
    assert rejected.json()["detail"] == "prompt exceeds 5000 characters"
    assert len(started) == before
