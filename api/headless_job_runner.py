"""Localhost headless track-generation API (127.0.0.1:8880).

POST /api/tracks/create  {prompt, style, lyrics, genre_hint} -> {session_id, sessionId, track_id, id, status: pending}
GET  /api/tracks/status/{id}
GET  /api/stream/{filename}

The generate job publishes ``{session}_master.wav`` (/api/stream/{session}_master.wav).
It does not run the 13-lane assembler or the master pipeline.

No voice sample calls google/lyria-3-pro: one pass at or below 210 seconds,
two-pass stitch above that. A saved ref_vocal.wav calls pinned minimax/music-2.6
and downloads that output as the master. The take stays on disk and is not an
input. ffmpeg does not mix a Lyria bed.
"""
from __future__ import annotations

import argparse
import asyncio
import gc
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
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
# Per-session render transcripts. Survives the scratch purge.
LIVE_LOG_DIR = _LIVE.get("logs") or os.path.join(_LIVE["root"], "logs")
ASSETS_ROOT = os.path.join(RELEASES_ROOT, "assets")
# Finalized Module 5 packages: {DELIVERIES_ROOT}/{session_id}/ (master, mp3,
# manifest, stems/, bundle zip). Kept outside scratch so scratch can be purged.
DELIVERIES_ROOT = os.environ.get("HYBRID_DELIVERIES_ROOT") or os.path.join(
    _LIVE["root"], "deliveries"
)
_API_LOG = os.path.join(_REPO_ROOT, "reports", "live_api.out.log")
MINIMAX_MODEL_ID = "minimax/music-2.6"
LYRIA_MODEL_ID = "google/lyria-3-pro"
# Same pin as engine.generate_track_headless.MINIMAX_VERSION_ID.
MINIMAX_VERSION_ID = "dcd69b2c83c63ed612af65fc9842781fd7cf86db555e0b12ded7c6292bff8b7a"
MIN_PROMPT = 50
MAX_PROMPT = 5000
PROMPT_TOO_SHORT = "Prompt must be at least 50 characters."
LYRICS_MAX = 5000
LYRICS_TOO_LONG = "Lyrics are too long. Maximum allowed is 5,000 characters."
BIND_HOST = "127.0.0.1"
BIND_PORT = 8880
CORS_ORIGINS = (
    "http://localhost:8082",
    "http://127.0.0.1:8082",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://hybrid-ai-records.com",
    "https://www.hybrid-ai-records.com",
)
POWERSHELL = os.environ.get(
    "HYBRID_POWERSHELL",
    r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
)
AUDIO_EXTS = {".wav", ".mp3"}
# /api/stream also serves the Module 5 manifest and stem bundle.
STREAM_EXTS = AUDIO_EXTS | {".json", ".zip"}
MIME_BY_EXT = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".json": "application/json",
    ".zip": "application/zip",
}
STEM_FILENAMES = (
    "drums.wav",
    "bass.wav",
    "rhythm_guitar.wav",
    "lead_guitar.wav",
    "synth.wav",
    "vocals.wav",
)
BUS_STEM_NAMES = ("rhythm", "bass", "harmonic", "vocal")
# Each render peaks around 1.5 GB; extra jobs wait in "queued" for a slot.
_RENDER_SLOTS = threading.BoundedSemaphore(
    value=max(1, int(os.environ.get("HYBRID_MAX_RENDERS", "2") or 2))
)
# Per subprocess step (generate, master). 96-bar + ~500k RAM clone
# routinely exceeds 5 minutes while D: ingest is hot (300s killed
# generate_track_headless mid-[SELECT] and skipped [RELATIONAL]).
_STEP_TIMEOUT_SEC = max(30, int(os.environ.get("HYBRID_STEP_TIMEOUT_SEC", "900") or 900))
_SECRET_RE = re.compile(
    r"(?i)((?:replicate|gemini|google|lyric|api)[_-]?.*?(?:token|key|secret|password)|authorization)\s*[=:]\s*\S+"
)

_registry_lock = threading.Lock()
# Held from the moment a create request is accepted until the job is queued.
# acquire(blocking=False) so a second POST cannot pass the await and start
# another render. The lock is not held across the render itself.
_generation_lock = threading.Lock()
_active_session_id: str | None = None
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


def _console_exception(message: str) -> None:
    """Print the active exception. Call from inside ``except``; do not re-raise here."""
    _log(message)
    traceback.print_exc()
    traced = traceback.format_exc()
    if traced and not traced.startswith("NoneType: None"):
        _log("[TRACEBACK]\n" + traced)


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


def _provenance_public_fields(provenance: Any) -> dict[str, Any]:
    """Copy provenance onto the job. Do not use ``or`` — ``certified`` is often False."""
    if provenance is None:
        return {}
    if isinstance(provenance, dict):
        return {
            "provenance_hash": provenance.get("certification_hash")
            or provenance.get("provenance_hash"),
            "provenance_certified": provenance.get("certified"),
            "provenance_status": provenance.get("status"),
            "provenance_note": provenance.get("note"),
        }
    return {
        "provenance_hash": getattr(provenance, "certification_hash", None),
        "provenance_certified": getattr(provenance, "certified", None),
        "provenance_status": getattr(provenance, "status", None),
        "provenance_note": getattr(provenance, "note", None),
    }


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
        "master_url",
        "mp3_url",
        "zip_url",
        "manifest_url",
        "stem_urls",
        "integrated_lufs",
        "true_peak_dbtp",
        "provenance_hash",
        "provenance_certified",
        "provenance_status",
        "provenance_note",
        "song_plan",
        "package_dir",
        "delivery_status",
        "delivery_error",
        "scratch_purged_bytes",
        "requested_bars",
        "requested_bpm",
        "master_duration_sec",
        "voice_error",
        "engine_used",
        "token_cost",
        "detail",
        "vocal_present",
    )
    out: dict[str, Any] = {}
    for key in keys:
        if key in job:
            out[key] = job.get(key)
    if out.get("master_duration_sec") is None:
        plan = out.get("song_plan") if isinstance(out.get("song_plan"), dict) else {}
        bars = plan.get("total_bars") if isinstance(plan, dict) else None
        bpm = (plan.get("bpm") if isinstance(plan, dict) else None) or out.get("requested_bpm")
        try:
            if bars and bpm:
                out["master_duration_sec"] = round(float(bars) * 240.0 / float(bpm), 3)
        except (TypeError, ValueError):
            pass
    sid = str(out.get("session_id") or "").strip()
    if sid:
        out["session_id"] = sid
        out["sessionId"] = sid
        out["track_id"] = sid
        out["id"] = sid
    if "vocal_present" in job:
        out["vocal_present"] = bool(job.get("vocal_present"))
    return out


def _link_or_copy(src: str, dest: str) -> None:
    """Hard-link ``src`` to ``dest`` (no extra disk on the same volume), else copy."""
    if os.path.lexists(dest):
        os.remove(dest)
    try:
        os.link(src, dest)
    except OSError:
        shutil.copy2(src, dest)


SCRATCH_AUDIO_EXTS = (".wav", ".flac", ".aif", ".aiff", ".mp3")


