"""Localhost headless track-generation API (127.0.0.1:8000).

POST /api/tracks/create  {prompt, genre_hint} -> {session_id, status: queued}
GET  /api/tracks/status/{id}
GET  /api/stream/{filename}

Runs engine/generate_track_headless.py then scripts/run_master_pipeline.ps1
on a daemon thread. Does not use FastAPI BackgroundTasks.

Expected headless CLI (do not overwrite that file):
  --prompt --session --genre [--offline] [--scratch]
  writes C:\\live_web_outputs\\scratch\\{session}\\unmastered_mix.wav
  (never writes into C:\\staging_slices)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_THIS = os.path.abspath(__file__)
_API_DIR = os.path.dirname(_THIS)
_REPO_ROOT = os.path.dirname(_API_DIR)
BASE_DIR = os.environ.get("MUSICDATASETS_ROOT", r"D:\MusicDatasets")
try:
    from engine.worker_handoff import live_output_tree

    _LIVE = live_output_tree()
except Exception:
    _LIVE = {
        "root": r"C:\live_web_outputs",
        "scratch": r"C:\live_web_outputs\scratch",
        "renders": r"C:\live_web_outputs\renders",
        "releases": r"C:\live_web_outputs\releases",
        "logs": r"C:\live_web_outputs\logs",
    }
    for _path in _LIVE.values():
        os.makedirs(_path, exist_ok=True)
SCRATCH_ROOT = _LIVE["scratch"]
RENDERS_ROOT = _LIVE["renders"]
RELEASES_ROOT = _LIVE["releases"]
ASSETS_ROOT = os.path.join(RELEASES_ROOT, "assets")
_API_LOG = os.path.join(_REPO_ROOT, "reports", "live_api.out.log")
MAX_PROMPT = 2000
BIND_HOST = "127.0.0.1"
BIND_PORT = 8000
CORS_ORIGINS = (
    "http://localhost:8082",
    "http://127.0.0.1:8082",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
)
POWERSHELL = os.environ.get(
    "HYBRID_POWERSHELL",
    r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
)
AUDIO_EXTS = {".wav", ".mp3"}
MIME_BY_EXT = {".wav": "audio/wav", ".mp3": "audio/mpeg"}
_SECRET_RE = re.compile(
    r"(?i)((?:replicate|gemini|google|lyric|api)[_-]?.*?(?:token|key|secret|password)|authorization)\s*[=:]\s*\S+"
)

_registry_lock = threading.Lock()
_jobs: dict[str, dict[str, Any]] = {}
_DRY_RUN = False
_brain_health: dict[str, Any] = {"loaded": False, "error": None}


# ---------------------------------------------------------------------------
# Logging / secrets
# ---------------------------------------------------------------------------

def _redact(text: str) -> str:
    return _SECRET_RE.sub(r"\1=***", text or "")


def _log(msg: str) -> None:
    line = _redact(msg)
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(_API_LOG), exist_ok=True)
        with open(_API_LOG, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Python resolver (Get-HybridPython / resolve_python.ps1 — never Store stub)
# ---------------------------------------------------------------------------

def _is_store_stub(path: str) -> bool:
    normalized = os.path.normcase(os.path.abspath(path))
    return "windowsapps" in normalized


def _python_version_ok(path: str) -> bool:
    if not path or not os.path.isfile(path) or _is_store_stub(path):
        return False
    try:
        result = subprocess.run(
            [path, "--version"],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    banner = (result.stdout or result.stderr or "").strip()
    return result.returncode == 0 and banner.startswith("Python 3.")


def resolve_workstation_python() -> str:
    """Same order as scripts/resolve_python.ps1. Never the Windows Store alias."""
    env = (os.environ.get("HYBRID_PYTHON") or "").strip()
    local = os.environ.get("LOCALAPPDATA") or ""
    known = [
        env,
        os.path.join(local, "Programs", "Python", "Python312", "python.exe") if local else "",
        r"C:\Users\spaul\AppData\Local\Programs\Python\Python312\python.exe",
        r"C:\Program Files\Python312\python.exe",
        r"C:\Program Files\Python311\python.exe",
    ]
    search_roots = [
        os.path.join(local, "Programs", "Python") if local else "",
        os.path.join(os.environ.get("ProgramFiles") or r"C:\Program Files", ""),
        os.environ.get("ProgramFiles(x86)") or "",
    ]
    for root in search_roots:
        if not root or not os.path.isdir(root):
            continue
        try:
            names = sorted(
                (name for name in os.listdir(root) if name.lower().startswith("python3")),
                reverse=True,
            )
        except OSError:
            names = []
        for name in names:
            known.append(os.path.join(root, name, "python.exe"))

    seen: set[str] = set()
    for candidate in known:
        if not candidate:
            continue
        key = os.path.normcase(os.path.abspath(candidate))
        if key in seen:
            continue
        seen.add(key)
        if _python_version_ok(candidate):
            return os.path.abspath(candidate)

    for name in ("python", "python3"):
        try:
            result = subprocess.run(
                ["where" if os.name == "nt" else "which", name],
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        for line in (result.stdout or "").splitlines():
            path = line.strip()
            if path and _python_version_ok(path):
                return os.path.abspath(path)

    if sys.executable and _python_version_ok(sys.executable):
        return os.path.abspath(sys.executable)
    raise RuntimeError(
        "No usable Python 3 interpreter found. "
        "Set HYBRID_PYTHON or install python.org Python 3.12 "
        r"(C:\Users\spaul\AppData\Local\Programs\Python\Python312\python.exe)."
    )


# ---------------------------------------------------------------------------
# Job registry + scratch persist
# ---------------------------------------------------------------------------

def _job_path(session_id: str) -> str:
    return os.path.join(SCRATCH_ROOT, session_id, "job.json")


def _persist_job(job: dict[str, Any]) -> None:
    path = _job_path(str(job["session_id"]))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    public = _public_job(job)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(public, handle, indent=2)
    os.replace(tmp, path)


def _public_job(job: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "session_id",
        "status",
        "genre_hint",
        "error",
        "note",
        "audio_filename",
        "audio_mime",
        "created_at",
        "updated_at",
    )
    return {key: job.get(key) for key in keys}


def _update_job(session_id: str, **fields: Any) -> dict[str, Any]:
    disk = None
    with _registry_lock:
        job = _jobs.get(session_id)
    if job is None:
        disk = _load_job_from_disk(session_id)
    with _registry_lock:
        job = _jobs.get(session_id)
        if job is None:
            if disk is None:
                raise KeyError(session_id)
            _jobs[session_id] = disk
            job = disk
        job.update(fields)
        job["updated_at"] = _utc_now()
        snapshot = dict(job)
    try:
        _persist_job(snapshot)
    except OSError as exc:
        _log(f"[job] persist failed for {session_id}: {exc}")
    return snapshot


def _load_job_from_disk(session_id: str) -> dict[str, Any] | None:
    path = _job_path(session_id)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("session_id") != session_id:
        return None
    return data


def _lookup_job(session_id: str) -> dict[str, Any] | None:
    disk = _load_job_from_disk(session_id)
    with _registry_lock:
        if disk is not None:
            _jobs[session_id] = disk
            return dict(disk)
        job = _jobs.get(session_id)
        if job is not None:
            return dict(job)
    return None


# ---------------------------------------------------------------------------
# Paths: headless, assembler, pipeline, audio
# ---------------------------------------------------------------------------

def _first_existing(*paths: str) -> str | None:
    for path in paths:
        if path and os.path.isfile(path):
            return path
    return None


def _headless_script() -> str | None:
    return _first_existing(
        os.path.join(_REPO_ROOT, "engine", "generate_track_headless.py"),
        os.path.join(BASE_DIR, "engine", "generate_track_headless.py"),
    )


def _assembler_script() -> str | None:
    return _first_existing(
        os.path.join(_REPO_ROOT, "engine", "local_track_synthesizer.py"),
        os.path.join(BASE_DIR, "engine", "local_track_synthesizer.py"),
        os.path.join(_REPO_ROOT, "engine", "blueprint_track_assembler.py"),
        os.path.join(BASE_DIR, "engine", "blueprint_track_assembler.py"),
    )


def _pipeline_script() -> str | None:
    # Prefer the repo copy so Worker handoff guards land even if D:\ is stale.
    return _first_existing(
        os.path.join(_REPO_ROOT, "scripts", "run_master_pipeline.ps1"),
        os.path.join(BASE_DIR, "scripts", "run_master_pipeline.ps1"),
    )


def _session_mix_path(session_id: str) -> str:
    return os.path.join(SCRATCH_ROOT, session_id, "unmastered_mix.wav")


def _replicate_token_set() -> bool:
    return bool((os.environ.get("REPLICATE_API_TOKEN") or "").strip())


def _sanitize_filename(filename: str) -> str | None:
    if not filename or filename != os.path.basename(filename):
        return None
    if ".." in filename or "/" in filename or "\\" in filename:
        return None
    stem, ext = os.path.splitext(filename)
    if not stem or ext.lower() not in AUDIO_EXTS:
        return None
    if not re.fullmatch(r"[A-Za-z0-9._-]+", filename):
        return None
    return filename


def _is_under(path: str, root: str) -> bool:
    try:
        real = os.path.abspath(path)
        base = os.path.abspath(root)
    except OSError:
        return False
    return real == base or real.startswith(base + os.sep)


def _master_candidates(session_id: str) -> list[str]:
    render_dir = os.path.join(RENDERS_ROOT, session_id)
    release_dir = os.path.join(RELEASES_ROOT, session_id)
    names = (
        "master_output.wav",
        "master_output.mp3",
        f"{session_id}_master.wav",
        f"{session_id}_master.mp3",
    )
    found: list[str] = []
    for folder in (render_dir, release_dir):
        for name in names:
            path = os.path.join(folder, name)
            if os.path.isfile(path):
                found.append(path)
    wavs = [path for path in found if path.lower().endswith(".wav")]
    mp3s = [path for path in found if path.lower().endswith(".mp3")]
    return wavs + mp3s


def _resolve_stream_path(filename: str) -> str | None:
    safe = _sanitize_filename(filename)
    if safe is None:
        return None
    asset = os.path.join(ASSETS_ROOT, safe)
    if os.path.isfile(asset) and _is_under(asset, ASSETS_ROOT):
        return asset

    stem, ext = os.path.splitext(safe)
    session_id = stem
    job = _lookup_job(session_id)
    if job is None and stem.endswith("_master_output"):
        session_id = stem[: -len("_master_output")]
        job = _lookup_job(session_id)
    if job is None:
        return None

    for candidate in _master_candidates(session_id):
        if not os.path.isfile(candidate):
            continue
        allowed = (
            os.path.join(RENDERS_ROOT, session_id),
            os.path.join(RELEASES_ROOT, session_id),
        )
        if not any(_is_under(candidate, root) for root in allowed):
            continue
        if ext and os.path.splitext(candidate)[1].lower() != ext.lower():
            continue
        return candidate
    return None


# ---------------------------------------------------------------------------
# Subprocess helpers
# ---------------------------------------------------------------------------

def pin_live_api_to_cpu() -> None:
    """Hide the MX450 from this process so the CUDA trainer keeps the GPU lock."""
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ["HYBRID_INFER_DEVICE"] = "cpu"
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    os.environ.setdefault("MKL_NUM_THREADS", "2")
    os.environ.setdefault("NUMEXPR_NUM_THREADS", "2")


pin_live_api_to_cpu()


def _child_env() -> dict[str, str]:
    env = os.environ.copy()
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = _REPO_ROOT + (os.pathsep + existing if existing else "")
    env["CUDA_VISIBLE_DEVICES"] = ""
    env["HYBRID_INFER_DEVICE"] = "cpu"
    env["HYBRID_LIVE_OUTPUT"] = _LIVE["root"]
    env["HYBRID_SCRATCH"] = SCRATCH_ROOT
    try:
        from engine.live_index import live_index_path

        env["CORPUS_INDEX_DB"] = live_index_path()
        env["CORPUS_INDEX_LIVE"] = live_index_path()
    except Exception:
        env["CORPUS_INDEX_LIVE"] = r"C:\live_web_outputs\db\corpus_index_live.sqlite"
    env.setdefault("OMP_NUM_THREADS", "2")
    env.setdefault("MKL_NUM_THREADS", "2")
    return env


def _run(cmd: list[str], cwd: str | None = None) -> subprocess.CompletedProcess[str]:
    _log("[run] " + " ".join(cmd[:6]) + (" …" if len(cmd) > 6 else ""))
    return subprocess.run(
        cmd,
        cwd=cwd or _REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
        env=_child_env(),
    )


def _resolve_index() -> str:
    try:
        from engine.live_index import resolve_worker_index

        return resolve_worker_index()
    except Exception:
        live = r"C:\live_web_outputs\db\corpus_index_live.sqlite"
        if os.path.isfile(live):
            return live
        raise RuntimeError(
            "Live replica missing at C:\\live_web_outputs\\db\\corpus_index_live.sqlite"
        )


def _resolve_corpus() -> str:
    try:
        from engine.worker_handoff import resolve_worker_corpus

        return resolve_worker_corpus()
    except Exception:
        staging = r"C:\staging_slices"
        if os.path.isdir(staging):
            return staging
        return os.path.join(BASE_DIR, "corpus_4s")


def _run_headless(python: str, session_id: str, prompt: str, genre_hint: str) -> None:
    script = _headless_script()
    mix = _session_mix_path(session_id)
    os.makedirs(os.path.dirname(mix), exist_ok=True)
    corpus = _resolve_corpus()
    _log(
        f"[PAYLOAD] session={session_id} prompt_chars={len(prompt)} "
        f"genre={genre_hint!r} corpus={corpus}"
    )
    if script is None:
        assembler = _assembler_script()
        if assembler is None:
            raise RuntimeError(
                "engine/generate_track_headless.py is missing and no assembler "
                "fallback (local_track_synthesizer / blueprint_track_assembler) was found."
            )
        _log(
            f"[headless] generate_track_headless.py missing; "
            f"assembler fallback {os.path.basename(assembler)}"
        )
        cmd = [python, assembler, "--out", mix]
        if os.path.basename(assembler) == "local_track_synthesizer.py":
            cmd += ["--corpus", corpus]
        result = _run(cmd, cwd=_REPO_ROOT)
        if result.returncode != 0 or not os.path.isfile(mix):
            detail = _redact((result.stderr or result.stdout or "").strip()[-800:])
            raise RuntimeError(
                f"Assembler fallback failed (headless script missing). {detail}"
            )
        return

    cmd = [
        python,
        script,
        "--prompt",
        prompt,
        "--session",
        session_id,
        "--scratch",
        SCRATCH_ROOT,
        "--corpus",
        corpus,
        "--db",
        _resolve_index(),
    ]
    if genre_hint:
        cmd += ["--genre", genre_hint]
    if not _replicate_token_set():
        cmd.append("--offline")
    result = _run(cmd, cwd=_REPO_ROOT)
    if result.stdout:
        _log("[generate] " + _redact(result.stdout.strip()[-1200:]))
    if result.returncode != 0 or not os.path.isfile(mix):
        detail = _redact((result.stderr or result.stdout or "").strip()[-800:])
        raise RuntimeError(f"Headless generate failed. {detail}")


def _run_master_pipeline(session_id: str, genre_hint: str) -> None:
    script = _pipeline_script()
    if script is None:
        raise RuntimeError("run_master_pipeline.ps1 not found under D:\\MusicDatasets\\scripts or repo scripts.")
    genre = genre_hint or "alt_rock"
    cmd = [
        POWERSHELL,
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-SessionId",
        session_id,
        "-TargetGenre",
        genre,
    ]
    result = _run(cmd)
    if result.returncode != 0:
        detail = _redact((result.stderr or result.stdout or "").strip()[-800:])
        raise RuntimeError(f"Master pipeline failed. {detail}")


def _publish_audio(session_id: str, src: str) -> tuple[str, str]:
    if not src or not os.path.isfile(src):
        raise RuntimeError(f"No mix to publish for {session_id}: {src}")
    ext = os.path.splitext(src)[1].lower() or ".wav"
    mime = MIME_BY_EXT.get(ext, "audio/wav")
    filename = f"{session_id}{ext}"
    dest = os.path.join(ASSETS_ROOT, filename)
    os.makedirs(ASSETS_ROOT, exist_ok=True)
    if os.path.abspath(src) != os.path.abspath(dest):
        shutil.copy2(src, dest)
    return filename, mime


def _attach_master(session_id: str) -> tuple[str, str]:
    candidates = _master_candidates(session_id)
    if not candidates:
        raise RuntimeError(
            "Pipeline finished but no master was found. "
            f"Expected WAV first at {os.path.join(RENDERS_ROOT, session_id, 'master_output.wav')}."
        )
    return _publish_audio(session_id, candidates[0])


def _worker(session_id: str, prompt: str, genre_hint: str, dry_run: bool) -> None:
    try:
        _update_job(session_id, status="running", error=None)
        if dry_run or _DRY_RUN:
            note = "dry-run: create accepted, pipeline not started"
            if _headless_script() is None:
                note += "; generate_track_headless.py not present"
            _update_job(session_id, status="completed", note=note)
            return
        python = resolve_workstation_python()
        _log(f"[worker] python={python} session={session_id}")
        _run_headless(python, session_id, prompt, genre_hint)
        from engine.worker_handoff import assert_handoff_ready

        probe = assert_handoff_ready(SCRATCH_ROOT, session_id)
        _log(
            f"[HANDOFF] generation -> composition session={session_id} "
            f"mix_bytes={probe['mix_bytes']} slices={probe['slice_count']} "
            f"mix={probe['mix']}"
        )
        filename, mime = _publish_audio(session_id, str(probe["mix"]))
        try:
            _run_master_pipeline(session_id, genre_hint)
            filename, mime = _attach_master(session_id)
        except Exception as master_exc:
            _log(
                f"[worker] master pipeline failed; Gate 1 uses unmastered mix: {master_exc}"
            )
        _update_job(
            session_id,
            status="completed",
            audio_filename=filename,
            audio_mime=mime,
            error=None,
        )
    except Exception as exc:
        _log(f"[worker] {session_id} failed: {exc}")
        _log("[TRACEBACK]\n" + traceback.format_exc())
        try:
            _update_job(session_id, status="failed", error=_redact(str(exc))[:800])
        except KeyError:
            pass


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

def _load_fastapi():
    try:
        from fastapi import FastAPI, HTTPException, Request
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import FileResponse, Response
        from pydantic import BaseModel, Field
    except ImportError as exc:
        raise RuntimeError(
            "fastapi/uvicorn are listed in requirements-engine.txt but failed to import. "
            f"{exc}"
        ) from exc
    return FastAPI, HTTPException, Request, CORSMiddleware, FileResponse, Response, BaseModel, Field


FastAPI, HTTPException, Request, CORSMiddleware, FileResponse, Response, BaseModel, Field = _load_fastapi()


class CreateTrackBody(BaseModel):
    prompt: str = ""
    genre_hint: str | None = Field(default=None, max_length=120)
    genre: str | None = Field(default=None, max_length=120)
    genre_lock: str | None = Field(default=None, max_length=120)
    style: str | None = Field(default=None, max_length=200)
    title: str | None = Field(default=None, max_length=200)
    dry_run: bool = False


def _boot_production_brain() -> dict[str, Any]:
    """Load frozen v1.0.0 weights on CPU. Failed load = empty routing arrays."""
    global _brain_health
    pin_live_api_to_cpu()
    try:
        from engine.worker_handoff import load_production_brain, resolve_worker_corpus

        info = load_production_brain()
        corpus = resolve_worker_corpus()
        _brain_health = {
            "loaded": True,
            "error": None,
            "epoch": info.get("epoch"),
            "phase": info.get("phase"),
            "device": info.get("device"),
            "bytes": info.get("bytes"),
            "path": info.get("path"),
            "corpus": corpus,
        }
        _log(
            f"[BRAIN] loaded epoch={info.get('epoch')} phase={info.get('phase')} "
            f"device={info.get('device')} bytes={info.get('bytes')} path={info.get('path')}"
        )
        _log(f"[CORPUS] worker={corpus}")
        try:
            from engine.live_index import refresh_live_index_replica

            replica = refresh_live_index_replica()
            _brain_health["index"] = replica
            _log(f"[LIVE_INDEX] {replica}")
        except Exception as index_exc:
            _log(f"[LIVE_INDEX] replica refresh failed: {index_exc}")
        return info
    except Exception as exc:
        _brain_health = {"loaded": False, "error": str(exc)[:400]}
        _log(f"[BRAIN] FAILED {exc}")
        raise


def create_app() -> Any:
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lifespan(_app: Any):
        try:
            _boot_production_brain()
        except Exception:
            # Jobs that need the brain will fail at the handoff, not at boot.
            pass
        yield

    app = FastAPI(
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        title="Headless Generation",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(CORS_ORIGINS),
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok" if _brain_health.get("loaded") else "degraded",
            "device": "cpu",
            "role": "live-api",
            "brain_loaded": bool(_brain_health.get("loaded")),
            "brain_epoch": _brain_health.get("epoch"),
            "corpus": _brain_health.get("corpus"),
            "index": _brain_health.get("index"),
            "brain_error": _brain_health.get("error"),
        }

    @app.post("/generate")
    @app.post("/api/generate")
    @app.post("/api/tracks/create")
    def create_track(body: CreateTrackBody) -> dict[str, Any]:
        prompt = (body.prompt or body.title or body.style or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="prompt is required")
        if len(prompt) > MAX_PROMPT:
            raise HTTPException(status_code=400, detail=f"prompt exceeds {MAX_PROMPT} characters")
        genre = (
            body.genre_hint or body.genre or body.genre_lock or body.style or ""
        ).strip()
        _log(
            f"[API_PAYLOAD] prompt_chars={len(prompt)} genre={genre!r} "
            f"brain_loaded={_brain_health.get('loaded')}"
        )
        if not genre and not prompt:
            raise HTTPException(status_code=400, detail="prompt and genre_hint are empty")
        session_id = "ht_" + uuid.uuid4().hex[:12]
        job = {
            "session_id": session_id,
            "status": "queued",
            "genre_hint": genre or None,
            "error": None,
            "note": None,
            "audio_filename": None,
            "audio_mime": None,
            "created_at": _utc_now(),
            "updated_at": _utc_now(),
        }
        with _registry_lock:
            _jobs[session_id] = job
        try:
            _persist_job(job)
        except OSError as exc:
            _log(f"[create] persist failed: {exc}")
            raise HTTPException(status_code=500, detail="could not persist job") from exc
        thread = threading.Thread(
            target=_worker,
            args=(session_id, prompt, genre, bool(body.dry_run)),
            name=f"headless-{session_id}",
            daemon=True,
        )
        thread.start()
        return {"session_id": session_id, "status": "queued"}

    @app.get("/api/tracks/status/{session_id}")
    def track_status(session_id: str) -> dict[str, Any]:
        job = _lookup_job(session_id)
        if job is None:
            raise HTTPException(status_code=404, detail="unknown session")
        return _public_job(job)

    @app.get("/api/stream/{filename}")
    def stream_audio(filename: str, request: Request) -> Any:
        path = _resolve_stream_path(filename)
        if path is None or not os.path.isfile(path):
            raise HTTPException(status_code=404, detail="audio not found")
        ext = os.path.splitext(path)[1].lower()
        mime = MIME_BY_EXT.get(ext, "application/octet-stream")
        file_size = os.path.getsize(path)
        range_header = request.headers.get("range") or ""
        if range_header.startswith("bytes="):
            spec = range_header.split("=", 1)[1].split(",")[0].strip()
            start_s, _, end_s = spec.partition("-")
            try:
                start = int(start_s) if start_s else 0
                end = int(end_s) if end_s else file_size - 1
            except ValueError:
                start, end = 0, file_size - 1
            start = max(0, start)
            end = min(file_size - 1, end)
            if start > end:
                raise HTTPException(status_code=416, detail="invalid range")
            length = end - start + 1
            with open(path, "rb") as handle:
                handle.seek(start)
                chunk = handle.read(length)
            return Response(
                content=chunk,
                status_code=206,
                media_type=mime,
                headers={
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges": "bytes",
                    "Content-Length": str(length),
                    "Content-Disposition": f'inline; filename="{os.path.basename(path)}"',
                },
            )
        return FileResponse(
            path,
            media_type=mime,
            filename=os.path.basename(path),
            headers={"Accept-Ranges": "bytes"},
        )

    return app


app = create_app()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Headless generation API (localhost only)")
    parser.add_argument("--dry-run", action="store_true", help="Queue jobs without running the pipeline")
    parser.add_argument("--once", action="store_true", help="Resolve interpreter and exit (no server)")
    parser.add_argument("--host", default=BIND_HOST)
    parser.add_argument("--port", type=int, default=BIND_PORT)
    parser.add_argument(
        "--device",
        "-d",
        default="cpu",
        choices=["cpu"],
        help="Live API is CPU-only so the CUDA trainer keeps the MX450",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=2,
        help="Uvicorn worker processes (2-4). Accepts web payloads while composition runs.",
    )
    args = parser.parse_args(argv)

    pin_live_api_to_cpu()

    global _DRY_RUN
    _DRY_RUN = bool(args.dry_run)

    host = args.host if args.host in {"127.0.0.1", "localhost"} else BIND_HOST
    port = int(args.port) if args.port else BIND_PORT
    workers = max(2, min(4, int(args.workers) or 2))

    try:
        python = resolve_workstation_python()
    except RuntimeError as exc:
        _log(f"[fatal] {exc}")
        return 1

    headless = _headless_script()
    _log(f"[ok] python={python}")
    _log(f"[ok] headless={'present ' + headless if headless else 'MISSING — assembler fallback or job error'}")
    _log(f"[ok] bind={host}:{port} workers={workers} device=cpu docs_url=None dry_run={_DRY_RUN}")

    if args.once:
        try:
            _boot_production_brain()
        except Exception as exc:
            _log(f"[warn] production brain not loaded: {exc}")
            return 1
        return 0

    try:
        import uvicorn
    except ImportError as exc:
        _log(f"[fatal] uvicorn missing ({exc}); it is listed in requirements-engine.txt")
        return 1

    uvicorn.run(
        "api.headless_job_runner:app",
        host=host,
        port=port,
        workers=workers,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
