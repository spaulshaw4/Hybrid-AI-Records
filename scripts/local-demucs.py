#!/usr/bin/env python3
"""Local Demucs stem split for `.ingest_vault` MP3/WAV files.

Usage:
  python scripts/local-demucs.py
  python scripts/local-demucs.py --two-stems vocals
  python scripts/local-demucs.py --device cpu

Requires: ffmpeg on PATH, plus `pip install -U demucs torchaudio soundfile`.
"""
from __future__ import annotations

import argparse
import glob
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUT_DIR = ROOT / ".ingest_vault"
OUTPUT_DIR = ROOT / ".ingest_vault" / "stems_output"


def pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def demucs_cmd() -> list[str]:
    if shutil.which("demucs"):
        return ["demucs"]
    return [sys.executable, "-m", "demucs"]


def main() -> int:
    parser = argparse.ArgumentParser(description="Local Demucs over .ingest_vault")
    parser.add_argument(
        "--two-stems",
        metavar="STEM",
        help="Isolate one stem vs the rest (e.g. vocals). Omit for drums/bass/other/vocals.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=("auto", "cuda", "cpu"),
        help="Demucs device (default: cuda if torch sees a GPU, else cpu)",
    )
    parser.add_argument("-n", "--model", default="htdemucs")
    args = parser.parse_args()

    INPUT_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    audio_files = sorted(
        glob.glob(str(INPUT_DIR / "*.mp3")) + glob.glob(str(INPUT_DIR / "*.wav")),
        key=str.lower,
    )
    print(f"Found {len(audio_files)} tracks ready for separation.")
    if not audio_files:
        print(f"No MP3/WAV files in {INPUT_DIR}", file=sys.stderr)
        return 1

    device = pick_device(args.device)
    print(f"Demucs model={args.model} device={device} out={OUTPUT_DIR}")

    base = demucs_cmd()
    failed = 0
    for idx, track_path in enumerate(audio_files, 1):
        track_name = Path(track_path).stem
        print(f"[{idx}/{len(audio_files)}] Processing: {track_name}")
        cmd = [
            *base,
            "-n",
            args.model,
            "-d",
            device,
            "-o",
            str(OUTPUT_DIR),
        ]
        if args.two_stems:
            cmd.append(f"--two-stems={args.two_stems}")
        cmd.append(track_path)
        result = subprocess.run(cmd)
        if result.returncode != 0:
            failed += 1
            print(f"Failed ({result.returncode}): {track_name}", file=sys.stderr)

    print("Batch processing complete!")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