def _purge_scratch_audio(session_id: str) -> int:
    """Delete intermediate audio under ``SCRATCH_ROOT/session_id``; return bytes freed.

    Only runs after a successful delivery. Keeps JSON (job, blueprint,
    quality report) and never touches ``DELIVERIES_ROOT``. Set
    ``HYBRID_KEEP_SCRATCH=1`` to keep buffers for debugging.

    A quarantined session is exempt: the QC gate retains its scratch so the
    defective master can be examined, and purging it destroys that evidence.
    """
    if (os.environ.get("HYBRID_KEEP_SCRATCH") or "").strip().lower() in {"1", "true", "yes", "on"}:
        return 0
    with _registry_lock:
        job = _jobs.get(session_id) or {}
    if (job.get("delivery_status") or "") == "quarantined":
        _log(f"[cleanup] {session_id} scratch kept: QC quarantine is under inspection")
        return 0
    session_dir = os.path.join(SCRATCH_ROOT, session_id)
    if not os.path.isdir(session_dir) or not _is_under(session_dir, SCRATCH_ROOT):
        return 0
    deliveries = os.path.abspath(DELIVERIES_ROOT)
    freed = 0
    for root, dirs, files in os.walk(session_dir, topdown=False):
        if _is_under(root, deliveries):
            continue
        for name in files:
            if not name.lower().endswith(SCRATCH_AUDIO_EXTS):
                continue
            path = os.path.join(root, name)
            try:
                size = os.path.getsize(path)
                os.remove(path)
                freed += size
            except OSError as exc:
                _log(f"[cleanup] could not remove {path}: {exc}")
        if root != session_dir and not os.listdir(root):
            try:
                os.rmdir(root)
            except OSError:
                pass
    return freed


def _publish_delivery_package(session_id: str, package_dir: str) -> dict[str, Any]:
    """Copy Module 5 artifacts to ``ASSETS_ROOT`` as ``{session_id}_<name>``.

    Handles the current layout (``stems/<name>.wav``,
    ``{session_id}_stems_bundle.zip``) and the legacy flat one (``<name>.wav``,
    ``delivery.zip``). ``stem_urls`` is keyed by stem basename.
    """
    os.makedirs(ASSETS_ROOT, exist_ok=True)
    published: dict[str, Any] = {"stem_urls": {}}
    bundle = f"{session_id}_stems_bundle.zip"
    # (relative source path, published filename, field). First existing wins.
    entries: list[tuple[str, str, str]] = [
        ("master.wav", f"{session_id}_master.wav", "master_url"),
        ("master.mp3", f"{session_id}_master.mp3", "mp3_url"),
        ("manifest.json", f"{session_id}_manifest.json", "manifest_url"),
        (bundle, bundle, "zip_url"),
        ("delivery.zip", bundle, "zip_url"),
    ]
    for stem in STEM_FILENAMES:
        entries.append((os.path.join("stems", stem), f"{session_id}_{stem}", f"stem:{stem}"))
        entries.append((stem, f"{session_id}_{stem}", f"stem:{stem}"))

    for rel_src, dest_name, field in entries:
        if field.startswith("stem:"):
            if field[5:] in published["stem_urls"]:
                continue
        elif field in published:
            continue
        src = os.path.join(package_dir, rel_src)
        if not os.path.isfile(src):
            continue
        dest = os.path.join(ASSETS_ROOT, dest_name)
        if os.path.abspath(src) != os.path.abspath(dest):
            _link_or_copy(src, dest)
        url = f"/api/stream/{dest_name}"
        if field.startswith("stem:"):
            published["stem_urls"][field[5:]] = url
            continue
        published[field] = url
        if field == "master_url":
            published["audio_filename"] = dest_name
            published["audio_mime"] = "audio/wav"
    published["package_dir"] = package_dir
    return published


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


def _lyria_master_path(session_id: str) -> str | None:
    """WAV or MP3 master in scratch when it exists and is larger than 100KB.

    WAV is checked first. Either file is enough. The child exit code and
    ``unmastered_mix.wav`` are not consulted once this returns a path.
    """
    folder = os.path.join(SCRATCH_ROOT, session_id)
    for ext in (".wav", ".mp3"):
        path = os.path.join(folder, f"{session_id}_master{ext}")
        try:
            if os.path.isfile(path) and os.path.getsize(path) > 100 * 1024:
                return path
        except OSError:
            continue
    return None


def _replicate_token_set() -> bool:
    return bool((os.environ.get("REPLICATE_API_TOKEN") or "").strip())


def _sanitize_filename(filename: str) -> str | None:
    if not filename or filename != os.path.basename(filename):
        return None
    if ".." in filename or "/" in filename or "\\" in filename:
        return None
    stem, ext = os.path.splitext(filename)
    if not stem or ext.lower() not in STREAM_EXTS:
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


def _kill_process_tree(proc: subprocess.Popen[str]) -> None:
    """Kill ``proc`` and its children (PowerShell → python grandchildren)."""
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            capture_output=True,
            check=False,
        )
    proc.kill()


