"""Split, tail extract, and stitch for one Lyria master.

The live render in ``engine.generate_track_headless`` calls these helpers.
180 and 210 seconds never reach this module. 300 and 420 do.
"""
from __future__ import annotations

import re

DURATION_PRESETS = (180, 210, 300, 420)
SINGLE_PASS_MAX_SEC = 210
PASS1_SEC = 210
TAIL_MS = 15000
CROSSFADE_MS = 1000
CONTINUATION_INSTRUCTION = (
    "Continue the same song from its previous 15-second ending. "
    "Do not restart the intro. Treat that ending as the overlap, then continue with the remaining lyrics."
)
# One Hybrid Token for every preset, including 300 and 420.
GENERATION_TOKEN_CHARGE = 1

_SECTION_SPLIT = re.compile(r"(?=^\s*\[[^\]]+\])", re.MULTILINE)


def clamp_duration(seconds: float | None) -> int:
    """Snap onto 180, 210, 300, or 420. Above 420 becomes 420."""
    if seconds is None:
        return PASS1_SEC
    try:
        value = float(seconds)
    except (TypeError, ValueError):
        return PASS1_SEC
    if value != value or value in (float("inf"), float("-inf")):
        return PASS1_SEC
    if value > DURATION_PRESETS[-1]:
        return DURATION_PRESETS[-1]
    return min(DURATION_PRESETS, key=lambda preset: (abs(preset - value), -preset))


def generation_token_charge(duration_sec: float | None = None) -> int:
    """Tokens deducted for one generation. Length never changes the price."""
    if duration_sec is not None:
        clamp_duration(duration_sec)
    return GENERATION_TOKEN_CHARGE


def split_lyrics_for_passes(lyrics: str, duration_sec: int) -> tuple[str, str]:
    """Lyrics for the first 210-second block, then the remainder for pass 2."""
    text = (lyrics or "").strip()
    if not text:
        return "", ""
    fraction = min(1.0, float(PASS1_SEC) / float(max(int(duration_sec), 1)))
    sections = [part.strip() for part in _SECTION_SPLIT.split(text) if part.strip()]
    if len(sections) >= 2:
        cut = int(round(len(sections) * fraction))
        cut = max(1, min(len(sections) - 1, cut))
        return "\n\n".join(sections[:cut]), "\n\n".join(sections[cut:])
    lines = text.splitlines()
    if len(lines) >= 2:
        cut = int(round(len(lines) * fraction))
        cut = max(1, min(len(lines) - 1, cut))
        return "\n".join(lines[:cut]).strip(), "\n".join(lines[cut:]).strip()
    words = text.split()
    if len(words) >= 2:
        cut = int(round(len(words) * fraction))
        cut = max(1, min(len(words) - 1, cut))
        return " ".join(words[:cut]), " ".join(words[cut:])
    return text, ""


def continuation_block(remaining_lyrics: str) -> str:
    """Pass-2 prompt text. Lyria's input is prompt-only, so the tail is not a file URL."""
    remainder = (remaining_lyrics or "").strip()
    if remainder:
        return f"{CONTINUATION_INSTRUCTION}\n\n{remainder}"
    return CONTINUATION_INSTRUCTION


def extract_context_tail(part1_path: str, tail_path: str) -> str:
    """Trailing 15000 ms of part 1. Kept as the stitch overlap, not a vault track."""
    from pydub import AudioSegment

    segment = AudioSegment.from_wav(part1_path)
    tail = segment[-TAIL_MS:]
    tail.export(tail_path, format="wav")
    print("[LYRIA] extracted 15s context window", flush=True)
    return tail_path


def stitch_lyria_master(part1_path: str, part2_path: str, master_output_path: str) -> str:
    """One gapless master. ``append(..., crossfade=1000)`` is the equal-power join."""
    from pydub import AudioSegment

    part1 = AudioSegment.from_wav(part1_path)
    part2 = AudioSegment.from_wav(part2_path)
    full_master = part1.append(part2, crossfade=1000)
    full_master.export(master_output_path, format="wav")
    return master_output_path
