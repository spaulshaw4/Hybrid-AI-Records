#!/usr/bin/env python3
"""Keep Redis, Celery, and Uvicorn alive on the GPU pod.

Does not stop the pod (see idle_guard.py). Does not restart ingest unless
/workspace/scratch has MP3s or WATCHDOG_RESTART_INGEST=1.

On the pod:
  cd /workspace
  nohup python scripts/watchdog.py > /workspace/watchdog.log 2>&1 &

idle_guard should log separately:
  nohup python scripts/idle_guard.py > /workspace/idle_guard.log 2>&1 &
"""
from __future__ import annotations

import glob
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

WORKSPACE = Path("/workspace")
CHECK_INTERVAL_SEC = 30
HEALTH_URL = "http://127.0.0.1:8000/health"
LOW_MEM_KIB = 262144
_gpu_smi_failed = False


def _load_env() -> None:
    root = Path(__file__).resolve().parents[1]
    for name in (".env.local", ".env"):
        path = root / name
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


def log(msg: str) -> None:
    print(f"[Watchdog] {msg}", flush=True)


def pgrep(pattern: str) -> bool:
    try:
        subprocess.check_output(["pgrep", "-f", pattern], stderr=subprocess.DEVNULL)
        return True
    except FileNotFoundError:
        log("pgrep not found; watchdog is for the Linux pod.")
        raise
    except subprocess.CalledProcessError:
        return False


def run_shell(cmd: str) -> int:
    return subprocess.call(cmd, shell=True)


def scratch_has_mp3() -> bool:
    return bool(glob.glob(str(WORKSPACE / "scratch" / "**" / "*.mp3"), recursive=True))


def ingest_should_run() -> bool:
    if os.environ.get("WATCHDOG_RESTART_INGEST") == "1":
        return True
    return scratch_has_mp3()


def check_gpu() -> None:
    global _gpu_smi_failed
    if _gpu_smi_failed:
        return
    try:
        out = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            stderr=subprocess.STDOUT,
            timeout=10,
        ).decode("utf-8", errors="replace").strip()
        log(f"GPU util/mem (used,total MiB): {out}")
    except Exception as exc:
        _gpu_smi_failed = True
        log(f"nvidia-smi unavailable ({exc}); continuing without GPU checks.")


def check_memory() -> None:
    meminfo = Path("/proc/meminfo")
    if not meminfo.is_file():
        return
    available = None
    for line in meminfo.read_text(encoding="utf-8").splitlines():
        if line.startswith("MemAvailable:"):
            parts = line.split()
            available = int(parts[1])
            break
    if available is not None and available < LOW_MEM_KIB:
        log(f"low MemAvailable={available} kB (threshold {LOW_MEM_KIB} kB)")


def redis_ok() -> bool:
    try:
        out = subprocess.check_output(
            ["redis-cli", "ping"],
            stderr=subprocess.STDOUT,
            timeout=5,
        ).decode("utf-8", errors="replace").strip()
        return out == "PONG"
    except Exception:
        return False


def ensure_redis() -> None:
    if redis_ok():
        return
    log("Redis down; starting redis-server.")
    run_shell("service redis-server start")
    time.sleep(1)
    if redis_ok():
        log("Redis PONG")
    else:
        log("Redis still not responding after start.")


def ensure_celery() -> None:
    if pgrep("celery -A tasks") or pgrep("celery.*tasks"):
        return
    log("Celery missing; restarting worker.")
    run_shell(
        "cd /workspace && PYTHONPATH=/workspace nohup python -m celery -A tasks worker "
        "--loglevel=info --concurrency=4 > /workspace/celery.log 2>&1 &"
    )


def http_health_ok() -> bool:
    try:
        import requests

        res = requests.get(HEALTH_URL, timeout=5)
        return res.status_code == 200
    except Exception:
        pass
    try:
        with urlopen(HEALTH_URL, timeout=5) as resp:
            return 200 <= getattr(resp, "status", 200) < 300
    except (URLError, OSError, TimeoutError):
        return False


def ensure_uvicorn() -> None:
    process_up = pgrep("uvicorn server:app") or pgrep("uvicorn")
    if process_up and http_health_ok():
        return
    if process_up and not http_health_ok():
        log("Uvicorn process up but /health failed; restarting.")
        run_shell("pkill -f uvicorn || true")
        time.sleep(1)
    else:
        log("Uvicorn missing; starting.")
    run_shell(
        "cd /workspace && PYTHONPATH=/workspace nohup python -m uvicorn server:app "
        "--host 0.0.0.0 --port 8000 --workers 2 > /workspace/uvicorn.log 2>&1 &"
    )


def ensure_ingest() -> None:
    if not ingest_should_run():
        return
    if pgrep("ingest_full_fma.py"):
        return
    log("Scratch MP3s present (or WATCHDOG_RESTART_INGEST=1); starting ingest.")
    run_shell(
        "cd /workspace && nohup python scripts/ingest_full_fma.py "
        "> /workspace/ingest.log 2>&1 &"
    )


def loop() -> None:
    if WORKSPACE.is_dir():
        os.chdir(WORKSPACE)
    log(f"Active. interval={CHECK_INTERVAL_SEC}s health={HEALTH_URL}")
    while True:
        try:
            check_gpu()
            check_memory()
            ensure_redis()
            ensure_celery()
            ensure_uvicorn()
            ensure_ingest()
        except Exception as exc:
            log(f"cycle error: {exc}")
        time.sleep(CHECK_INTERVAL_SEC)


def main() -> int:
    _load_env()
    if not WORKSPACE.is_dir() and os.environ.get("WATCHDOG_ALLOW_LOCAL") != "1":
        log(
            "Refusing to run off the pod. Copy to /workspace/scripts/watchdog.py "
            "or set WATCHDOG_ALLOW_LOCAL=1."
        )
        return 1
    if WORKSPACE.is_dir():
        os.chdir(WORKSPACE)
    loop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
