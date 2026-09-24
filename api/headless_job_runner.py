"""Localhost headless track-generation API (127.0.0.1:8880).

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
import gc
import hmac
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
# Finalized Module 5 packages: {DELIVERIES_ROOT}/{session_id}/ (master, mp3,
# manifest, stems/, bundle zip). Kept outside scratch so scratch can be purged.
DELIVERIES_ROOT = os.environ.get("HYBRID_DELIVERIES_ROOT") or os.path.join(
    _LIVE["root"], "deliveries"
)
_API_LOG = os.path.join(_REPO_ROOT, "reports", "live_api.out.log")
MAX_PROMPT = 2000
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
        "master_url",
        "mp3_url",
        "zip_url",
        "manifest_url",
        "stem_urls",
        "integrated_lufs",
        "true_peak_dbtp",
        "provenance_hash",
        "provenance_certified",
        "song_plan",
        "package_dir",
        "delivery_status",
        "delivery_error",
        "scratch_purged_bytes",
        "requested_bars",
        "requested_bpm",
        "master_duration_sec",
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
    """
    if (os.environ.get("HYBRID_KEEP_SCRATCH") or "").strip().lower() in {"1", "true", "yes", "on"}:
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
) -> None:
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
            fields["provenance_hash"] = getattr(
                provenance, "certification_hash", None
            ) or (
                provenance.get("certification_hash")
                if isinstance(provenance, dict)
                else None
            )
            fields["provenance_certified"] = getattr(
                provenance, "certified", None
            ) or (
                provenance.get("certified") if isinstance(provenance, dict) else None
            )
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
    fields["provenance_hash"] = prov.certification_hash
    fields["provenance_certified"] = prov.certified
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
    try:
        _update_job(session_id, status="running", error=None, note=None)
        if dry_run or _DRY_RUN:
            note = "dry-run: create accepted, pipeline not started"
            if _headless_script() is None:
                note += "; generate_track_headless.py not present"
            _update_job(session_id, status="completed", note=note)
            return
        python = resolve_workstation_python()
        _log(f"[worker] python={python} session={session_id}")
        _run_headless(python, session_id, prompt, genre_hint, render_opts)
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

        try:
            delivery_fields = _try_module5_delivery(session_id, prompt, genre_hint)
        except Exception as m5_exc:
            from engine.mastering_bus import LoudnessComplianceError

            if isinstance(m5_exc, LoudnessComplianceError):
                detail = f"Loudness compliance failed: {m5_exc.final_lufs:.2f} LUFS"
                _log(f"[worker] {session_id} {m5_exc}")
            else:
                detail = _redact(str(m5_exc))[:400]
            _log(f"[worker] {session_id} Module 5 delivery failed: {detail}")
            _log("[TRACEBACK]\n" + traceback.format_exc())
            # The master stays attached for inspection, but the job is not
            # "completed": callers must not ship a track without its delivery pack.
            _update_job(
                session_id,
                status="failed",
                error=f"Module 5 delivery failed: {detail}",
                audio_filename=filename,
                audio_mime=mime,
                delivery_status="failed",
                delivery_error=detail,
            )
            return
        delivered_name = delivery_fields.pop("audio_filename", None)
        delivered_mime = delivery_fields.pop("audio_mime", None)
        if delivered_name:
            filename = str(delivered_name)
            mime = str(delivered_mime or mime)
        delivery_fields["delivery_status"] = "completed"
        delivery_fields["delivery_error"] = None

        _update_job(
            session_id,
            status="completed",
            audio_filename=filename,
            audio_mime=mime,
            error=None,
            **delivery_fields,
        )
        # The delivery package is published; intermediate audio is redundant.
        try:
            freed = _purge_scratch_audio(session_id)
            _log(f"[cleanup] {session_id} purged {freed / 1e6:.1f} MB of scratch audio")
            _update_job(session_id, scratch_purged_bytes=freed)
        except Exception as cleanup_exc:
            _log(f"[cleanup] {session_id} scratch purge failed: {cleanup_exc}")
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
    style: str | None = Field(default=None, max_length=200)
    title: str | None = Field(default=None, max_length=200)
    dry_run: bool = False
    # Optional arrangement length: bars (quarter-note 4/4 bars) at ``bpm``.
    bars: int | None = Field(default=None, ge=4, le=256)
    bpm: float | None = Field(default=None, ge=60.0, le=200.0)
    # Target length in seconds; used when ``bars`` is absent.
    duration_sec: float | None = Field(default=None, ge=10.0, le=420.0)
    # lead = lyrics expected, adlib = no lyrics, none = instrumental.
    vocal_mode: str | None = Field(default=None, max_length=16)
    key: str | None = Field(default=None, max_length=24)


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


