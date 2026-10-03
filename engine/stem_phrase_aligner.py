"""Put short catalog slices on one bar grid.

A phrase file is only as long as its audio. Gemini may order which slice
plays next. The slot length stays the file length, so the rest of the bar
is a real rest the lead can fill instead of silence inside a phrase.
"""
from __future__ import annotations

import os
from typing import Any

_ORDER_CACHE: dict[tuple[str, ...], list[int]] = {}

_SYSTEM = (
    "You schedule short music stems onto a shared bar grid. "
    "Each stem is only as many bars long as listed. "
    "Order vocal phrases so a verse-named slice comes before a chorus-named slice. "
    "Return JSON only: {\"order\": [stem indexes]}. Use each index at least once."
)


def bars_in_file(path: str, sr: int, bpm: float) -> int:
    """Whole bars of audio in the file at the song tempo. At least 1."""
    from engine.blueprint_track_assembler import samples_per_bar

    frames = 0
    file_sr = int(sr)
    try:
        import soundfile as sf

        info = sf.info(path)
        frames = int(info.frames or 0)
        file_sr = int(info.samplerate or sr)
    except Exception:
        frames = 0
    bar = samples_per_bar(file_sr, bpm)
    if frames <= 0 or bar <= 0:
        return 1
    return max(1, int(frames // bar))


def parse_stem_order(payload: Any, count: int) -> list[int] | None:
    """Accept ``{"order": [0, 2, 1]}``. Reject anything outside the pool."""
    if count <= 0 or not isinstance(payload, dict):
        return None
    raw = payload.get("order")
    if not isinstance(raw, list) or not raw:
        return None
    order: list[int] = []
    for item in raw:
        try:
            index = int(item)
        except (TypeError, ValueError):
            return None
        if index < 0 or index >= count:
            return None
        order.append(index)
    return order or None


def stem_order(
    paths: list[str],
    section_names: list[str],
    live: bool,
    phrase_bars: int,
    rest_bars: int,
    sr: int,
    bpm: float,
) -> list[int]:
    """Identity order, or Gemini's order when ``live`` and the reply is valid."""
    count = len(paths)
    if count <= 1 or not live:
        return list(range(count))
    key = tuple(paths)
    cached = _ORDER_CACHE.get(key)
    if cached is not None:
        return cached
    order = list(range(count))
    try:
        from engine.gemini_arranger import complete_json

        cards = []
        for index, path in enumerate(paths):
            cards.append(
                f"{index} {os.path.basename(path)} {bars_in_file(path, sr, bpm)} bars"
            )
        user = (
            "Stems:\n"
            + "\n".join(cards)
            + "\nSections: "
            + ", ".join(section_names)
            + f"\nPlay up to {int(phrase_bars)} bars, then rest {int(rest_bars)} bars."
        )
        parsed = parse_stem_order(complete_json(_SYSTEM, user), count)
        if parsed:
            order = parsed
            print(f"[ALIGN] gemini vocal order {order}", flush=True)
        else:
            print("[ALIGN] gemini order rejected; keeping file order", flush=True)
    except Exception as exc:
        print(f"[ALIGN] gemini skipped ({type(exc).__name__})", flush=True)
    _ORDER_CACHE[key] = order
    return order


def fit_phrase_segments(
    paths: list[str],
    bars: int,
    bar_samples: int,
    section_samples: int,
    phrase_bars: int | None,
    rest_bars: int | None,
    sr: int,
    bpm: float,
    order: list[int] | None = None,
    cursor: int = 0,
) -> tuple[list[tuple[int, int, int]], int]:
    """Play windows sized to each file, then a rest.

    Returns ``(offset, length, stem_index)`` inside the section, and the next
    index into ``order`` so the following section continues the sequence.
    """
    phrase = int(phrase_bars) if phrase_bars else (4 if int(bars) >= 8 else 2)
    rest = phrase if rest_bars is None else int(rest_bars)
    if rest <= 0:
        stem = 0 if not order else int(order[0]) % max(1, len(paths) or 1)
        return [(0, int(section_samples), stem)], cursor
    count = max(1, len(paths))
    sequence = [int(i) % count for i in (order or range(count))]
    if not sequence:
        sequence = list(range(count))
    play_index = int(cursor)
    bar = 0
    playing = True
    segments: list[tuple[int, int, int]] = []
    while bar < int(bars):
        if playing:
            stem = sequence[play_index % len(sequence)]
            file_bars = bars_in_file(paths[stem], sr, bpm) if paths else phrase
            span = min(phrase, file_bars, int(bars) - bar)
            if span <= 0:
                break
            start = bar * int(bar_samples)
            end = min(int(section_samples), (bar + span) * int(bar_samples))
            if end > start:
                segments.append((start, end - start, stem))
            play_index += 1
            playing = False
        else:
            span = min(max(0, rest), int(bars) - bar)
            if span <= 0:
                break
            playing = True
        bar += span
    return segments, play_index


def rest_bar_indexes(
    segments: list[tuple[int, int, int]],
    bars: int,
    bar_samples: int,
) -> list[int]:
    """0-based bars the phrase windows do not cover."""
    taken: set[int] = set()
    width = max(1, int(bar_samples))
    for start, length, _stem in segments:
        first = int(start) // width
        last = (int(start) + int(length) + width - 1) // width
        taken.update(range(first, last))
    return [bar for bar in range(int(bars)) if bar not in taken]


def segments_from_bars(
    bar_indexes: list[int],
    bar_samples: int,
    section_samples: int,
    variant: int = 0,
) -> list[tuple[int, int, int]]:
    """Group consecutive bars into linear placements."""
    ordered = sorted({int(bar) for bar in bar_indexes if int(bar) >= 0})
    if not ordered:
        return []
    groups: list[tuple[int, int]] = []
    start = previous = ordered[0]
    for bar in ordered[1:]:
        if bar == previous + 1:
            previous = bar
            continue
        groups.append((start, previous - start + 1))
        start = previous = bar
    groups.append((start, previous - start + 1))
    segments: list[tuple[int, int, int]] = []
    for start_bar, span in groups:
        offset = start_bar * int(bar_samples)
        length = min(int(section_samples) - offset, span * int(bar_samples))
        if length > 0:
            segments.append((offset, length, int(variant)))
    return segments


def clear_order_cache() -> None:
    _ORDER_CACHE.clear()
