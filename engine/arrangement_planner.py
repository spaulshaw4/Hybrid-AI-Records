"""Scratch blueprint and the novelty ledger.

Every generation starts clean. The ledger remembers the last renders so the
next one must take a different key, progression, tempo, and feel inside the
genre's own limits. Stem scores are then multiplied by ``1 - fatigue``.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import asdict, dataclass
from typing import Any, Mapping, Sequence

_SCALE_KEYS: dict[str, tuple[str, ...]] = {
    "natural_minor": ("A_minor", "D_minor", "E_minor", "G_minor", "B_minor", "F#_minor"),
    "minor": ("A_minor", "D_minor", "E_minor", "G_minor", "B_minor"),
    "major": ("C_major", "G_major", "D_major", "A_major", "F_major", "Bb_major"),
    "dorian": ("D_dorian", "E_dorian", "A_dorian", "G_dorian"),
    "mixolydian": ("G_mixolydian", "A_mixolydian", "D_mixolydian"),
    "major_pentatonic": ("G_major", "A_major", "D_major", "C_major"),
    "blues": ("A_minor", "E_major", "G_minor", "D_major"),
    "harmonic_minor": ("A_minor", "E_minor", "D_minor"),
}

_MINOR_PROGRESSIONS: tuple[tuple[str, ...], ...] = (
    ("i", "VI", "III", "VII"),
    ("i", "iv", "VI", "V"),
    ("VI", "III", "VII", "i"),
    ("i", "VII", "VI", "VII"),
    ("i", "iv", "v", "VI"),
)
_MAJOR_PROGRESSIONS: tuple[tuple[str, ...], ...] = (
    ("I", "V", "vi", "IV"),
    ("I", "IV", "V", "I"),
    ("vi", "IV", "I", "V"),
    ("I", "vi", "IV", "V"),
    ("IV", "I", "V", "vi"),
)

# Full song maps. Phrase lengths differ so two passes do not share a form.
_FORMS: tuple[tuple[tuple[str, int], ...], ...] = (
    (
        ("intro", 4), ("verse", 8), ("chorus", 8), ("verse", 8),
        ("chorus", 8), ("bridge", 8), ("chorus", 8), ("outro", 4),
    ),
    (
        ("intro", 8), ("verse", 16), ("chorus", 8), ("verse", 8),
        ("chorus", 16), ("bridge", 8), ("chorus", 8), ("outro", 8),
    ),
    (
        ("verse", 8), ("chorus", 8), ("verse", 8), ("chorus", 8),
        ("bridge", 4), ("chorus", 8), ("outro", 4),
    ),
    (
        ("intro", 4), ("verse", 12), ("chorus", 8), ("verse", 8),
        ("chorus", 8), ("bridge", 8), ("chorus", 12), ("outro", 4),
    ),
)

_FEELS: tuple[tuple[str, float], ...] = (
    ("straight_backbeat", 0.0),
    ("swing_shuffle", 18.0),
    ("half_time", 0.0),
    ("offbeat_skank", 12.0),
    ("laid_back_pocket", 24.0),
)


def _progression_id(romans: Sequence[str]) -> str:
    return "-".join(romans)


def _form_id(form: Sequence[tuple[str, int]]) -> str:
    return ",".join(f"{role}:{bars}" for role, bars in form)


def _minor_key(key_signature: str) -> bool:
    return "minor" in str(key_signature).lower() or str(key_signature).lower().endswith("_dorian")


@dataclass
class ScratchBlueprint:
    """One fresh arrangement. Nothing here is copied from the last render."""

    key: str
    bpm: float
    romans: list[str]
    swing_offset_ms: float
    form: list[tuple[str, int]]
    rhythmic_feel: str
    progression_id: str = ""
    form_id: str = ""

    def __post_init__(self) -> None:
        if not self.progression_id:
            self.progression_id = _progression_id(self.romans)
        if not self.form_id:
            self.form_id = _form_id(self.form)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["form"] = [[role, bars] for role, bars in self.form]
        return payload


class EngineMemory:
    """SQLite ledger of render DNA. The live catalog is never this file."""

    def __init__(self, db_path: str = "engine_memory.db") -> None:
        parent = os.path.dirname(os.path.abspath(db_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self.create_tables()

    def close(self) -> None:
        self.conn.close()

    def create_tables(self) -> None:
        with self.conn:
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS render_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp REAL,
                    genre TEXT,
                    key_signature TEXT,
                    bpm REAL,
                    chord_progression TEXT,
                    used_stem_ids TEXT,
                    song_id TEXT DEFAULT '',
                    form TEXT DEFAULT '',
                    feel TEXT DEFAULT '',
                    swing_ms REAL DEFAULT 0,
                    progression_id TEXT DEFAULT '',
                    lane_dna TEXT DEFAULT ''
                )
                """
            )

    def record_render(
        self,
        genre: str,
        key_sig: str,
        bpm: float,
        chords: Sequence[str],
        stem_ids: Sequence[str],
        *,
        song_id: str = "",
        form: str = "",
        feel: str = "",
        swing_ms: float = 0.0,
        progression_id: str = "",
        lane_dna: dict | None = None,
    ) -> int:
        dna = json.dumps(lane_dna or {}, sort_keys=True)
        with self.conn:
            cursor = self.conn.execute(
                """
                INSERT INTO render_history (
                    timestamp, genre, key_signature, bpm, chord_progression,
                    used_stem_ids, song_id, form, feel, swing_ms,
                    progression_id, lane_dna
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    time.time(),
                    genre,
                    key_sig,
                    float(bpm),
                    ",".join(chords),
                    ",".join(stem_ids),
                    song_id,
                    form,
                    feel,
                    float(swing_ms),
                    progression_id,
                    dna,
                ),
            )
        return int(cursor.lastrowid or 0)

    def recent(self, limit: int = 10) -> list[dict[str, Any]]:
        cursor = self.conn.execute(
            "SELECT * FROM render_history ORDER BY id DESC LIMIT ?",
            (int(limit),),
        )
        return [dict(row) for row in cursor.fetchall()]

    def get_fatigue_penalty(self, stem_id: str, decay_window: int = 5) -> float:
        """Most recent use is a 0.90 penalty. Each older render gives back 0.18."""
        cursor = self.conn.cursor()
        cursor.execute(
            "SELECT id, used_stem_ids FROM render_history ORDER BY id DESC LIMIT ?",
            (int(decay_window),),
        )
        recent = cursor.fetchall()
        needle = str(stem_id)
        for idx, (_, stem_list) in enumerate(recent):
            if needle and needle in str(stem_list or "").split(","):
                return round(max(0.0, 0.90 - (idx * 0.18)), 2)
        return 0.0

    def penalty_for(self, stem_id: str) -> float:
        return self.get_fatigue_penalty(stem_id)


def _keys_for(scale_types: Sequence[str]) -> list[str]:
    found: list[str] = []
    for scale in scale_types or ("natural_minor",):
        pool = _SCALE_KEYS.get(str(scale))
        if pool is None:
            pool = _SCALE_KEYS["natural_minor"] if "min" in str(scale) or str(scale) in {"blues", "dorian"} else _SCALE_KEYS["major"]
        for key in pool:
            if key not in found:
                found.append(key)
    return found or ["A_minor", "C_major"]


def _bpms(low: int, high: int) -> list[float]:
    start = int(low)
    stop = max(start, int(high))
    return [float(bpm) for bpm in range(start, stop + 1, 2)]


def _unused(options: Sequence[Any], used: Sequence[Any]) -> Any:
    """First legal option the last renders did not take. Else the oldest one."""
    used_list = list(used)
    for option in options:
        if option not in used_list:
            return option
    for old in reversed(used_list):
        if old in options:
            return old
    return options[0]


def plan_scratch(genre: str, memory: EngineMemory | None = None, *, limit: int = 10) -> ScratchBlueprint:
    """A blueprint whose key, chords, tempo, feel, and form are not in the last renders."""
    from engine.genre_arrangement_profiles import resolve_genre_grammar

    grammar = resolve_genre_grammar(genre or "")
    history = memory.recent(limit) if memory is not None else []
    used_keys = [str(row.get("key_signature") or "") for row in history]
    used_progressions = [str(row.get("progression_id") or "") for row in history]
    used_chords = [str(row.get("chord_progression") or "") for row in history]
    used_bpm = [round(float(row.get("bpm") or 0), 1) for row in history]
    used_forms = [str(row.get("form") or "") for row in history]
    used_feels = [str(row.get("feel") or "") for row in history]

    key = str(_unused(_keys_for(grammar.scale_types), used_keys))
    romans_pool = _MINOR_PROGRESSIONS if _minor_key(key) else _MAJOR_PROGRESSIONS
    roman_ids = [_progression_id(item) for item in romans_pool]
    blocked = set(used_progressions) | set(used_chords)
    progression_id = str(_unused(roman_ids, [item for item in blocked if item]))
    romans = list(romans_pool[roman_ids.index(progression_id)])

    low, high = grammar.bpm_range
    bpm = float(_unused(_bpms(low, high), used_bpm))
    feel_names = [name for name, _ms in _FEELS]
    feel = str(_unused(feel_names, used_feels))
    swing = next(ms for name, ms in _FEELS if name == feel)
    form_ids = [_form_id(item) for item in _FORMS]
    form_id = str(_unused(form_ids, used_forms))
    form = [tuple(pair) for pair in _FORMS[form_ids.index(form_id)]]
    return ScratchBlueprint(
        key=key,
        bpm=bpm,
        romans=romans,
        swing_offset_ms=float(swing),
        form=[(role, int(bars)) for role, bars in form],
        rhythmic_feel=feel,
        progression_id=progression_id,
        form_id=form_id,
    )


def apply_scratch(arrangement: dict[str, Any], scratch: ScratchBlueprint, genre: str | None) -> None:
    """Write the fresh key, tempo, chords, and phrase lengths onto a conducted plan.

    The conductor still builds the section objects. This pass only replaces the
    musical choices the ledger said were already used.
    """
    from engine.genre_arrangement_profiles import resolve_genre_grammar
    from engine.song_plan import _chords_for_romans, parse_key_scale

    root, scale = parse_key_scale(scratch.key)
    grammar = resolve_genre_grammar(genre or "")
    chords = _chords_for_romans(root, scale, list(scratch.romans), 0.4, grammar)
    arrangement["bpm"] = float(scratch.bpm)
    arrangement["scratch"] = scratch.to_dict()
    song_plan = arrangement.get("song_plan")
    if isinstance(song_plan, dict):
        song_plan["key"] = root
        song_plan["scale"] = scale
        song_plan["bpm"] = int(round(scratch.bpm))
        song_plan["swing_offset_ms"] = float(scratch.swing_offset_ms)
        song_plan["rhythmic_feel"] = scratch.rhythmic_feel
        song_plan["progression_id"] = scratch.progression_id
        song_plan["form_id"] = scratch.form_id
        for section in song_plan.get("sections") or []:
            if isinstance(section, dict):
                section["chord_progression"] = list(chords)
        roadmap = song_plan.get("harmonic_roadmap")
        if isinstance(roadmap, list) and chords:
            for index, step in enumerate(roadmap):
                if isinstance(step, dict):
                    step["chord"] = chords[index % len(chords)]
                    step["roman"] = scratch.romans[index % len(scratch.romans)]
    _apply_form(arrangement, scratch.form)


def _apply_form(arrangement: dict[str, Any], form: Sequence[tuple[str, int]]) -> None:
    """Retarget phrase lengths when the conducted section count matches the form."""
    sections = arrangement.get("sections") or []
    if len(sections) != len(form):
        arrangement["form_applied"] = False
        return
    total = 0
    for section, (role, bars) in zip(sections, form):
        section["role"] = role
        section["bars"] = int(bars)
        section["slice_count"] = int(bars)
        total += int(bars)
    arrangement["total_bars"] = total
    arrangement["form_applied"] = True
    song_plan = arrangement.get("song_plan")
    if not isinstance(song_plan, dict):
        return
    planned = song_plan.get("sections") or []
    if len(planned) != len(form):
        return
    cursor = 0
    for section, (_role, bars) in zip(planned, form):
        if isinstance(section, dict):
            section["bars"] = int(bars)
            section["start_bar"] = cursor
            cursor += int(bars)
    song_plan["total_bars"] = cursor


# Gemini fills the plan. Python owns the sample grid.
_LANE_ALIASES = {
    "10_lead_fills": "10_lead_inst",
    "10_lead_fill": "10_lead_inst",
    "07_primary_rhythm": "07_primary_comp",
    "08_harmonic_pads": "08_harmonic_bed",
    "09_secondary_chops": "09_secondary_comp",
    "03_tops_hats": "03_tops",
    "04_percussion": "04_aux_perc",
    "12_backing_vocals": "12_vocal_backing",
    "13_fx_risers": "13_transitions_fx",
}
_VOCAL_LANE = "11_lead_vocal"
_LEAD_LANE = "10_lead_inst"

_ARRANGER_SYSTEM = """
You are an elite multitrack arranger. You never see audio samples.
Return one JSON object with song_id, bpm, key, and structure.
Each structure item has section, start_bar, end_bar, and lane_assignments.
Lane ids are 01_kick, 02_snare, 03_tops, 04_aux_perc, 05_sub_bass, 06_mid_bass,
07_primary_comp, 08_harmonic_bed, 09_secondary_comp, 10_lead_inst, 11_lead_vocal,
12_vocal_backing, 13_transitions_fx.
A sustaining part is a stem_id string. A phrase part is
{"stem_id", "active_bars", "rest_bars"} with section-local 1-based bars.
active_bars for one stem cannot be longer than that stem's bars. A later
active run retriggers the same slice; it does not continue past the file.
When 11_lead_vocal is active, 10_lead_inst is silent.
Choose stem_id values only from the catalog. Output JSON only.
""".strip()


def stem_id_from_path(path: str) -> str:
    return os.path.splitext(os.path.basename(str(path)))[0]


def canonical_lane(name: str) -> str | None:
    from engine.stem_lanes import LANE_IDS

    text = str(name or "").strip()
    if text in LANE_IDS:
        return text
    mapped = _LANE_ALIASES.get(text)
    if mapped in LANE_IDS:
        return mapped
    return None


def catalog_card(path: str, lane: str, sr: int, bpm: float) -> dict[str, Any]:
    """Metadata only. No samples go to the model."""
    from engine.stem_phrase_aligner import bars_in_file

    return {
        "stem_id": stem_id_from_path(path),
        "lane": canonical_lane(lane) or str(lane),
        "bars": int(bars_in_file(path, sr, bpm)),
    }


def _song_slug(genre: str) -> str:
    slug = "".join(ch if ch.isalnum() else "_" for ch in str(genre or "").lower()).strip("_")
    return slug[:48] or "track"


def _as_bar_list(value: Any, section_bars: int) -> list[int]:
    if not isinstance(value, list):
        return []
    found: list[int] = []
    for item in value:
        try:
            bar = int(item)
        except (TypeError, ValueError):
            continue
        if 1 <= bar <= int(section_bars) and bar not in found:
            found.append(bar)
    return sorted(found)


def _clip_runs(bars: list[int], file_bars: int) -> list[int]:
    """Keep only as many bars as the file has, on each separate play."""
    if not bars:
        return []
    width = max(1, int(file_bars))
    kept: list[int] = []
    run = [bars[0]]
    for bar in bars[1:]:
        if bar == run[-1] + 1:
            run.append(bar)
            continue
        kept.extend(run[:width])
        run = [bar]
    kept.extend(run[:width])
    return kept


def _stem_id_of(entry: Any) -> str:
    if isinstance(entry, str):
        return entry.strip()
    if isinstance(entry, dict):
        return str(entry.get("stem_id") or "").strip()
    return ""


def _clean_assignment(entry: Any, section_bars: int, file_bars: int) -> Any | None:
    stem = _stem_id_of(entry)
    if not stem:
        return None
    if isinstance(entry, str):
        return stem
    active = _clip_runs(_as_bar_list(entry.get("active_bars"), section_bars), file_bars)
    if not active:
        return None
    active_set = set(active)
    rest = [bar for bar in range(1, int(section_bars) + 1) if bar not in active_set]
    return {"stem_id": stem, "active_bars": active, "rest_bars": rest}


def validate_arrangement_plan(
    raw: Any,
    catalog: Sequence[Mapping[str, Any]],
    *,
    bpm: float,
    key: str,
    genre: str,
    sections: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Drop unknown stems, clip each play to the file, and keep the lead out of the vocal."""
    if not isinstance(raw, dict):
        raise ValueError("arrangement plan must be a JSON object")
    by_id = {
        str(item.get("stem_id") or ""): item
        for item in catalog
        if isinstance(item, Mapping) and item.get("stem_id")
    }
    source = raw.get("structure") if isinstance(raw.get("structure"), list) else []
    timeline: list[tuple[str, int]] = []
    if sections:
        for index, section in enumerate(sections):
            bars = max(1, int(section.get("bars") or 1))
            name = str(section.get("name") or section.get("section") or f"section_{index + 1}")
            timeline.append((name, bars))
    else:
        for index, section in enumerate(source):
            if not isinstance(section, dict):
                continue
            start = int(section.get("start_bar") or 1)
            end = int(section.get("end_bar") or start)
            bars = max(1, end - start + 1)
            timeline.append((str(section.get("section") or f"section_{index + 1}"), bars))
    if not timeline:
        raise ValueError("arrangement plan has no sections")

    structure: list[dict[str, Any]] = []
    song_bar = 1
    for index, (name, bars) in enumerate(timeline):
        src = source[index] if index < len(source) and isinstance(source[index], dict) else {}
        lanes_in = src.get("lane_assignments") if isinstance(src.get("lane_assignments"), dict) else {}
        cleaned: dict[str, Any] = {}
        for lane_name, entry in lanes_in.items():
            lane = canonical_lane(str(lane_name))
            stem = _stem_id_of(entry)
            card = by_id.get(stem)
            if lane is None or card is None:
                continue
            file_bars = max(1, int(card.get("bars") or 1))
            assignment = _clean_assignment(entry, bars, file_bars)
            if assignment is not None:
                cleaned[lane] = assignment
        vocal = cleaned.get(_VOCAL_LANE)
        lead = cleaned.get(_LEAD_LANE)
        if isinstance(vocal, dict) and isinstance(lead, dict):
            singing = set(vocal.get("active_bars") or [])
            kept = [bar for bar in lead.get("active_bars") or [] if bar not in singing]
            if kept:
                lead["active_bars"] = kept
                lead["rest_bars"] = [bar for bar in range(1, bars + 1) if bar not in set(kept)]
            else:
                cleaned.pop(_LEAD_LANE, None)
        structure.append(
            {
                "section": name,
                "start_bar": song_bar,
                "end_bar": song_bar + bars - 1,
                "lane_assignments": cleaned,
            }
        )
        song_bar += bars
    return {
        "song_id": _song_slug(str(raw.get("song_id") or genre)),
        "bpm": float(bpm),
        "key": str(key),
        "structure": structure,
    }


def generate_arrangement_plan_with_gemini(
    genre: str,
    available_stems_catalog: list,
    bpm: float,
    key: str,
    sections: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Ask Gemini for lane assignments. The catalog is names and bar counts, not samples."""
    from engine.gemini_arranger import complete_json

    catalog = list(available_stems_catalog or [])[:50]
    form = ""
    if sections:
        form = "Use exactly these sections and bar counts:\n" + "\n".join(
            f"{index + 1}. {section.get('name') or section.get('section') or 'section'} "
            f"{int(section.get('bars') or 1)} bars"
            for index, section in enumerate(sections)
        )
    user = (
        f"Genre: {genre}\nBPM: {float(bpm)}\nKey: {key}\n{form}\n"
        "Catalog (stem_id, lane, bars):\n"
        f"{json.dumps(catalog, ensure_ascii=True)}"
    )
    raw = complete_json(_ARRANGER_SYSTEM, user)
    return validate_arrangement_plan(
        raw, catalog, bpm=float(bpm), key=str(key), genre=str(genre), sections=sections
    )


def lane_assignment(plan: Mapping[str, Any], section_index: int, lane: str) -> Any | None:
    structure = plan.get("structure") if isinstance(plan, Mapping) else None
    if not isinstance(structure, list) or section_index >= len(structure):
        return None
    section = structure[section_index]
    if not isinstance(section, dict):
        return None
    lanes = section.get("lane_assignments")
    if not isinstance(lanes, dict):
        return None
    return lanes.get(canonical_lane(lane) or lane)


def segments_from_assignment(
    files: Sequence[str],
    assignment: Any,
    section_bars: int,
    bar_samples: int,
    section_samples: int,
) -> list[tuple[int, int, int]] | None:
    """Sample windows for one phrase assignment. A sustaining stem returns None."""
    if not isinstance(assignment, dict) or not files:
        return None
    stem = _stem_id_of(assignment)
    index = next((i for i, path in enumerate(files) if stem_id_from_path(path) == stem), None)
    if index is None:
        return None
    active = _as_bar_list(assignment.get("active_bars"), section_bars)
    if not active:
        return None
    groups: list[tuple[int, int]] = []
    start = previous = active[0]
    for bar in active[1:]:
        if bar == previous + 1:
            previous = bar
            continue
        groups.append((start, previous - start + 1))
        start = previous = bar
    groups.append((start, previous - start + 1))
    width = max(1, int(bar_samples))
    segments: list[tuple[int, int, int]] = []
    for start_bar, span in groups:
        offset = (int(start_bar) - 1) * width
        length = min(int(section_samples) - offset, int(span) * width)
        if length > 0:
            segments.append((offset, length, index))
    return segments or None


def bar_start_sample(bar: int, bpm: float, sr: int) -> int:
    """Sample where a 1-based bar begins, on the same grid as the rest of the mix."""
    from engine.blueprint_track_assembler import samples_per_bar

    return (max(1, int(bar)) - 1) * samples_per_bar(int(sr), float(bpm))


def strip_preroll(audio: Any, sr: int, window_ms: float = 100.0) -> Any:
    """Move the first attack in the opening 100 ms to sample zero."""
    import numpy as np

    arr = np.asarray(audio, dtype=np.float64)
    if arr.size == 0:
        return arr
    mono = np.abs(arr if arr.ndim == 1 else np.max(np.abs(arr), axis=1))
    window = min(int(mono.shape[0]), max(1, int(round(float(sr) * float(window_ms) / 1000.0))))
    peak = float(np.max(mono[:window])) if window else 0.0
    if peak < 1e-8:
        return arr
    threshold = max(peak * 0.2, 1e-4)
    hits = np.flatnonzero(mono[:window] >= threshold)
    if hits.size == 0 or int(hits[0]) == 0:
        return arr
    return arr[int(hits[0]) :]


def place_stem_on_bars(
    audio: Any,
    sr: int,
    bpm: float,
    active_bars: Sequence[int],
    total_samples: int,
    section_offset: int = 0,
) -> Any:
    """Retrigger the stem at each active run. Audio past the file stays silent."""
    import numpy as np

    src = np.asarray(audio, dtype=np.float64)
    if src.ndim == 1:
        src = src[:, np.newaxis]
    total = max(0, int(total_samples))
    out = np.zeros((total, int(src.shape[1])), dtype=np.float64)
    if src.shape[0] == 0 or total == 0:
        return out
    bars = _as_bar_list(list(active_bars), 10_000)
    if not bars:
        return out
    groups: list[tuple[int, int]] = []
    start = previous = bars[0]
    for bar in bars[1:]:
        if bar == previous + 1:
            previous = bar
            continue
        groups.append((start, previous))
        start = previous = bar
    groups.append((start, previous))
    origin = max(0, int(section_offset))
    for first, last in groups:
        begin = origin + bar_start_sample(first, bpm, sr)
        if begin >= total:
            continue
        count = min(int(src.shape[0]), total - begin, bar_start_sample(last + 1, bpm, sr) - bar_start_sample(first, bpm, sr))
        if count > 0:
            out[begin : begin + count] = src[:count]
    return out
