"""CD-DA cue sheet for a single-track master, with ISRC."""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from audio_metadata_tagger import normalise_isrc  # noqa: E402

CDDA_FRAMES_PER_SEC = 75


def cue_escape(text: str) -> str:
    """Escape backslashes and quotes for TITLE / PERFORMER fields."""
    return str(text).replace("\\", "\\\\").replace('"', '\\"')


def seconds_to_msf(seconds: float) -> str:
    """Format a duration as CD-DA MM:SS:FF (75 frames per second)."""
    total_frames = max(0, int(round(float(seconds) * CDDA_FRAMES_PER_SEC)))
    minutes = total_frames // (CDDA_FRAMES_PER_SEC * 60)
    seconds_part = (total_frames // CDDA_FRAMES_PER_SEC) % 60
    frames = total_frames % CDDA_FRAMES_PER_SEC
    return f"{minutes:02d}:{seconds_part:02d}:{frames:02d}"


def compact_isrc(pretty: str) -> str:
    return pretty.replace("-", "")


def build_cue_sheet(
    *,
    title: str,
    performer: str,
    isrc: str,
    file_name: str,
    duration_sec: float,
    genre: str | None = None,
    date_year: int | None = None,
) -> str:
    """
    Build a single-track WAVE cue sheet.

    INDEX 01 is 00:00:00 (one file = one track). Duration is recorded as
    REM DURATION in MM:SS:FF. ``normalise_isrc`` raises on invalid codes.
    """
    pretty = normalise_isrc(isrc)
    year = int(date_year) if date_year is not None else datetime.now().year
    wav_name = os.path.basename(file_name)
    lines = [
        f'REM DATE {year}',
    ]
    if genre:
        lines.append(f'REM GENRE "{cue_escape(genre)}"')
    lines.extend(
        [
            f'REM DURATION {seconds_to_msf(duration_sec)}',
            f'PERFORMER "{cue_escape(performer)}"',
            f'TITLE "{cue_escape(title)}"',
            f'FILE "{cue_escape(wav_name)}" WAVE',
            "  TRACK 01 AUDIO",
            f'    TITLE "{cue_escape(title)}"',
            f'    PERFORMER "{cue_escape(performer)}"',
            f"    ISRC {compact_isrc(pretty)}",
            "    INDEX 01 00:00:00",
        ]
    )
    return "\n".join(lines) + "\n"


def write_cue_sheet(path: str, text: str) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def _duration_from_wav(wav_path: str) -> float:
    import soundfile as sf

    info = sf.info(wav_path)
    if info.samplerate <= 0 or info.frames <= 0:
        raise ValueError(f"Cannot read duration from {wav_path}")
    return float(info.frames) / float(info.samplerate)


def main() -> int:
    parser = argparse.ArgumentParser(description="Write a CD-DA cue sheet for a single-track master.")
    parser.add_argument("-i", "--input", help="Master WAV (duration is read from the file when omitted)")
    parser.add_argument("-o", "--output", help="Cue path. Defaults to stdout.")
    parser.add_argument("--title", required=True)
    parser.add_argument("--performer", "--artist", dest="performer", default="Hybrid AI Records")
    parser.add_argument("--isrc", required=True)
    parser.add_argument("--genre")
    parser.add_argument("--duration", type=float, help="Seconds; required if --input is omitted")
    parser.add_argument("--year", type=int, help="REM DATE year (defaults to the current year)")
    parser.add_argument("--file-name", help="FILE line basename (defaults to --input basename)")
    args = parser.parse_args()

    duration = args.duration
    file_name = args.file_name
    if args.input:
        file_name = file_name or os.path.basename(args.input)
        if duration is None:
            duration = _duration_from_wav(args.input)
    if not file_name:
        parser.error("provide --input or --file-name")
    if duration is None:
        parser.error("provide --duration or --input so duration can be computed")

    text = build_cue_sheet(
        title=args.title,
        performer=args.performer,
        isrc=args.isrc,
        file_name=file_name,
        duration_sec=duration,
        genre=args.genre,
        date_year=args.year,
    )
    if args.output:
        write_cue_sheet(args.output, text)
        print(args.output)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
