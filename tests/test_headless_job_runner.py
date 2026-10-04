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
    runner._jobs.clear()
    runner._release_generation_claim()
    runner._active_session_id = None
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


def _forbid_lane_bounce(monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("13-lane generate path ran")

    monkeypatch.setattr(runner, "_run_headless", boom)
    monkeypatch.setattr(runner, "_run_master_pipeline", boom)
    monkeypatch.setattr(runner, "_try_module5_delivery", boom)
    monkeypatch.setattr(
        "engine.blueprint_track_assembler.assemble_arranged_buses",
        boom,
    )
    monkeypatch.setattr(
        "engine.blueprint_track_assembler._bounce_console_lanes",
        boom,
    )
    monkeypatch.setattr("engine.generate_track_headless.assemble_from_blueprint", boom)


def test_worker_marks_job_failed_when_lyria_fails(live_dirs, monkeypatch):
    scratch, _assets = live_dirs
    _seed_job(scratch)
    _forbid_lane_bounce(monkeypatch)

    def fail(*_a, **_k):
        raise RuntimeError("Lyria prediction failed: mocked")

    monkeypatch.setattr("engine.generate_track_headless.render_lyria_master", fail)
    runner._worker(SESSION, "prompt", "rock", False, {"style": "dark synth", "lyrics": "line"})
    public = runner._public_job(runner._lookup_job(SESSION))
    assert public["status"] == "failed"
    assert "Lyria prediction failed" in public["error"]
    assert public.get("master_url") in {None, ""}
    assert public.get("audio_filename") in {None, ""}


def test_worker_does_not_run_the_mastering_bus(live_dirs, monkeypatch):
    """A Lyria failure must not fall through into Module 5 / the limiter."""
    scratch, _assets = live_dirs
    _seed_job(scratch)
    _forbid_lane_bounce(monkeypatch)

    def fail(*_a, **_k):
        raise RuntimeError("Lyria prediction canceled: mocked")

    monkeypatch.setattr("engine.generate_track_headless.render_lyria_master", fail)
    runner._worker(SESSION, "prompt", "rock", False)
    public = runner._public_job(runner._lookup_job(SESSION))
    assert public["status"] == "failed"
    assert "canceled" in public["error"]
    assert "delivery_status" not in public or public.get("delivery_status") in {None, ""}


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


def test_worker_completes_job_with_lyria_master_urls(live_dirs, monkeypatch):
    scratch, assets = live_dirs
    _seed_job(scratch)
    _forbid_lane_bounce(monkeypatch)
    def fake_render(dest_dir, *, style, prompt, lyrics, session_id, **_k):
        assert style == "dark synth"
        assert lyrics == "neon rain"
        assert "sample lyric" not in f"{style}\n{prompt}\n{lyrics}".lower()
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, f"{session_id}_master.wav")
        # Stereo PCM16 at 48 kHz is 4 bytes/frame; >25600 frames clears 100KB.
        tone = np.zeros((25601, 2), dtype=np.float32)
        sf.write(dest, tone, 48000, subtype="PCM_16", format="WAV")
        return dest

    monkeypatch.setattr("engine.generate_track_headless.render_lyria_master", fake_render)
    runner._worker(
        SESSION,
        "prompt field",
        "rock",
        False,
        {"style": "dark synth", "lyrics": "neon rain"},
    )
    public = runner._public_job(runner._lookup_job(SESSION))
    assert public["status"] == "completed", public.get("error")
    assert public["audio_filename"] == f"{SESSION}_master.wav"
    assert public["master_url"] == f"/api/stream/{SESSION}_master.wav"
    assert public["audio_mime"] == "audio/wav"
    assert public.get("mp3_url") in {None, ""}
    published = assets / f"{SESSION}_master.wav"
    assert published.is_file()
    info = sf.info(str(published))
    assert info.samplerate == 48000
    assert info.format == "WAV"
    assert str(info.subtype).startswith("PCM")
    with open(published, "rb") as handle:
        header = handle.read(12)
    assert header[:4] == b"RIFF" and header[8:12] == b"WAVE"
    assert published.stat().st_size > 100 * 1024


