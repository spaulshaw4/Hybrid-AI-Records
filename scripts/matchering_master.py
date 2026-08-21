#!/usr/bin/env python3
"""Matchering 2.0 mastering wrapper for Hybrid Engine 1.0.

Usage:
  python scripts/matchering_master.py --target mix.wav --reference ref.wav --out-wav master.wav

Requires: pip install matchering
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Matchering 2.0 PCM24 master")
    parser.add_argument("--target", required=True, help="Combined raw mix (WAV)")
    parser.add_argument("--reference", required=True, help="Reference master (WAV)")
    parser.add_argument("--out-wav", required=True, help="24-bit PCM WAV output")
    args = parser.parse_args()

    target = Path(args.target)
    reference = Path(args.reference)
    out_wav = Path(args.out_wav)

    if not target.is_file():
        sys.stderr.write(f"target not found: {target}\n")
        return 1
    if not reference.is_file():
        sys.stderr.write(f"reference not found: {reference}\n")
        return 1

    try:
        import matchering as mg
    except ImportError:
        sys.stderr.write("matchering is not installed (pip install matchering)\n")
        return 2

    out_wav.parent.mkdir(parents=True, exist_ok=True)

    # pcm24 + limiter + normalize — Matchering's brickwall stage.
    # MP3 + LUFS are applied by the Node FFmpeg wrapper after this returns.
    try:
        pcm24 = mg.pcm24(str(out_wav), use_limiter=True, normalize=True)
    except TypeError:
        pcm24 = mg.pcm24(str(out_wav))

    mg.process(
        target=str(target),
        reference=str(reference),
        results=[pcm24],
    )
    if not out_wav.is_file() or out_wav.stat().st_size < 1024:
        sys.stderr.write("matchering produced an empty master\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
