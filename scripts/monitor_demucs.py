#!/usr/bin/env python3
"""Live Demucs ingest velocity: remaining vault vs completed archive + GPU stats.

On the pod (second terminal, not this Windows session):
  python /workspace/scripts/monitor_demucs.py
"""
from __future__ import annotations

import glob
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ON_POD = Path("/workspace").is_dir()
VAULT = Path("/workspace/.ingest_vault") if ON_POD else ROOT / ".ingest_vault"
COMPLETE = Path("/workspace/.ingest_complete") if ON_POD else ROOT / ".ingest_complete"
REFRESH_SEC = 15
AUDIO_GLOBS = ("*.mp3", "*.wav", "*.flac", "*.ogg")


def _count_audio(folder: Path) -> int:
    if not folder.is_dir():
        return 0
    seen: set[str] = set()
    for pattern in AUDIO_GLOBS:
        for path in glob.glob(str(folder / "**" / pattern), recursive=True):
            seen.add(os.path.abspath(path))
    return len(seen)


def _clear_screen() -> None:
    if os.name == "nt":
        os.system("cls")
    else:
        sys.stdout.write("\033c")
        sys.stdout.flush()


def _gpu_line() -> str:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return "nvidia-smi not on PATH"
    try:
        out = subprocess.check_output(
            [
                exe,
                "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            text=True,
            timeout=5,
        ).strip()
        return out.replace("\n", " | ") or "no GPU rows"
    except Exception as exc:
        return f"nvidia-smi failed: {exc}"


def run() -> None:
    start = time.time()
    start_completed = _count_audio(COMPLETE)
    start_remaining = _count_audio(VAULT)
    env_total = os.environ.get("TOTAL_TRACKS", "").strip()
    if env_total.isdigit():
        total = int(env_total)
    else:
        derived = start_completed + start_remaining
        total = derived if derived > 0 else 2659

    print(
        f"Demucs monitor | vault={VAULT} | complete={COMPLETE} | "
        f"total={total} | refresh={REFRESH_SEC}s"
    )
    print("Ctrl+C to stop.")
    while True:
        completed = _count_audio(COMPLETE)
        remaining = _count_audio(VAULT)
        elapsed_h = max((time.time() - start) / 3600.0, 1e-9)
        newly_done = max(0, completed - start_completed)
        velocity = newly_done / elapsed_h
        eta_h = (remaining / velocity) if velocity > 0 else float("inf")
        eta_txt = f"{eta_h:.2f} h" if velocity > 0 else "n/a"
        pct = (100.0 * completed / total) if total else 0.0

        _clear_screen()
        print("=== Demucs ingest monitor ===")
        print(f"Vault:     {VAULT}")
        print(f"Complete:  {COMPLETE}")
        print(f"Completed: {completed} / {total} ({pct:.1f}%)")
        print(f"Remaining: {remaining}")
        print(f"Velocity:  {velocity:.2f} tracks/h")
        print(f"ETA:       {eta_txt}")
        print(f"GPU:       {_gpu_line()}")
        print(f"Elapsed:   {elapsed_h:.2f} h")
        time.sleep(REFRESH_SEC)


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        print("\nStopped.")