def _stub_headless_child(monkeypatch, result):
    monkeypatch.setattr(runner, "_headless_script", lambda: "generate_track_headless.py")
    monkeypatch.setattr(runner, "_resolve_corpus", lambda: "corpus")
    monkeypatch.setattr(runner, "_resolve_index", lambda: "index.sqlite")
    monkeypatch.setattr(runner, "_archive_step_output", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_run", lambda *a, **k: result)


def test_run_headless_accepts_lyria_master_without_unmastered_mix(live_dirs, monkeypatch):
    scratch, _assets = live_dirs
    session = "ht_lyria_gate"
    sdir = scratch / session
    sdir.mkdir()
    master = sdir / f"{session}_master.wav"
    sf.write(str(master), np.zeros((25601, 2), dtype=np.float32), 48000, subtype="PCM_16")
    assert master.stat().st_size > 100 * 1024

    class _Result:
        returncode = 0
        stdout = f"[LYRIA] master={master}\n"
        stderr = ""

    _stub_headless_child(monkeypatch, _Result())
    runner._run_headless(sys.executable, session, "Outlaw Country", "Outlaw Country")
    assert not (sdir / "unmastered_mix.wav").is_file()
    assert master.is_file()


def test_run_headless_fails_when_child_returncode_is_nonzero(live_dirs, monkeypatch):
    scratch, _assets = live_dirs
    session = "ht_lyria_bad_rc"
    sdir = scratch / session
    sdir.mkdir()
    master = sdir / f"{session}_master.wav"
    sf.write(str(master), np.zeros((25601, 2), dtype=np.float32), 48000, subtype="PCM_16")

    class _Result:
        returncode = 1
        stdout = f"[LYRIA] master={master}\n"
        stderr = ""

    _stub_headless_child(monkeypatch, _Result())
    with pytest.raises(RuntimeError, match="Headless generate failed"):
        runner._run_headless(sys.executable, session, "Outlaw Country", "Outlaw Country")


def test_run_headless_still_fails_when_lyria_master_is_missing(live_dirs, monkeypatch):
    scratch, _assets = live_dirs
    session = "ht_lyria_nomaster"
    (scratch / session).mkdir()

    class _Result:
        returncode = 0
        stdout = ""
        stderr = ""

    _stub_headless_child(monkeypatch, _Result())
    with pytest.raises(RuntimeError, match="Headless generate failed"):
        runner._run_headless(sys.executable, session, "Outlaw Country", "Outlaw Country")


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
    # bars alone cannot be converted to a duration; the default tempo must not
    # be substituted silently.
    bad = client.post("/api/tracks/create", json={"prompt": "x", "bars": 32})
    assert bad.status_code == 400 and "bars requires bpm" in bad.text
    ok = client.post("/api/tracks/create", json={"prompt": "x", "bars": 32, "bpm": 120})
    assert ok.status_code == 200
    session_id = ok.json()["session_id"]
    opts = started[-1][-1]
    assert opts == {
        "bpm": 120.0,
        "duration_sec": pytest.approx(64.0),
        "key": "G",
    }
    status = client.get(f"/api/jobs/{session_id}")
    assert status.status_code == 200
    body = status.json()
    assert body["requested_bars"] == 32 and body["requested_bpm"] == 120.0


def test_create_reports_no_requested_bpm_when_caller_omitted_it(live_dirs, monkeypatch):
    """``requested_bpm`` is what was asked for, not the fallback that was used."""
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    monkeypatch.delenv("HYBRID_WORKER_TOKEN", raising=False)

    class _NoThread:
        def __init__(self, target, args, name, daemon):
            pass

        def start(self):
            pass

    monkeypatch.setattr(runner.threading, "Thread", _NoThread)
    client = TestClient(runner.app)
    ok = client.post("/api/tracks/create", json={"prompt": "x", "duration_sec": 60})
    assert ok.status_code == 200
    body = client.get(f"/api/jobs/{ok.json()['session_id']}").json()
    assert body["requested_bpm"] is None


def test_second_create_joins_the_in_flight_render(live_dirs, monkeypatch):
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    monkeypatch.delenv("HYBRID_WORKER_TOKEN", raising=False)
    started: list[str] = []

    class _NoThread:
        def __init__(self, target, args, name, daemon):
            started.append(args[0])

        def start(self):
            pass

    monkeypatch.setattr(runner.threading, "Thread", _NoThread)
    client = TestClient(runner.app)
    first = client.post("/api/tracks/create", json={"prompt": "first"})
    second = client.post("/api/tracks/create", json={"prompt": "second"})
    assert first.status_code == 200 and second.status_code == 200
    assert second.json()["session_id"] == first.json()["session_id"]
    assert second.json()["deduped"] is True
    assert started == [first.json()["session_id"]]


def test_three_overlapping_creates_share_one_session(live_dirs, monkeypatch):
    """A second POST that arrives before the body is parsed joins the claim."""
    monkeypatch.delenv("HYBRID_WORKER_TOKEN", raising=False)
    started: list[str] = []
    real_thread = threading.Thread

    class _NoThread:
        def __init__(self, group=None, target=None, name=None, args=(), kwargs=None, *, daemon=None):
            self._inner = None
            if target is runner._worker:
                started.append(args[0])
                return
            self._inner = real_thread(
                group=group, target=target, name=name, args=args, kwargs=kwargs, daemon=daemon
            )

        def start(self):
            if self._inner is not None:
                self._inner.start()

        def join(self, timeout=None):
            if self._inner is not None:
                self._inner.join(timeout)

    monkeypatch.setattr(runner.threading, "Thread", _NoThread)
    barrier = threading.Barrier(3)
    results: list[dict] = []
    errors: list[BaseException] = []

    def go():
        try:
            barrier.wait(5)
            joined = runner._join_active_generation()
            if joined is not None:
                results.append(joined)
                return
            try:
                results.append(
                    runner._enqueue_generate(
                        "p",
                        "g",
                        dry_run=True,
                        render_opts={"bpm": 120.0, "key": "G", "duration_sec": 30.0},
                        requested_bars=None,
                        requested_bpm=None,
                        session_id=runner._active_session_id,
                    )
                )
            finally:
                runner._release_generation_claim()
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=go) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)
    assert not errors
    assert len(results) == 3
    assert len({item["session_id"] for item in results}) == 1
    assert sum(1 for item in results if item.get("deduped")) == 2
    assert started == [results[0]["session_id"]]


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


def test_public_job_keeps_a_false_certification_and_its_reason():
    """``False or ...`` used to wipe certified=False to None on the job payload."""
    from engine.provenance_guard import ProvenanceGuard

    guard = ProvenanceGuard(bpm=120.0, sr=SR)
    _m, _s, report = guard.check(np.zeros(SR) + 0.01, stems={}, seed=0)
    fields = runner._provenance_public_fields(report)
    assert fields["provenance_certified"] is False
    assert fields["provenance_status"] == "unverified_no_references"
    assert "fingerprint corpus" in fields["provenance_note"]

    public = runner._public_job(
        {
            "session_id": SESSION,
            "status": "completed",
            **fields,
        }
    )
    assert public["provenance_certified"] is False
    assert public["provenance_status"] == "unverified_no_references"
    assert public["provenance_note"] == fields["provenance_note"]
