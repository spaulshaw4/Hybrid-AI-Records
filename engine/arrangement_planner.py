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
from typing import Any, Sequence

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