def _enqueue_generate(
    prompt: str,
    genre: str,
    *,
    dry_run: bool,
    render_opts: dict[str, Any],
    requested_bars: int | None,
    requested_bpm: float | None,
) -> dict[str, Any]:
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
        "requested_bars": requested_bars,
        "requested_bpm": requested_bpm,
        "master_duration_sec": render_opts.get("duration_sec"),
        "vocal_present": bool(render_opts.get("vocal_file")),
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
        args=(session_id, prompt, genre, bool(dry_run), render_opts),
        name=f"headless-{session_id}",
        daemon=True,
    )
    thread.start()
    return {
        "session_id": session_id,
        "status": "queued",
        "vocal_present": bool(render_opts.get("vocal_file")),
    }


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
        content_type = (request.headers.get("content-type") or "").lower()
        vocal_path: str | None = None
        vocal_sec = 0.0
        if "multipart/form-data" in content_type:
            form = await request.form()
            prompt = _form_text(form, "prompt", "title", "style")
            genre = _form_text(form, "genre_hint", "genre", "genre_lock", "style")
            title = _form_text(form, "title")
            if title and not prompt:
                prompt = title
            bpm = _form_float(form, "bpm", DEFAULT_RENDER_BPM) or DEFAULT_RENDER_BPM
            duration_sec = _form_float(form, "duration_sec")
            bars = _form_int(form, "bars")
            vocal_mode = _form_text(form, "vocal_mode").lower()
            key = _form_text(form, "key", default="G")
            dry_run = _form_text(form, "dry_run").lower() in {"1", "true", "yes"}
            upload = form.get("vocal_file") or form.get("vocal_audio.wav")
            vocal_path, vocal_sec = await _ingest_vocal_upload(upload, key)
        else:
            try:
                payload = await request.json()
            except Exception:
                raise HTTPException(status_code=400, detail="prompt is required")
            body = CreateTrackBody.model_validate(payload)
            prompt = (body.prompt or body.title or body.style or "").strip()
            genre = (
                body.genre_hint or body.genre or body.genre_lock or body.style or ""
            ).strip()
            bpm = float(body.bpm) if body.bpm is not None else DEFAULT_RENDER_BPM
            duration_sec = body.duration_sec
            bars = body.bars
            vocal_mode = (body.vocal_mode or "").strip().lower()
            key = (body.key or "G").strip() or "G"
            dry_run = bool(body.dry_run)
            _log("[VOICE] Upload received: None")
            _log("[VOICE INGEST] No vocal payload received on /generate.")
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
        if bars is not None and bpm is None:
            raise HTTPException(status_code=400, detail="bars requires bpm")
        render_opts: dict[str, Any] = {"bpm": float(bpm), "key": key}
        if vocal_path and vocal_sec > 0:
            from engine.vocal_ingest import song_length_from_vocal

            render_opts["duration_sec"] = song_length_from_vocal(vocal_sec, float(bpm))
            render_opts["vocal_file"] = vocal_path
            render_opts["vocal_mode"] = "lead"
        elif bars is not None:
            render_opts["duration_sec"] = float(bars) * 4.0 * 60.0 / float(bpm)
        elif duration_sec is not None:
            render_opts["duration_sec"] = float(duration_sec)
        else:
            render_opts["duration_sec"] = DEFAULT_RENDER_SECONDS
        if vocal_mode in VOCAL_MODES and "vocal_mode" not in render_opts:
            render_opts["vocal_mode"] = vocal_mode
        _log(
            f"[API_LENGTH] bpm={float(bpm):.1f} duration_sec={render_opts['duration_sec']:.1f} "
            f"bars={round(render_opts['duration_sec'] * float(bpm) / 240.0)} "
            f"vocal_mode={render_opts.get('vocal_mode', 'auto')} "
            f"vocal_present={bool(vocal_path)}"
        )
        computed_bars = round(render_opts["duration_sec"] * float(bpm) / 240.0)
        return _enqueue_generate(
            prompt,
            genre,
            dry_run=dry_run,
            render_opts=render_opts,
            requested_bars=bars if bars is not None else computed_bars,
            requested_bpm=float(bpm) if bpm is not None else None,
        )

    @app.get("/api/tracks/status/{session_id}")
    @app.get("/api/jobs/{session_id}")
    def track_status(session_id: str, request: Request) -> dict[str, Any]:
        _require_worker_token(request)
        job = _lookup_job(session_id)
        if job is None:
            raise HTTPException(status_code=404, detail="unknown session")
        return _public_job(job)

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