def _run(
    cmd: list[str],
    cwd: str | None = None,
    *,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run one pipeline step; raises ``RuntimeError`` after ``timeout`` seconds."""
    limit = float(timeout if timeout is not None else _STEP_TIMEOUT_SEC)
    _log("[run] " + " ".join(cmd[:6]) + (" …" if len(cmd) > 6 else ""))
    proc = subprocess.Popen(
        cmd,
        cwd=cwd or _REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=_child_env(),
    )
    try:
        stdout, stderr = proc.communicate(timeout=limit)
    except subprocess.TimeoutExpired:
        _kill_process_tree(proc)
        stdout, stderr = proc.communicate()
        tail = _redact((stderr or stdout or "").strip()[-400:])
        step = next((c for c in cmd if str(c).lower().endswith((".py", ".ps1"))), cmd[0])
        raise RuntimeError(
            f"Step timed out after {limit:.0f}s and was killed: "
            f"{os.path.basename(str(step))}. {tail}"
        ) from None
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


def _archive_step_output(
    session_id: str, step: str, stdout: str | None, stderr: str | None
) -> str | None:
    """Keep a render's full console output next to the other live logs.

    The inline log line is capped at 1200 characters, which is roughly the tail
    of a render — so every mid-run diagnostic the engine prints
    (``[SONG_PLAN]``, ``[SELECT]``, ``[ARRANGE]``, ``[HARMONY]``,
    ``[RELATIONAL]``) was being discarded, and the only way to observe the
    pipeline was to add temporary instrumentation. The capped line stays for
    at-a-glance reading; the full transcript lands here.

    Best-effort: a logging failure must never fail a render.
    """
    body = (stdout or "") + (f"\n--- stderr ---\n{stderr}" if stderr else "")
    if not body.strip():
        return None
    try:
        os.makedirs(LIVE_LOG_DIR, exist_ok=True)
        path = os.path.join(LIVE_LOG_DIR, f"{session_id}.{step}.log")
        with open(path, "w", encoding="utf-8", errors="replace") as handle:
            handle.write(_redact(body))
        _log(f"[{step}] full console output: {path}")
        return path
    except OSError as exc:
        _log(f"[{step}] could not archive console output ({exc})")
        return None


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


def _run_headless(
    python: str,
    session_id: str,
    prompt: str,
    genre_hint: str,
    render_opts: dict[str, Any] | None = None,
) -> str | None:
    """Assembler child process. The live generate job does not call this.

    ``_worker_inner`` calls ``render_lyria_master`` instead. Tests still call
    ``execute_prompt_pipeline`` / ``assemble_arranged_buses`` directly.

    A Lyria master (``.wav`` or ``.mp3``) larger than 100KB is returned
    immediately. That path does not read ``result.returncode`` or require
    ``unmastered_mix.wav``.
    """
    opts = dict(render_opts or {})
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
    if opts.get("bpm"):
        cmd += ["--bpm", f"{float(opts['bpm']):.3f}"]
    if opts.get("duration_sec"):
        cmd += ["--duration", f"{float(opts['duration_sec']):.3f}"]
    if opts.get("vocal_mode"):
        cmd += ["--vocal-mode", str(opts["vocal_mode"])]
    if opts.get("key"):
        cmd += ["--key", str(opts["key"])]
    if opts.get("vocal_file"):
        cmd += ["--vocal-file", str(opts["vocal_file"])]
    if not _replicate_token_set():
        cmd.append("--offline")
    result = _run(cmd, cwd=_REPO_ROOT)
    _archive_step_output(session_id, "generate", result.stdout, result.stderr)
    if result.stdout:
        _log("[generate] " + _redact(result.stdout.strip()[-1200:]))
    master = _lyria_master_path(session_id)
    if master:
        return master
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
    _archive_step_output(session_id, "master", result.stdout, result.stderr)
    if result.returncode != 0:
        combined = f"{result.stdout or ''}\n{result.stderr or ''}"
        detail = _redact((result.stderr or result.stdout or "").strip()[-800:])
        if _is_qc_quarantine(RuntimeError(combined)):
            # The gate's wording must reach the caller intact; the 800-char tail
            # of PowerShell's error block can push it out of view.
            raise RuntimeError(
                f"QC compliance gate failed for session {session_id}. "
                f"Upload aborted; scratch quarantined. {detail}"
            )
        raise RuntimeError(f"Master pipeline failed. {detail}")


_QC_QUARANTINE_MARKERS = ("qc compliance gate failed", "scratch quarantined")


def _is_qc_quarantine(exc: BaseException) -> bool:
    """True when the master pipeline aborted on the QC gate, not on a crash.

    The gate's wording is owned by run_master_pipeline.ps1, so match the two
    phrases it is built from rather than the whole sentence, which carries the
    session id and any PowerShell position text.
    """
    text = str(exc or "").lower()
    return all(marker in text for marker in _QC_QUARANTINE_MARKERS)


# Compliance keys the gate reports, paired with the metric that explains them.
_QC_CHECK_METRICS = {
    "streaming_target_met": ("integrated_lufs", "lufs_window", "LUFS"),
    "true_peak_safety_met": ("true_peak_dbtp", "true_peak_ceiling_dbtp", "dBTP"),
    "phase_compatibility_met": ("stereo_phase_correlation", "phase_window", "correlation"),
    "plr_in_band": ("plr_db", "plr_window", "PLR dB"),
    "dc_offset_clean": ("dc_offset", "dc_offset_limit", "DC"),
}


def _qc_failure_hint(session_id: str) -> str:
    """One sentence naming the failed compliance checks and their measurements.

    Only ever decorates an error message, so every failure to read the report
    degrades to a generic pointer instead of masking the original quarantine.
    """
    generic = "No QC report was readable; inspect master_output_qc_report.json."
    report_path = os.path.join(RENDERS_ROOT, session_id, "master_output_qc_report.json")
    try:
        with open(report_path, encoding="utf-8") as handle:
            report = json.load(handle)
        compliance = report.get("compliance") or {}
        metrics = report.get("metrics") or {}
        targets = report.get("targets") or {}
        if not isinstance(compliance, dict):
            return generic
        parts: list[str] = []
        for check, passed in compliance.items():
            if check == "overall_qc_passed" or passed is not False:
                continue
            metric_key, target_key, label = _QC_CHECK_METRICS.get(check, ("", "", ""))
            measured = metrics.get(metric_key)
            target = targets.get(target_key)
            bits = []
            if isinstance(measured, (int, float)):
                bits.append(f"{label} {measured:g}")
            if isinstance(target, (list, tuple)) and len(target) == 2:
                bits.append(f"window {target[0]:g}-{target[1]:g}")
            elif isinstance(target, (int, float)):
                bits.append(f"limit {target:g}")
            parts.append(f"{check} ({', '.join(bits)})" if bits else check)
        if not parts:
            return "The QC report lists no failed check; re-run the QC analyzer."
        return f"Failed: {'; '.join(parts)}."
    except (OSError, ValueError, TypeError, AttributeError):
        return generic


def _publish_lyria_master(session_id: str, src: str) -> dict[str, Any]:
    """Copy the Lyria WAV into the stream assets and return job URL fields.

    Gate 1 opens ``master_url`` / ``audio_filename``. Those always name
    ``{session_id}_master.wav``. An original MP3 sidecar is published only
    when it is already on disk; a missing MP3 does not fail the WAV.
    """
    from engine.generate_track_headless import assert_lyria_master_wav

    if not src or not os.path.isfile(src):
        raise RuntimeError(f"Lyria did not write a master for {session_id}")
    assert_lyria_master_wav(src)
    filename = f"{session_id}_master.wav"
    dest = os.path.join(ASSETS_ROOT, filename)
    os.makedirs(ASSETS_ROOT, exist_ok=True)
    if os.path.abspath(src) != os.path.abspath(dest):
        shutil.copy2(src, dest)
    url = f"/api/stream/{filename}"
    published: dict[str, Any] = {
        "audio_filename": filename,
        "audio_mime": MIME_BY_EXT.get(".wav", "audio/wav"),
        "master_url": url,
    }
    raw_mp3 = os.path.join(os.path.dirname(os.path.abspath(src)), f"{session_id}_master.mp3")
    if os.path.isfile(raw_mp3):
        mp3_name = f"{session_id}_master.mp3"
        dest_mp3 = os.path.join(ASSETS_ROOT, mp3_name)
        try:
            if os.path.abspath(raw_mp3) != os.path.abspath(dest_mp3):
                shutil.copy2(raw_mp3, dest_mp3)
            published["mp3_url"] = f"/api/stream/{mp3_name}"
        except OSError as exc:
            _log(f"[LYRIA] mp3 sidecar skipped for {session_id}: {exc}")
    return published


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


def _try_module5_delivery(session_id: str, prompt: str, genre_hint: str) -> dict[str, Any]:
    """Best-effort Module 5 package from conducted plan or existing master WAV."""
    package_dir = os.path.join(DELIVERIES_ROOT, session_id)
    os.makedirs(package_dir, exist_ok=True)
    fields: dict[str, Any] = {}

    # Prefer full conducted pipe when a song_plan sidecar exists.
    plan_path = os.path.join(SCRATCH_ROOT, session_id, "song_plan.json")
    arrangement_path = os.path.join(SCRATCH_ROOT, session_id, "arrangement.json")
    arrangement: dict[str, Any] | None = None
    if os.path.isfile(arrangement_path):
        try:
            with open(arrangement_path, encoding="utf-8") as fh:
                arrangement = json.load(fh)
        except (OSError, json.JSONDecodeError):
            arrangement = None
    if arrangement is None and os.path.isfile(plan_path):
        try:
            with open(plan_path, encoding="utf-8") as fh:
                plan = json.load(fh)
            arrangement = {"song_plan": plan, "seed": plan.get("seed", 0)}
        except (OSError, json.JSONDecodeError):
            arrangement = None

    if isinstance(arrangement, dict) and isinstance(arrangement.get("song_plan"), dict):
        from engine.local_song_conductor import deliver_conducted_track

        result = deliver_conducted_track(
            arrangement,
            project_dir=package_dir,
            session_id=session_id,
            report_dir=package_dir,
            public_base_url="/api/stream",
            index_db=_resolve_index(),
            memory_db=os.path.join(SCRATCH_ROOT, session_id, "engine_memory.db"),
        )
        published = _publish_delivery_package(session_id, package_dir)
        mastering = result.get("mastering")
        provenance = result.get("provenance")
        fields.update(published)
        if mastering is not None:
            fields["integrated_lufs"] = getattr(
                mastering, "integrated_lufs", None
            ) or (mastering.get("integrated_lufs") if isinstance(mastering, dict) else None)
            fields["true_peak_dbtp"] = getattr(
                mastering, "true_peak_dbtp", None
            ) or (mastering.get("true_peak_dbtp") if isinstance(mastering, dict) else None)
        if provenance is not None:
            fields.update(_provenance_public_fields(provenance))
        fields["song_plan"] = arrangement.get("song_plan")
        return fields

    # Blueprint path: master the session mix and package the real bus stems
    # the assembler wrote next to it.
    mix_path = os.path.join(SCRATCH_ROOT, session_id, "unmastered_mix.wav")
    if not os.path.isfile(mix_path):
        raise RuntimeError(f"No unmastered session mix for Module 5: {mix_path}")

    import soundfile as sf
    import numpy as np
    from engine.mastering_bus import MasteringBus
    from engine.provenance_guard import ProvenanceGuard
    from engine.stem_packager import StemPackager

    song_plan, plan_bpm, seed = _load_session_plan(session_id)
    audio, sr = sf.read(mix_path, always_2d=True)
    audio = np.asarray(audio, dtype=np.float64)
    stems = _load_bus_stems(session_id, audio.shape[0])

    # Raises LoudnessComplianceError before anything is packaged or published.
    bus = MasteringBus(
        target_lufs=float(song_plan.get("master_lufs_target") or -14.0),
        ceiling_dbtp=float(song_plan.get("true_peak_limit") or -1.0),
        enforce_compliance=True,
    )
    mastered, report = bus.process(audio, int(sr))
    guard = ProvenanceGuard(bpm=plan_bpm, sr=int(sr))
    try:
        mastered, stems, prov = guard.check(mastered, stems=stems, seed=seed)
    finally:
        guard.close()
    if prov.transforms_applied:
        mastered, report = bus.process(mastered, int(sr))

    extra: dict[str, Any] = {
        "source": "blueprint_bus_stems",
        "bus_stems_dir": os.path.join(SCRATCH_ROOT, session_id, "bus_stems"),
        "request": {"prompt": prompt[:200], "genre_hint": genre_hint},
    }
    quality_path = os.path.join(SCRATCH_ROOT, session_id, "quality_report.json")
    if os.path.isfile(quality_path):
        with open(quality_path, encoding="utf-8") as fh:
            extra["quality"] = json.load(fh)
    packager = StemPackager(package_dir, sr=int(sr))
    packager.package(
        master=mastered,
        stems=stems,
        song_plan=song_plan,
        mastering=report,
        provenance=prov,
        session_id=session_id,
        extra_manifest=extra,
    )
    del audio, mastered, stems
    published = _publish_delivery_package(session_id, package_dir)
    fields.update(published)
    fields["integrated_lufs"] = report.integrated_lufs
    fields["true_peak_dbtp"] = report.true_peak_dbtp
    fields.update(_provenance_public_fields(prov))
    fields["song_plan"] = song_plan
    return fields


def _load_session_plan(session_id: str) -> tuple[dict[str, Any], float, int]:
    """``(song_plan, bpm, seed)`` from ``{session_id}_blueprint.json``."""
    path = os.path.join(SCRATCH_ROOT, session_id, f"{session_id}_blueprint.json")
    if not os.path.isfile(path):
        raise RuntimeError(f"No blueprint for Module 5 (song plan / BPM unknown): {path}")
    with open(path, encoding="utf-8") as fh:
        blueprint = json.load(fh)
    arrangement = blueprint.get("arrangement") or {}
    song_plan = arrangement.get("song_plan") if isinstance(arrangement, dict) else None
    song_plan = dict(song_plan) if isinstance(song_plan, dict) else {}
    meta = blueprint.get("track_metadata") or {}
    bpm = song_plan.get("bpm") or arrangement.get("bpm") or meta.get("bpm")
    if not bpm or float(bpm) <= 0:
        raise RuntimeError(f"Blueprint has no BPM for provenance segmenting: {path}")
    seed = song_plan.get("seed", arrangement.get("seed", 0))
    return song_plan, float(bpm), int(seed or 0)


def _load_bus_stems(session_id: str, n_samples: int) -> dict[str, Any]:
    """Real per-bus stems written by the assembler, aligned to ``n_samples``."""
    import numpy as np
    import soundfile as sf

    bus_dir = os.path.join(SCRATCH_ROOT, session_id, "bus_stems")
    stems: dict[str, Any] = {}
    for bus in BUS_STEM_NAMES:
        path = os.path.join(bus_dir, f"{bus}.wav")
        if not os.path.isfile(path):
            continue
        data, _sr = sf.read(path, always_2d=True)
        data = np.asarray(data, dtype=np.float64)
        if data.shape[0] < n_samples:
            data = np.pad(data, ((0, n_samples - data.shape[0]), (0, 0)))
        stems[bus] = data[:n_samples]
    if not stems:
        raise RuntimeError(
            f"No bus stems found; refusing to package fabricated stems (looked in {bus_dir})"
        )
    return stems


def _worker(
    session_id: str,
    prompt: str,
    genre_hint: str,
    dry_run: bool,
    render_opts: dict[str, Any] | None = None,
) -> None:
    """Thread entry: wait for a render slot, run the job, then free memory."""
    try:
        if not _RENDER_SLOTS.acquire(blocking=False):
            try:
                _update_job(session_id, note="waiting for a free render slot")
            except KeyError:
                pass
            _RENDER_SLOTS.acquire()
        try:
            _worker_inner(session_id, prompt, genre_hint, dry_run, render_opts)
        finally:
            _RENDER_SLOTS.release()
    finally:
        gc.collect()


def _worker_inner(
    session_id: str,
    prompt: str,
    genre_hint: str,
    dry_run: bool,
    render_opts: dict[str, Any] | None = None,
) -> None:
    use_vocal = False
    try:
        _update_job(session_id, status="running", error=None, note=None)
        if dry_run or _DRY_RUN:
            note = "dry-run: create accepted, pipeline not started"
            _update_job(session_id, status="completed", note=note)
            return
        opts = dict(render_opts or {})
        use_vocal = _voice_sample_ready(opts.get("voice_sample_path"))
        from engine.generate_track_headless import (
            LYRIA_MODEL_ID as _PINNED_LYRIA_MODEL_ID,
            MINIMAX_MODEL_ID as _PINNED_MINIMAX_MODEL_ID,
            MINIMAX_VERSION_ID as _PINNED_MINIMAX_VERSION_ID,
            generation_token_charge,
            render_lyria_master,
            render_minimax_master,
        )

        if (
            LYRIA_MODEL_ID != _PINNED_LYRIA_MODEL_ID
            or MINIMAX_MODEL_ID != _PINNED_MINIMAX_MODEL_ID
            or MINIMAX_VERSION_ID != _PINNED_MINIMAX_VERSION_ID
        ):
            raise RuntimeError("generation model ids drifted")
        duration_raw = opts.get("duration_sec")
        duration_value = float(duration_raw) if duration_raw is not None else None
        # Flat price. A mic job and a long Lyria job are still one token.
        token_charge = generation_token_charge(duration_value)
        _log(f"[TOKEN] charge={token_charge} duration_sec={duration_raw}")
        engine = "Lyria"
        route_model = MINIMAX_MODEL_ID if use_vocal else LYRIA_MODEL_ID
        _log(f"[ROUTE] model={route_model} vocal={use_vocal}")
        if use_vocal:
            saved = _render_minimax_master(
                session_id,
                prompt,
                genre_hint,
                opts,
                render_minimax_master,
            )
        else:
            saved = render_lyria_master(
                os.path.join(SCRATCH_ROOT, session_id),
                style=_style_with_controls(str(opts.get("style") or ""), opts),
                prompt=prompt,
                lyrics=str(opts.get("lyrics") or ""),
                session_id=session_id,
                duration_sec=duration_value,
            )
        published = _publish_lyria_master(session_id, saved)
        _log(
            f"[{engine}] session={session_id} genre={genre_hint!r} "
            f"file={published.get('audio_filename')} master_url={published.get('master_url')}"
        )
        _update_job(
            session_id,
            status="completed",
            error=None,
            note=None,
            delivery_status="completed",
            delivery_error=None,
            engine_used=engine,
            token_cost=1,
            **published,
        )
    except Exception as exc:
        if use_vocal:
            raw = exc.detail if isinstance(exc, HTTPException) else str(exc)
            raw = _redact(str(raw or ""))
            prefix = "Voice API failed:"
            if raw.startswith(prefix):
                raw = raw[len(prefix):].strip()
            print(f"CRITICAL REPLICATE ERROR: {type(exc).__name__} - {raw}", flush=True)
            traceback.print_exc()
            voice_detail = f"{prefix} {raw}"[:800]
            try:
                _update_job(
                    session_id,
                    status="failed",
                    error=voice_detail,
                    detail=voice_detail,
                    engine_used="Lyria",
                    token_cost=1,
                )
            except KeyError:
                pass
        else:
            _console_exception(f"[worker] {session_id} failed: {exc}")
            try:
                prefix = "Lyria generation failed"
                detail = _redact(str(exc))[:700]
                if not detail.startswith(prefix):
                    detail = f"{prefix}: {detail}"
                _update_job(
                    session_id,
                    status="failed",
                    error=detail[:800],
                    engine_used="Lyria",
                    token_cost=1,
                )
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


def _require_worker_token(request: Request) -> None:
    """When HYBRID_WORKER_TOKEN is set, tunneled / public callers must present it."""
    expected = (os.environ.get("HYBRID_WORKER_TOKEN") or "").strip()
    if not expected:
        return
    got = (request.headers.get("x-hybrid-worker-token") or "").strip()
    if not got:
        auth = request.headers.get("authorization") or ""
        if auth.lower().startswith("bearer "):
            got = auth[7:].strip()
    if not hmac.compare_digest(got, expected):
        raise HTTPException(status_code=401, detail="worker token required")


class CreateTrackBody(BaseModel):
    prompt: str = ""
    genre_hint: str | None = Field(default=None, max_length=120)
    genre: str | None = Field(default=None, max_length=120)
    genre_lock: str | None = Field(default=None, max_length=120)
    style: str | None = Field(default=None, max_length=6000)
    lyrics: str | None = Field(default=None, max_length=LYRICS_MAX)
    title: str | None = Field(default=None, max_length=200)
    dry_run: bool = False
    # Optional arrangement length: bars (quarter-note 4/4 bars) at ``bpm``.
    bars: int | None = Field(default=None, ge=4, le=256)
    bpm: float | None = Field(default=None, ge=60.0, le=200.0)
    # Target length in seconds. ``duration`` is the studio field and wins over bars.
    duration: float | None = Field(default=None, ge=10.0, le=420.0)
    duration_sec: float | None = Field(default=None, ge=10.0, le=420.0)
    # lead = lyrics expected, adlib = no lyrics, none = instrumental.
    vocal_mode: str | None = Field(default=None, max_length=16)
    key: str | None = Field(default=None, max_length=24)
    # Accepted and ignored. Generation is always one master.
    num_outputs: int | None = Field(default=1)


DEFAULT_RENDER_SECONDS = 210.0
DEFAULT_RENDER_BPM = 110.0
VOCAL_MODES = frozenset({"lead", "adlib", "none"})
_VOCAL_CACHE_PREFERRED = r"D:\audio_cache\vocals"


def _vocal_cache_dir() -> str:
    try:
        os.makedirs(_VOCAL_CACHE_PREFERRED, exist_ok=True)
        return _VOCAL_CACHE_PREFERRED
    except OSError:
        path = os.path.join(SCRATCH_ROOT, "temp_vocals")
        os.makedirs(path, exist_ok=True)
        return path


def _form_text(form: Any, *keys: str, default: str = "") -> str:
    for key in keys:
        raw = form.get(key)
        if raw is None:
            continue
        text = str(raw).strip()
        if text:
            return text
    return default


def _form_float(form: Any, key: str, default: float | None = None) -> float | None:
    raw = form.get(key)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def _form_int(form: Any, key: str, default: int | None = None) -> int | None:
    raw = form.get(key)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return int(float(raw))
    except (TypeError, ValueError):
        return default


def _voice_sample_ready(path: Any) -> bool:
    """True when a saved take is a real file. Missing or empty stays on Lyria."""
    ref = str(path or "").strip()
    if not ref or not os.path.isfile(ref):
        return False
    try:
        return os.path.getsize(ref) >= 64
    except OSError:
        return False


def _control_number(opts: dict[str, Any], key: str) -> float | None:
    raw = opts.get(key)
    if raw is None or str(raw).strip() == "":
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _style_with_controls(style: str, opts: dict[str, Any]) -> str:
    """Fold slider values into the Lyria style string. Lyria itself stays prompt-only."""
    bpm = _control_number(opts, "bpm")
    weirdness = _control_number(opts, "weirdness")
    influence = _control_number(opts, "audio_influence")
    style_influence = _control_number(opts, "style_influence")
    directives: list[str] = []
    if bpm is not None:
        directives.append(f"[Tempo: {int(round(bpm))} BPM]")
    if style_influence is not None:
        directives.append(f"[Style Influence: {int(round(style_influence))}%]")
    if influence is not None:
        directives.append(f"[Adherence: {int(round(influence))}%]")
    if weirdness is not None:
        clamped = min(100.0, max(0.0, weirdness))
        temperature = round(0.6 + (clamped / 100.0) * 0.7, 2)
        directives.append(f"[Temperature: {temperature}]")
    base = (style or "").strip()
    if not directives:
        return base
    return f"{base} {' '.join(directives)}".strip()


def _render_minimax_master(
    session_id: str,
    prompt: str,
    genre_hint: str,
    opts: dict[str, Any],
    render_minimax_master: Any,
) -> str:
    """One music-2.6 prediction. ``ref_vocal.wav`` stays on disk and is not sent.

    Duration does not add a second call. Lyria and ffmpeg are not used.
    """
    vocal_path = os.path.abspath(str(opts.get("voice_sample_path") or ""))
    root = os.path.abspath(SCRATCH_ROOT)
    session_dir = os.path.abspath(os.path.join(root, session_id))
    master_path = os.path.abspath(os.path.join(session_dir, f"{session_id}_master.wav"))
    if (
        not _is_under(session_dir, root)
        or not _is_under(master_path, root)
        or not _is_under(vocal_path, root)
    ):
        raise RuntimeError("vocal path escaped scratch")
    if os.path.basename(vocal_path) != "ref_vocal.wav":
        raise RuntimeError("vocal job expected ref_vocal.wav")
    if os.path.abspath(vocal_path) == master_path:
        raise RuntimeError("refusing to overwrite ref_vocal.wav")
    style = str(opts.get("style") or "").strip()
    genre = (genre_hint or "").strip()
    genre_prompt = style or genre or (prompt or "").strip()
    bpm = _control_number(opts, "bpm")
    if bpm is None:
        bpm = DEFAULT_RENDER_BPM
    saved = render_minimax_master(
        session_dir,
        genre_prompt=genre_prompt,
        bpm=bpm,
        session_id=session_id,
    )
    if os.path.abspath(saved) == vocal_path:
        raise RuntimeError("refusing to overwrite ref_vocal.wav")
    return saved


def _save_ref_vocal(session_id: str, raw: bytes) -> str:
    """Write the raw take to ``scratch/{session_id}/ref_vocal.wav``."""
    root = os.path.abspath(SCRATCH_ROOT)
    session_dir = os.path.abspath(os.path.join(root, session_id))
    dest = os.path.abspath(os.path.join(session_dir, "ref_vocal.wav"))
    if not _is_under(session_dir, root) or not _is_under(dest, root):
        raise ValueError("invalid session_id")
    os.makedirs(session_dir, exist_ok=True)
    tmp = dest + ".part"
    try:
        with open(tmp, "wb") as handle:
            handle.write(raw)
        os.replace(tmp, dest)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    return dest


async def _read_upload_bytes(upload: Any) -> bytes:
    if upload is None:
        return b""
    reader = getattr(upload, "read", None)
    if reader is None:
        handle = getattr(upload, "file", None)
        return handle.read() if handle is not None else b""
    data = reader()
    if hasattr(data, "__await__"):
        data = await data
    return data or b""


async def _ingest_vocal_upload(upload: Any, root_key: str) -> tuple[str | None, float]:
    """Save browser blob → FFmpeg PCM WAV. Pitch snap waits for the conductor.

    Returns ``(pcm_wav_path, duration_sec)``. Logs ``[VOICE]`` whether a file
    arrived so Generate clicks are auditable. ``root_key`` is the form hint
    only — ``generate_track_headless`` retunes to the locked key + mode.
    """
    filename = getattr(upload, "filename", None) if upload is not None else None
    if not upload or not filename:
        _log("[VOICE] Upload received: None")
        _log("[VOICE INGEST] No vocal payload received on /generate.")
        return None, 0.0
    content_type = getattr(upload, "content_type", "") or ""
    _log(f"[VOICE] Upload received: {filename}")
    _log(f"[VOICE INGEST] Received voice take: {filename}, Content-Type: {content_type}")
    raw = await _read_upload_bytes(upload)
    if len(raw) < 64:
        _log("[VOICE INGEST] vocal_file was empty after read")
        return None, 0.0
    try:
        from engine.vocal_ingest import duration_from_vocal_file, persist_uploaded_vocal

        pcm = persist_uploaded_vocal(raw, str(filename), _vocal_cache_dir())
        vocal_sec = duration_from_vocal_file(pcm)
        _log(
            f"[VOICE INGEST] pcm={pcm} vocal_sec={vocal_sec:.2f} "
            f"key_hint={root_key or 'G'} (tune deferred until conductor lock)"
        )
        return pcm, vocal_sec
    except Exception as exc:
        _log(f"[VOICE INGEST] failed: {type(exc).__name__}: {exc}")
        return None, 0.0


def _accepted_create_body(session_id: str | None, **fields: Any) -> dict[str, Any]:
    """Accepted create payload. The same session id is exposed under every alias.

    A newly queued render is ``pending`` until the wav exists. Callers may pass
    a more specific status when joining a job that is already in flight.
    ``token_cost`` stays 1. ``vocal_present`` is always a boolean.
    """
    sid = str(session_id or "").strip()
    status = str(fields.get("status") or "").strip() or "pending"
    body: dict[str, Any] = {
        "success": True,
        "status": status,
        "session_id": sid,
        "sessionId": sid,
        "track_id": sid,
        "id": sid,
        "token_cost": 1,
        "vocal_present": bool(fields.get("vocal_present", False)),
    }
    body.update(fields)
    body["success"] = True
    body["session_id"] = sid
    body["sessionId"] = sid
    body["track_id"] = sid
    body["id"] = sid
    body["token_cost"] = 1
    body["vocal_present"] = bool(body.get("vocal_present"))
    if not str(body.get("status") or "").strip():
        body["status"] = "pending"
    return body


def _join_active_generation() -> dict[str, Any] | None:
    """Claim the worker, or join the session that already owns it.

    The claim happens before the request body is read. Three POSTs that arrive
    together cannot all pass the await and each start a thread.
    """
    global _active_session_id
    with _registry_lock:
        if not _generation_lock.acquire(blocking=False):
            return _accepted_create_body(
                _active_session_id,
                status="already_running",
                vocal_present=False,
                deduped=True,
            )
        for existing in _jobs.values():
            if str(existing.get("status") or "") in {"queued", "running"}:
                _active_session_id = str(existing["session_id"])
                _generation_lock.release()
                return _accepted_create_body(
                    _active_session_id,
                    status=str(existing.get("status") or "queued"),
                    vocal_present=bool(existing.get("vocal_present")),
                    deduped=True,
                )
        _active_session_id = "ht_" + uuid.uuid4().hex[:12]
        return None


def _release_generation_claim() -> None:
    try:
        _generation_lock.release()
    except RuntimeError:
        return


def _enqueue_generate(
    prompt: str,
    genre: str,
    *,
    dry_run: bool,
    render_opts: dict[str, Any],
    requested_bars: int | None,
    requested_bpm: float | None,
    session_id: str | None = None,
) -> dict[str, Any]:
    """One in-flight render. A timed-out client retry joins that session."""
    global _active_session_id
    with _registry_lock:
        for existing in _jobs.values():
            if str(existing.get("status") or "") in {"queued", "running"}:
                return _accepted_create_body(
                    str(existing["session_id"]),
                    status=str(existing.get("status") or "queued"),
                    vocal_present=bool(existing.get("vocal_present")),
                    deduped=True,
                )
        session_id = session_id or ("ht_" + uuid.uuid4().hex[:12])
        _active_session_id = session_id
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
            "requested_bars": requested_bars,
            "requested_bpm": requested_bpm,
            "master_duration_sec": render_opts.get("duration_sec"),
            "vocal_present": bool(render_opts.get("vocal_file") or render_opts.get("voice_sample_path")),
            "engine_used": render_opts.get("engine_used") or "Lyria",
            "token_cost": 1,
        }
        _jobs[session_id] = job
    try:
        _persist_job(job)
    except Exception as exc:
        with _registry_lock:
            _jobs.pop(session_id, None)
        _console_exception(f"[create] persist failed: {exc}")
        raise HTTPException(status_code=500, detail="could not persist job") from exc
    thread = threading.Thread(
        target=_worker,
        args=(session_id, prompt, genre, bool(dry_run), render_opts),
        name=f"headless-{session_id}",
        daemon=True,
    )
    thread.start()
    return _accepted_create_body(
        session_id,
        status="pending",
        vocal_present=bool(render_opts.get("vocal_file") or render_opts.get("voice_sample_path")),
        engine_used=render_opts.get("engine_used") or "Lyria",
        token_cost=1,
        status_url=f"/api/tracks/status/{session_id}",
    )


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


def _readable_body_error(exc: Any) -> str:
    """Pydantic's error list is a JSON dump. Return one sentence instead."""
    errors = exc.errors() if hasattr(exc, "errors") else []
    for err in errors:
        loc = err.get("loc") or ()
        loc_text = ".".join(str(part) for part in loc)
        kind = str(err.get("type") or "")
        if "lyrics" in loc_text and (
            "too_long" in kind or "too_big" in kind or "string_too_long" in kind
        ):
            return LYRICS_TOO_LONG
    if errors:
        msg = str(errors[0].get("msg") or "").strip()
        if msg:
            return msg
    return "The track setup was invalid."


async def _fulfill_create_track(request: Request) -> dict[str, Any]:
    """Read the create body and queue the session claimed by ``_join_active_generation``."""
    content_type = (request.headers.get("content-type") or "").lower()
    vocal_path: str | None = None
    vocal_sec = 0.0
    style = ""
    lyrics = ""
    if "multipart/form-data" in content_type:
        form = await request.form()
        style = _form_text(form, "style")
        lyrics = _form_text(form, "lyrics")
        user_prompt = _form_text(form, "prompt")
        prompt = user_prompt or _form_text(form, "title", "style")
        genre = _form_text(form, "genre_hint", "genre", "genre_lock", "style")
        title = _form_text(form, "title")
        if title and not prompt:
            prompt = title
        requested_bpm_value = _form_float(form, "bpm")
        if requested_bpm_value is None:
            requested_bpm_value = _form_float(form, "tempo")
        bpm = requested_bpm_value or DEFAULT_RENDER_BPM
        duration_sec = _form_float(form, "duration")
        if duration_sec is None:
            duration_sec = _form_float(form, "duration_sec")
        bars = _form_int(form, "bars")
        vocal_mode = _form_text(form, "vocal_mode").lower()
        key = _form_text(form, "key", default="G")
        dry_run = _form_text(form, "dry_run").lower() in {"1", "true", "yes"}
        weirdness = _form_float(form, "weirdness")
        audio_influence = _form_float(form, "audio_influence")
        style_influence = _form_float(form, "style_influence")
        voice_upload = form.get("voice_sample")
        voice_name = getattr(voice_upload, "filename", None) if voice_upload is not None else None
        upload = form.get("vocal_file") or form.get("vocal_audio.wav")
        vocal_path, vocal_sec = await _ingest_vocal_upload(upload, key)
    else:
        try:
            payload = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="prompt is required")
        try:
            body = CreateTrackBody.model_validate(payload)
        except Exception as exc:
            if type(exc).__name__ == "ValidationError" and hasattr(exc, "errors"):
                raise HTTPException(status_code=400, detail=_readable_body_error(exc)) from exc
            raise
        style = (body.style or "").strip()
        lyrics = (body.lyrics or "").strip()
        user_prompt = (body.prompt or "").strip()
        prompt = (user_prompt or body.title or body.style or "").strip()
        genre = (
            body.genre_hint or body.genre or body.genre_lock or body.style or ""
        ).strip()
        requested_bpm_value = float(body.bpm) if body.bpm is not None else None
        bpm = requested_bpm_value if requested_bpm_value is not None else DEFAULT_RENDER_BPM
        weirdness = None
        audio_influence = None
        style_influence = None
        voice_name = None
        voice_upload = None
        duration_sec = body.duration if body.duration is not None else body.duration_sec
        bars = body.bars
        vocal_mode = (body.vocal_mode or "").strip().lower()
        key = (body.key or "G").strip() or "G"
        dry_run = bool(body.dry_run)
        _log("[VOICE] Upload received: None")
        _log("[VOICE INGEST] No vocal payload received on /generate.")
    if len(lyrics) > LYRICS_MAX:
        raise HTTPException(status_code=400, detail=LYRICS_TOO_LONG)
    if user_prompt and len(user_prompt) < MIN_PROMPT:
        raise HTTPException(status_code=400, detail=PROMPT_TOO_SHORT)
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")
    if len(prompt) > MAX_PROMPT:
        raise HTTPException(status_code=400, detail=f"prompt exceeds {MAX_PROMPT} characters")
    _log(
        f"[API_PAYLOAD] prompt_chars={len(prompt)} genre={genre!r} "
        f"brain_loaded={_brain_health.get('loaded')} vocal_file={bool(vocal_path)}"
    )
    if not genre and not prompt:
        raise HTTPException(status_code=400, detail="prompt and genre_hint are empty")
    if bars is not None and requested_bpm_value is None:
        raise HTTPException(status_code=400, detail="bars requires bpm")
    # One master. num_outputs above 1 is not a batch.
    render_opts: dict[str, Any] = {"bpm": float(bpm), "key": key, "num_outputs": 1}
    if weirdness is not None:
        render_opts["weirdness"] = float(weirdness)
    if audio_influence is not None:
        render_opts["audio_influence"] = float(audio_influence)
    if style_influence is not None:
        render_opts["style_influence"] = float(style_influence)
    voice_sample_path: str | None = None
    if voice_upload is not None and voice_name and hasattr(voice_upload, "read"):
        raw_take = await _read_upload_bytes(voice_upload)
        if len(raw_take) > 25 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="voice_sample is too large")
        if len(raw_take) >= 64:
            try:
                voice_sample_path = _save_ref_vocal(str(_active_session_id or ""), raw_take)
            except Exception as exc:
                _console_exception(f"[VOCAL] could not save ref_vocal.wav: {exc}")
                raise HTTPException(status_code=500, detail=f"could not save ref_vocal.wav: {exc}") from exc
            render_opts["voice_sample_path"] = voice_sample_path
            render_opts["engine_used"] = "Lyria"
            _log(f"[VOCAL] ref_vocal={voice_sample_path} bytes={len(raw_take)}")
    if voice_sample_path:
        if duration_sec is not None:
            render_opts["duration_sec"] = float(duration_sec)
        elif bars is not None:
            render_opts["duration_sec"] = float(bars) * 4.0 * 60.0 / float(bpm)
        else:
            render_opts["duration_sec"] = DEFAULT_RENDER_SECONDS
    elif vocal_path and vocal_sec > 0:
        from engine.vocal_ingest import song_length_from_vocal

        render_opts["duration_sec"] = song_length_from_vocal(vocal_sec, float(bpm))
        render_opts["vocal_file"] = vocal_path
        render_opts["vocal_mode"] = "lead"
    elif duration_sec is not None:
        render_opts["duration_sec"] = float(duration_sec)
    elif bars is not None:
        render_opts["duration_sec"] = float(bars) * 4.0 * 60.0 / float(bpm)
    else:
        render_opts["duration_sec"] = DEFAULT_RENDER_SECONDS
    if vocal_mode in VOCAL_MODES and "vocal_mode" not in render_opts:
        render_opts["vocal_mode"] = vocal_mode
    if style:
        render_opts["style"] = style
    if lyrics:
        render_opts["lyrics"] = lyrics
    _log(
        f"[API_LENGTH] bpm={float(bpm):.1f} duration_sec={render_opts['duration_sec']:.1f} "
        f"bars={round(render_opts['duration_sec'] * float(bpm) / 240.0)} "
        f"vocal_mode={render_opts.get('vocal_mode', 'auto')} "
        f"vocal_present={bool(render_opts.get('vocal_file') or render_opts.get('voice_sample_path'))}"
    )
    computed_bars = round(render_opts["duration_sec"] * float(bpm) / 240.0)
    return _enqueue_generate(
        prompt,
        genre,
        dry_run=dry_run,
        render_opts=render_opts,
        requested_bars=bars if bars is not None else computed_bars,
        requested_bpm=requested_bpm_value,
        session_id=_active_session_id,
    )


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
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "X-Hybrid-Worker-Token"],
    )

    @app.get("/health")
    def health() -> dict[str, Any]:
        with _registry_lock:
            busy = any(
                str(job.get("status") or "") in {"queued", "running"}
                for job in _jobs.values()
            )
        return {
            "status": "ok" if _brain_health.get("loaded") else "degraded",
            "is_busy": busy,
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
    async def create_track(request: Request) -> dict[str, Any]:
        """JSON body *or* multipart/form-data with ``vocal_file``.

        Chrome MediaRecorder sends WebM/Opus. A Pydantic JSON body would drop
        that blob; multipart is required so FFmpeg can transcode it to WAV.
        """
        _require_worker_token(request)
        joined = _join_active_generation()
        if joined is not None:
            return joined
        try:
            return await _fulfill_create_track(request)
        finally:
            _release_generation_claim()

    @app.delete("/api/tracks/{session_id}")
    def delete_track(session_id: str, request: Request) -> dict[str, Any]:
        """Drop a scratch session so a failed run does not keep its WAV/MP3."""
        _require_worker_token(request)
        session_id = (session_id or "").strip()
        if (
            not session_id
            or session_id in {".", ".."}
            or "/" in session_id
            or "\\" in session_id
        ):
            raise HTTPException(status_code=400, detail="invalid session")
        session_dir = os.path.abspath(os.path.join(SCRATCH_ROOT, session_id))
        if not _is_under(session_dir, os.path.abspath(SCRATCH_ROOT)):
            raise HTTPException(status_code=400, detail="invalid session")
        with _registry_lock:
            _jobs.pop(session_id, None)
        if os.path.isdir(session_dir):
            shutil.rmtree(session_dir, ignore_errors=True)
        return {"status": "deleted", "session_id": session_id}

    @app.get("/api/tracks/status/{session_id}")
    @app.get("/api/jobs/{session_id}")
    def track_status(session_id: str, request: Request) -> dict[str, Any]:
        _require_worker_token(request)
        job = _lookup_job(session_id)
        if job is None:
            raise HTTPException(status_code=404, detail="unknown session")
        return _public_job(job)

    @app.post("/api/tracks/feedback")
    async def track_feedback(request: Request) -> dict[str, Any]:
        """Implicit verdict on a finished render -- no rating UI.

        ``export`` is a positive on its own. ``play`` is scored by how much was
        heard: a skip inside the first third is the negative example the
        weight-fitting needs, and a full playthrough is a positive. The render
        already logged which stems it offered and staged, so this closes the
        loop by session id.
        """
        _require_worker_token(request)
        try:
            payload = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="json body required")
        session_id = str(payload.get("session_id") or "").strip()
        event = str(payload.get("event") or "").strip().lower()
        if not session_id:
            raise HTTPException(status_code=400, detail="session_id is required")
        if event not in {"export", "play"}:
            raise HTTPException(status_code=400, detail="event must be 'export' or 'play'")
        try:
            position = float(payload.get("position_sec") or 0.0)
            duration = float(payload.get("duration_sec") or 0.0)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="position_sec/duration_sec must be numbers")
        try:
            from engine import mix_history

            conn = mix_history.open_ledger()
            try:
                label = mix_history.record_verdict(
                    conn,
                    session_id,
                    event,
                    position_sec=position,
                    duration_sec=duration,
                )
            finally:
                conn.close()
        except Exception as exc:
            # Feedback is telemetry: never fail a user action because it could
            # not be recorded.
            _log(f"[FEEDBACK] {session_id} {event} not recorded ({exc})")
            return {"recorded": False, "session_id": session_id, "event": event}
        _log(
            f"[FEEDBACK] {session_id} {event} heard={position:.1f}/{duration:.1f}s "
            f"label={label:+.3f}"
        )
        return {"recorded": True, "session_id": session_id, "event": event, "label": label}

    def _voice_json(status_code: int, message: str) -> Response:
        payload = json.dumps({"status": "error", "error": message})
        return Response(content=payload, status_code=status_code, media_type="application/json")

    @app.post("/api/voice/process")
    async def process_voice(request: Request) -> Any:
        """Multipart ``file`` + ``lyrics`` → HeartMuLa vocal wav.

        The prediction runs off the event loop. A failure is a JSON body and
        does not affect other requests or Lyria generation.
        """
        try:
            _require_worker_token(request)
        except HTTPException as exc:
            return _voice_json(int(exc.status_code), str(exc.detail))
        temp_path: str | None = None
        try:
            try:
                form = await request.form()
            except Exception:
                return _voice_json(400, "multipart form is required")
            lyrics = _form_text(form, "lyrics")
            if not lyrics:
                return _voice_json(400, "lyrics are required")
            upload = form.get("file")
            if upload is None or not hasattr(upload, "read"):
                return _voice_json(400, "file is required")
            raw = await _read_upload_bytes(upload)
            if len(raw) < 64:
                return _voice_json(400, "file is empty")
            if len(raw) > 25 * 1024 * 1024:
                return _voice_json(400, "file is too large")
            session_id = _form_text(form, "session_id") or ("ht_" + uuid.uuid4().hex[:12])
            fd, temp_path = tempfile.mkstemp(suffix=".wav")
            with os.fdopen(fd, "wb") as handle:
                handle.write(raw)
            from services.voice_service import process_voice_track

            vocal_path = await asyncio.to_thread(
                process_voice_track, temp_path, lyrics, session_id
            )
        except ValueError as exc:
            return _voice_json(400, str(exc)[:400] or "invalid voice request")
        except Exception as exc:
            _log(f"[VOICE_PROCESS] failed: {_redact(str(exc))[:400]}")
            return _voice_json(502, _redact(str(exc))[:400] or "voice processing failed")
        finally:
            if temp_path:
                try:
                    os.remove(temp_path)
                except OSError:
                    pass
        return {"status": "ready", "vocal_path": vocal_path}

    @app.get("/api/stream/{filename}")
    def stream_audio(filename: str, request: Request) -> Any:
        _require_worker_token(request)
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
