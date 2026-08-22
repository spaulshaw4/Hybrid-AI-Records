#!/usr/bin/env python3
"""Matchering 2.0 mastering wrapper for Hybrid Engine 1.0.

Usage:
  python scripts/matchering_master.py --target mix.wav --reference ref.wav --out-wav master.wav

Hard limit: 30 seconds. On timeout the process exits 3 so Node can apply the
FFmpeg loudnorm + alimiter fallback and still return a playable MP3.

Requires: pip install matchering
"""
from __future__ import annotations

import argparse
import os
import sys
import threading
from pathlib import Path

MATCHERING_LIMIT_SECONDS = 30


def _abort_for_loudnorm() -> None:
    print(
        "[matchering] 30s limit reached — aborting for FFmpeg loudnorm fallback",
        flush=True,
    )
    os._exit(3)


def main() -> int:
    parser = argparse.ArgumentParser(description="Matchering 2.0 PCM24 master")
    parser.add_argument("--target", required=True, help="Combined raw mix (WAV)")
    parser.add_argument("--reference", required=True, help="Reference master (WAV)")
    parser.add_argument("--out-wav", required=True, help="24-bit PCM WAV output")
    parser.add_argument(
        "--timeout",
        type=float,
        default=MATCHERING_LIMIT_SECONDS,
        help="Seconds before abort (default 30)",
    )
    args = parser.parse_args()

    target = Path(args.target)
    reference = Path(args.reference)
    out_wav = Path(args.out_wav)

    print("[matchering] starting Matchering 2.0 pass", flush=True)

    if not target.is_file():
        sys.stderr.write(f"target not found: {target}\n")
        return 1
    if not reference.is_file():
        sys.stderr.write(f"reference not found: {reference}\n")
        return 1

    print("[matchering] loading matchering library", flush=True)
    try:
        import matchering as mg
    except ImportError:
        sys.stderr.write("matchering is not installed (pip install matchering)\n")
        return 2

    out_wav.parent.mkdir(parents=True, exist_ok=True)

    timer = threading.Timer(max(1.0, float(args.timeout)), _abort_for_loudnorm)
    timer.daemon = True
    timer.start()

    try:
        pcm24 = mg.pcm24(str(out_wav), use_limiter=True, normalize=True)
    except TypeError:
        pcm24 = mg.pcm24(str(out_wav))

    print("[matchering] processing target against reference", flush=True)
    mg.process(
        target=str(target),
        reference=str(reference),
        results=[pcm24],
    )
    timer.cancel()

    if not out_wav.is_file() or out_wav.stat().st_size < 1024:
        sys.stderr.write("matchering produced an empty master\n")
        return 1
    print(f"[matchering] wrote pcm24 master ({out_wav.stat().st_size} bytes)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
