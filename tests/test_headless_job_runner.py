"""Tests for the live API worker: publishing, timeouts, slots, Module 5 delivery."""
from __future__ import annotations

import json
import os
import sys
import threading
import time

import numpy as np
import pytest
import soundfile as sf

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from api import headless_job_runner as runner  # noqa: E402

SR = 22050
SESSION = "ht_testsession01"
STEMS = ("drums.wav", "bass.wav", "rhythm_guitar.wav", "lead_guitar.wav", "synth.wav", "vocals.wav")


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
    monkeypatch.delenv("HYBRID_KEEP_SCRATCH", raising=False)
    return scratch, assets


def test_sanitize_filename_allows_manifest_and_zip_only_when_safe():
    assert runner._sanitize_filename(f"{SESSION}_manifest.json") == f"{SESSION}_manifest.json"
    assert runner._sanitize_filename(f"{SESSION}_stems_bundle.zip")
    assert runner._sanitize_filename("x.exe") is None
    assert runner._sanitize_filename("../x.json") is None
    assert runner._sanitize_filename("a/b.zip") is None


def _touch(path, data=b"x"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


def test_publish_maps_nested_stems_bundle_and_manifest(live_dirs, tmp_path):
    _scratch, assets = live_dirs
    pkg = tmp_path / "pkg"
    for name in ("master.wav", "master.mp3", "manifest.json", f"{SESSION}_stems_bundle.zip"):
        _touch(str(pkg / name))
    for stem in STEMS:
        _touch(str(pkg / "stems" / stem))
    published = runner._publish_delivery_package(SESSION, str(pkg))
    assert published["zip_url"] == f"/api/stream/{SESSION}_stems_bundle.zip"
    assert published["manifest_url"] == f"/api/stream/{SESSION}_manifest.json"
    assert published["master_url"] == f"/api/stream/{SESSION}_master.wav"
    assert set(published["stem_urls"]) == set(STEMS)
    for stem, url in published["stem_urls"].items():
        name = url.rsplit("/", 1)[-1]
        assert name == f"{SESSION}_{stem}"
        assert os.path.isfile(assets / name)
        assert runner._resolve_stream_path(name) == str(assets / name)
    assert runner._resolve_stream_path(f"{SESSION}_manifest.json") == str(
        assets / f"{SESSION}_manifest.json"
    )


def test_publish_maps_legacy_delivery_zip(live_dirs, tmp_path):
    pkg = tmp_path / "legacy"
    _touch(str(pkg / "delivery.zip"))
    _touch(str(pkg / "drums.wav"))
    published = runner._publish_delivery_package(SESSION, str(pkg))
    assert published["zip_url"] == f"/api/stream/{SESSION}_stems_bundle.zip"
    assert published["stem_urls"] == {"drums.wav": f"/api/stream/{SESSION}_drums.wav"}


def test_run_step_timeout_kills_and_raises():
    start = time.monotonic()
    with pytest.raises(RuntimeError, match="timed out after 1s"):
        runner._run([sys.executable, "-c", "import time; time.sleep(30)"], timeout=1)
    assert time.monotonic() - start < 15


def _write_session(scratch, *, with_bus_stems: bool, bpm: float = 124.0, seed: int = 9):
    sdir = scratch / SESSION
    sdir.mkdir(parents=True, exist_ok=True)
    n = SR * 3
    t = np.arange(n) / SR
    buses = {
        "rhythm": 0.3 * np.sign(np.sin(2 * np.pi * 2.0 * t)) * np.exp(-((t * 8) % 1) * 6),
        "bass": 0.3 * np.sin(2 * np.pi * 55.0 * t),
        "harmonic": 0.2 * np.sin(2 * np.pi * 329.63 * t),
        "vocal": 0.2 * np.sin(2 * np.pi * 440.0 * t),
    }
    buses = {k: np.column_stack((v, v)) for k, v in buses.items()}
    mix = sum(buses.values())
    sf.write(str(sdir / "unmastered_mix.wav"), mix, SR, subtype="PCM_24")
    if with_bus_stems:
        (sdir / "bus_stems").mkdir()
        for name, audio in buses.items():
            sf.write(str(sdir / "bus_stems" / f"{name}.wav"), audio, SR, subtype="FLOAT")
    plan = {"title": "t", "key": "E", "scale": "minor", "bpm": bpm, "seed": seed, "sections": []}
    (sdir / f"{SESSION}_blueprint.json").write_text(
        json.dumps({"track_metadata": {"bpm": bpm}, "arrangement": {"song_plan": plan}}),
        encoding="utf-8",
    )
    return buses


def test_module5_refuses_to_fabricate_stems(live_dirs):
    scratch, _assets = live_dirs
    _write_session(scratch, with_bus_stems=False)
    with pytest.raises(RuntimeError, match="No bus stems found; refusing to package fabricated stems"):
        runner._try_module5_delivery(SESSION, "prompt", "rock")


def test_module5_packages_real_bus_stems_with_plan_bpm_and_seed(live_dirs, monkeypatch):
    scratch, _assets = live_dirs
    buses = _write_session(scratch, with_bus_stems=True, bpm=124.0, seed=9)

    import engine.provenance_guard as pg

    seen: dict[str, float] = {}
    real_guard = pg.ProvenanceGuard

    class SpyGuard(real_guard):
        def __init__(self, *args, **kwargs):
            seen["bpm"] = kwargs.get("bpm")
            super().__init__(*args, **kwargs)

        def check(self, master, *, stems=None, seed=0, auto_remediate=True):
            seen["seed"] = seed
            seen["stems"] = sorted(stems or {})
            return super().check(master, stems=stems, seed=seed, auto_remediate=auto_remediate)

    monkeypatch.setattr(pg, "ProvenanceGuard", SpyGuard)
    fields = runner._try_module5_delivery(SESSION, "prompt", "rock")
    assert seen == {"bpm": 124.0, "seed": 9, "stems": ["bass", "harmonic", "rhythm", "vocal"]}
    assert fields["zip_url"].endswith(f"{SESSION}_stems_bundle.zip")
    assert fields["manifest_url"].endswith(f"{SESSION}_manifest.json")
    assert set(fields["stem_urls"]) == set(STEMS)

    pkg = scratch.parent / "deliveries" / SESSION
    assert fields["package_dir"] == str(pkg)
    manifest = json.loads((pkg / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["song_plan"]["bpm"] == 124.0
    assert manifest["source"] == "blueprint_bus_stems"
    drums, _ = sf.read(str(pkg / "stems" / "drums.wav"), always_2d=True)
    master, _ = sf.read(str(pkg / "master.wav"), always_2d=True)
    rhythm = buses["rhythm"][:, 0]

    def corr(a, b):
        return float(np.corrcoef(a, b)[0, 1])

    # drums.wav is the rhythm bus, not the master's left channel.
    assert corr(drums[:, 0], rhythm) > 0.99
    assert corr(drums[:, 0], master[:, 0]) < 0.9


def _seed_job(scratch):
    job = {"session_id": SESSION, "status": "queued", "genre_hint": "rock", "error": None}
    with runner._registry_lock:
        runner._jobs[SESSION] = job
    runner._persist_job(job)


def test_worker_marks_job_failed_when_module5_fails(live_dirs, monkeypatch):
    scratch, _assets = live_dirs
    _seed_job(scratch)
    import engine.worker_handoff as handoff

    monkeypatch.setattr(runner, "resolve_workstation_python", lambda: sys.executable)
    monkeypatch.setattr(runner, "_run_headless", lambda *a, **k: None)
    monkeypatch.setattr(
        handoff,
        "assert_handoff_ready",
        lambda *_a: {"mix": "m.wav", "mix_bytes": 1, "slice_count": 1},
    )
    monkeypatch.setattr(runner, "_publish_audio", lambda sid, _p: (f"{sid}.wav", "audio/wav"))
    monkeypatch.setattr(runner, "_run_master_pipeline", lambda *a: None)
    monkeypatch.setattr(runner, "_attach_master", lambda sid: (f"{sid}_m.wav", "audio/wav"))

    def boom(*_a):
        raise RuntimeError("No bus stems found; refusing to package fabricated stems")

    monkeypatch.setattr(runner, "_try_module5_delivery", boom)
    runner._worker(SESSION, "prompt", "rock", False)
    job = runner._lookup_job(SESSION)
    public = runner._public_job(job)
    assert public["status"] == "failed"
    assert public["delivery_status"] == "failed"
    assert "refusing to package fabricated stems" in public["delivery_error"]
    assert public["error"].startswith("Module 5 delivery failed")
    assert public["audio_filename"] == f"{SESSION}_m.wav"


def test_worker_reports_loudness_compliance_failure(live_dirs, monkeypatch):
    scratch, _assets = live_dirs
    _seed_job(scratch)
    import engine.worker_handoff as handoff
    from engine.mastering_bus import LoudnessComplianceError

    monkeypatch.setattr(runner, "resolve_workstation_python", lambda: sys.executable)
    monkeypatch.setattr(runner, "_run_headless", lambda *a, **k: None)
    monkeypatch.setattr(
        handoff,
        "assert_handoff_ready",
        lambda *_a: {"mix": "m.wav", "mix_bytes": 1, "slice_count": 1},
    )
    monkeypatch.setattr(runner, "_publish_audio", lambda sid, _p: (f"{sid}.wav", "audio/wav"))
    monkeypatch.setattr(runner, "_run_master_pipeline", lambda *a: None)
    monkeypatch.setattr(runner, "_attach_master", lambda sid: (f"{sid}_m.wav", "audio/wav"))

    def under_driven(*_a):
        raise LoudnessComplianceError(-15.37, -14.0, 0.5, push_capped=True)

    monkeypatch.setattr(runner, "_try_module5_delivery", under_driven)
    _touch(str(scratch / SESSION / "unmastered_mix.wav"), b"x" * 10)
    runner._worker(SESSION, "prompt", "rock", False)
    public = runner._public_job(runner._lookup_job(SESSION))
    assert public["status"] == "failed"
    assert public["delivery_status"] == "failed"
    assert public["delivery_error"] == "Loudness compliance failed: -15.37 LUFS"
    # Failed jobs keep scratch audio for debugging.
    assert (scratch / SESSION / "unmastered_mix.wav").is_file()


def test_module5_gate_blocks_packaging_of_non_compliant_master(live_dirs, monkeypatch):
    scratch, _assets = live_dirs
    _write_session(scratch, with_bus_stems=True)
    import engine.mastering_bus as mb

    # -5 LUFS at a -1 dBTP ceiling with no limiter push is unreachable.
    bp_path = scratch / SESSION / f"{SESSION}_blueprint.json"
    blueprint = json.loads(bp_path.read_text(encoding="utf-8"))
    blueprint["arrangement"]["song_plan"]["master_lufs_target"] = -5.0
    bp_path.write_text(json.dumps(blueprint), encoding="utf-8")
    monkeypatch.setattr(mb, "MAX_LIMITER_PUSH_DB", 0.0)
    with pytest.raises(mb.LoudnessComplianceError):
        runner._try_module5_delivery(SESSION, "prompt", "rock")
    assert not (scratch.parent / "deliveries" / SESSION / "manifest.json").exists()


def test_worker_completes_job_with_delivery_fields(live_dirs, monkeypatch):
    scratch, _assets = live_dirs
    _seed_job(scratch)
    import engine.worker_handoff as handoff

    monkeypatch.setattr(runner, "resolve_workstation_python", lambda: sys.executable)
    monkeypatch.setattr(runner, "_run_headless", lambda *a, **k: None)
    monkeypatch.setattr(
        handoff,
        "assert_handoff_ready",
        lambda *_a: {"mix": "m.wav", "mix_bytes": 1, "slice_count": 1},
    )
    monkeypatch.setattr(runner, "_publish_audio", lambda sid, _p: (f"{sid}.wav", "audio/wav"))
    monkeypatch.setattr(runner, "_run_master_pipeline", lambda *a: None)
    monkeypatch.setattr(runner, "_attach_master", lambda sid: (f"{sid}_m.wav", "audio/wav"))
    # The real _try_module5_delivery returns audio_filename/audio_mime (from
    # _publish_delivery_package); they must not collide with the explicit kwargs.
    monkeypatch.setattr(
        runner,
        "_try_module5_delivery",
        lambda *_a: {
            "audio_filename": f"{SESSION}_master.wav",
            "audio_mime": "audio/wav",
            "master_url": f"/api/stream/{SESSION}_master.wav",
            "zip_url": f"/api/stream/{SESSION}_stems_bundle.zip",
        },
    )
    sdir = scratch / SESSION
    (sdir / "session_slices").mkdir(parents=True, exist_ok=True)
    (sdir / "bus_stems").mkdir(exist_ok=True)
    _touch(str(sdir / "session_slices" / "rhythm_a.wav"), b"x" * 1000)
    _touch(str(sdir / "bus_stems" / "bass.wav"), b"x" * 2000)
    _touch(str(sdir / "unmastered_mix.wav"), b"x" * 3000)
    _touch(str(sdir / f"{SESSION}_blueprint.json"), b"{}")

    runner._worker(SESSION, "prompt", "rock", False)
    public = runner._public_job(runner._lookup_job(SESSION))
    assert public["status"] == "completed", public.get("error")
    assert public["delivery_status"] == "completed"
    assert public["delivery_error"] is None
    assert public["audio_filename"] == f"{SESSION}_master.wav"
    assert public["zip_url"].endswith("_stems_bundle.zip")
    # Scratch audio purged after delivery; JSON (job, blueprint) retained.
    assert public["scratch_purged_bytes"] == 6000
    assert not list(sdir.rglob("*.wav"))
    assert not (sdir / "session_slices").exists()
    assert (sdir / f"{SESSION}_blueprint.json").is_file()
    assert (sdir / "job.json").is_file()


def test_scratch_purge_is_skipped_on_request_and_on_failure(live_dirs, monkeypatch):
    scratch, _assets = live_dirs
    sdir = scratch / SESSION
    _touch(str(sdir / "unmastered_mix.wav"), b"x" * 10)
    monkeypatch.setenv("HYBRID_KEEP_SCRATCH", "1")
    assert runner._purge_scratch_audio(SESSION) == 0
    assert (sdir / "unmastered_mix.wav").is_file()
    monkeypatch.delenv("HYBRID_KEEP_SCRATCH")
    assert runner._purge_scratch_audio(SESSION) == 10


def test_publish_hard_links_instead_of_copying(live_dirs, tmp_path):
    _scratch, assets = live_dirs
    pkg = tmp_path / "pkg"
    _touch(str(pkg / "master.wav"), b"RIFF" + b"\0" * 100)
    runner._publish_delivery_package(SESSION, str(pkg))
    published = assets / f"{SESSION}_master.wav"
    assert os.path.samefile(published, pkg / "master.wav")
    # Re-publishing replaces the link cleanly.
    runner._publish_delivery_package(SESSION, str(pkg))
    assert os.path.samefile(published, pkg / "master.wav")


def test_create_accepts_bars_with_bpm_and_jobs_alias(live_dirs, monkeypatch):
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    monkeypatch.delenv("HYBRID_WORKER_TOKEN", raising=False)
    started: list[tuple] = []

    class _NoThread:
        def __init__(self, target, args, name, daemon):
            started.append(args)

        def start(self):
            pass

    monkeypatch.setattr(runner.threading, "Thread", _NoThread)
    client = TestClient(runner.app)
    bad = client.post("/api/tracks/create", json={"prompt": "x", "bars": 32})
    assert bad.status_code == 400 and "bars requires bpm" in bad.text
    ok = client.post("/api/tracks/create", json={"prompt": "x", "bars": 32, "bpm": 120})
    assert ok.status_code == 200
    session_id = ok.json()["session_id"]
    opts = started[-1][-1]
    assert opts == {"bpm": 120.0, "duration_sec": pytest.approx(64.0)}
    status = client.get(f"/api/jobs/{session_id}")
    assert status.status_code == 200
    body = status.json()
    assert body["requested_bars"] == 32 and body["requested_bpm"] == 120.0


def test_render_slots_cap_concurrent_jobs(monkeypatch):
    monkeypatch.setattr(runner, "_RENDER_SLOTS", threading.BoundedSemaphore(2))
    monkeypatch.setattr(runner, "_update_job", lambda *a, **k: {})
    gate = threading.Event()
    active = {"now": 0, "max": 0}
    lock = threading.Lock()

    def fake_inner(*_a):
        with lock:
            active["now"] += 1
            active["max"] = max(active["max"], active["now"])
        gate.wait(5)
        with lock:
            active["now"] -= 1

    monkeypatch.setattr(runner, "_worker_inner", fake_inner)
    threads = [
        threading.Thread(target=runner._worker, args=(f"ht_{i}", "p", "g", False))
        for i in range(4)
    ]
    for th in threads:
        th.start()
    time.sleep(0.5)
    with lock:
        assert active["now"] == 2
    gate.set()
    for th in threads:
        th.join(5)
    assert active["max"] == 2
