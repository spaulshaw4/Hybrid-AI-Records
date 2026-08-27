#!/usr/bin/env python3
"""Stop the Runpod GPU worker after 10 minutes with no Demucs/ffmpeg/stitch work.

On the pod:
  export RUNPOD_API_KEY=...
  export RUNPOD_POD_ID=dmlllpvfenxzw7   # pod id, not the display name
  nohup python /workspace/scripts/idle_guard.py > /workspace/idle_guard.log 2>&1 &
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import requests

IDLE_TIMEOUT_SECONDS = 600
CHECK_INTERVAL = 30
PROCESS_PATTERN = "demucs|ffmpeg|stitch_engine|batch_stream_ingest|celery"

V2_STOP = "https://api.runpod.io/v2/pods/{pod_id}/stop"
V1_STOP = "https://rest.runpod.io/v1/pods/{pod_id}/stop"
V2_LIST = "https://api.runpod.io/v2/pods"


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


def is_demucs_or_ffmpeg_running() -> bool:
    try:
        output = subprocess.check_output(
            ["pgrep", "-f", PROCESS_PATTERN],
            stderr=subprocess.DEVNULL,
        ).decode().strip()
        return len(output) > 0
    except FileNotFoundError:
        print("[Watchdog Error] pgrep not found; idle_guard is for the Linux pod.")
        raise
    except subprocess.CalledProcessError:
        return False


def auth_headers(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"}


def resolve_pod_id(api_key: str, raw: str) -> str:
    """Accept a pod id or a display name; the stop API only accepts the id."""
    candidate = raw.strip()
    if candidate.isalnum() and candidate.islower() and len(candidate) >= 8:
        return candidate

    print(f"[Watchdog] {candidate!r} looks like a name; resolving to a pod id...")
    res = requests.get(V2_LIST, headers=auth_headers(api_key), timeout=30)
    res.raise_for_status()
    payload = res.json()
    items = payload.get("items") or payload.get("pods") or payload
    if isinstance(items, dict):
        items = items.get("items") or []
    for pod in items:
        if not isinstance(pod, dict):
            continue
        if pod.get("name") == candidate or pod.get("id") == candidate:
            pod_id = str(pod.get("id") or "")
            if pod_id:
                print(f"[Watchdog] Resolved {candidate!r} -> {pod_id}")
                return pod_id
    raise RuntimeError(
        f"Could not resolve RUNPOD_POD_ID={candidate!r} to a pod id. "
        "Set RUNPOD_POD_ID to the id from the Runpod dashboard (not the display name)."
    )


def stop_pod(api_key: str, pod_id: str) -> None:
    print(f"[Watchdog] Inactivity threshold reached. Stopping pod {pod_id}...")
    headers = auth_headers(api_key)
    res = requests.post(V2_STOP.format(pod_id=pod_id), headers=headers, timeout=30)
    if res.status_code >= 400:
        res = requests.post(V1_STOP.format(pod_id=pod_id), headers=headers, timeout=30)
    print(f"[Watchdog] Shutdown response: {res.status_code} - {res.text[:500]}")


def monitor(api_key: str, pod_id: str) -> None:
    print(f"[Watchdog] Active. Monitoring processes on pod {pod_id}...")
    idle_time = 0
    while True:
        time.sleep(CHECK_INTERVAL)
        if is_demucs_or_ffmpeg_running():
            idle_time = 0
            print("[Watchdog] Work in progress; idle timer reset.")
        else:
            idle_time += CHECK_INTERVAL
            print(f"[Watchdog] System idle: {idle_time}/{IDLE_TIMEOUT_SECONDS}s")
            if idle_time >= IDLE_TIMEOUT_SECONDS:
                stop_pod(api_key, pod_id)
                break


def main() -> int:
    _load_env()
    if not Path("/workspace").is_dir() and os.environ.get("IDLE_GUARD_ALLOW_LOCAL") != "1":
        print(
            "[Watchdog] Refusing to run off the pod. Copy this file to "
            "/workspace/scripts/idle_guard.py and start it there, or set "
            "IDLE_GUARD_ALLOW_LOCAL=1 (this can stop your GPU pod)."
        )
        return 1

    api_key = (os.environ.get("RUNPOD_API_KEY") or "").strip()
    if not api_key:
        print("[Watchdog Error] RUNPOD_API_KEY is not set. Exiting.")
        return 1

    raw_id = (os.environ.get("RUNPOD_POD_ID") or "").strip()
    if not raw_id:
        print("[Watchdog Error] RUNPOD_POD_ID is not set. Exiting.")
        return 1

    try:
        pod_id = resolve_pod_id(api_key, raw_id)
    except Exception as exc:
        print(f"[Watchdog Error] {exc}")
        return 1

    monitor(api_key, pod_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
