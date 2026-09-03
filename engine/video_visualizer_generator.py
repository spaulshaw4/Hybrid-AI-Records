"""Optional ffmpeg stills / waveform CLI. Not a music-video engine.

If ffmpeg is missing, prints a clear skip and exits 0 on --help / --skip-ok.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys

WINDOWS_FFMPEG = r"C:\ffmpeg\bin\ffmpeg.exe"


def resolve_ffmpeg() -> str | None:
    for env_name in ("FFMPEG_BIN", "FFMPEG", "FFMPEG_PATH"):
        raw = (os.environ.get(env_name) or "").strip().strip('"')
        if raw and os.path.isfile(raw):
            return raw
        found = shutil.which(raw) if raw else None
        if found:
            return found
    if os.path.isfile(WINDOWS_FFMPEG):
        return WINDOWS_FFMPEG
    return shutil.which("ffmpeg")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Write a waveform PNG or a few stills via ffmpeg (no UI)"
    )
    parser.add_argument("-i", "--input", help="Source WAV/MP3")
    parser.add_argument("-o", "--output", help="Destination PNG or folder")
    parser.add_argument("--mode", choices=("waveform", "stills"), default="waveform")
    parser.add_argument("--frames", type=int, default=4)
    args = parser.parse_args()
    ffmpeg = resolve_ffmpeg()
    if ffmpeg is None:
        print("[SKIP] ffmpeg not found — video visualizer disabled (CLI only, no UI).")
        print("       Set FFMPEG_BIN or install C:\\ffmpeg\\bin\\ffmpeg.exe.")
        return 0 if not args.input else 2
    if not args.input or not args.output:
        parser.print_help()
        return 0
    if not os.path.isfile(args.input):
        print(f"[ERROR] missing input: {args.input}", file=sys.stderr)
        return 1
    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    if args.mode == "waveform":
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", args.input,
            "-filter_complex", "showwavespic=s=1280x320:colors=white",
            "-frames:v", "1",
            args.output,
        ]
    else:
        dest_dir = args.output
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, "still_%02d.png")
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", args.input,
            "-vf", "fps=1",
            "-frames:v", str(max(1, args.frames)),
            dest,
        ]
    try:
        subprocess.run(cmd, check=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"[SKIP] ffmpeg failed: {exc}")
        return 2
    print(f"[VIZ] wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
