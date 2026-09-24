"""Score corpus slices for musical fit instead of taking the first row that matches.

What the index actually gives us
--------------------------------
``slice_index`` on the live DB (``D:\\MusicDatasets\\db\\corpus_index.sqlite``,
52,725 rows, census 2026-08-31) has metadata populated. Three caveats matter:

* ``detected_key`` is a **pitch class only** (``"D"``), with no major/minor
  mode. ``A`` is 17,158 rows (32.5 %) and is the likely detection fallback.
  Key scoring is mode-agnostic — see ``key_compatibility``.
* ``rms_db`` bottoms out at -120 dB for silent slices. Those are hard-rejected,
  not merely down-weighted.
* ``stem_type`` has **no bass** (harmonic 27,944 / rhythm 13,126 / vocal 10,811
  / lead 844 / bass 0). 11,572 ``bass_s4_*.wav`` files are filed as harmonic.
  Bass is resolved from filename/tags (``bass``, ``808``, ``sub``) first, then
  a low-centroid harmonic fallback. Mixture files must never be layered.

Key compatibility rule (documented, mode-agnostic)
--------------------------------------------------
Let ``d`` be the circular semitone distance between the candidate root and the
target root, and ``c`` the circle-of-fifths distance (``root * 7 mod 12``).

===================================  =====  ======
relationship                         d      score
===================================  =====  ======
same root                            0      1.00
relative major / minor               3 or 9 0.85
neighbouring fifth (IV or V)         5 or 7 0.72
two steps around the circle          2 or 10 0.45
anything else                        -      0.15
===================================  =====  ======

Because the mode is unknown, both directions of the ±3-semitone relationship
are treated as a relative major/minor pair. That is deliberately generous: a
D-rooted slice is accepted against an F target and vice versa.
"""
from __future__ import annotations

import math
import os
import re
import sqlite3
from pathlib import Path
from random import Random
from typing import Any, Iterable

NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_FLATS = {
    "DB": "C#", "EB": "D#", "GB": "F#", "AB": "G#", "BB": "A#",
    "CB": "B", "FB": "E", "E#": "F", "B#": "C",
}

# dsp/tempo_time_stretch.py clamps the WSOLA rate to [0.5, 2.0]. A candidate
# whose folded tempo would need a rate outside that window cannot be locked to
# the target without the clamp silently leaving it off-tempo.
STRETCH_RATE_MIN = 0.5
STRETCH_RATE_MAX = 2.0

# Slices at or below this are dead air; never pick them.
DEAD_RMS_DBFS = -55.0
# Preferred loudness window per role. Anything inside scores 1.0.
ROLE_RMS_WINDOW = {
    "rhythm": (-34.0, -14.0),
    "bass": (-34.0, -14.0),
    "harmonic": (-38.0, -16.0),
    "vocal": (-40.0, -16.0),
}
# Target spectral centroid per role, in Hz, with a tolerance in octaves.
# Measured against the live corpus: drum loops carry cymbals and sit around
# 4 kHz, ``other`` stems around 2-2.7 kHz, ``bass`` around 620 Hz mean but well
# under 300 Hz for the genuinely sub-heavy picks, vocals around 2.7 kHz.
ROLE_CENTROID = {
    "rhythm": (3400.0, 1.50),
    "bass": (250.0, 0.90),
    "harmonic": (2200.0, 1.40),
    "vocal": (2600.0, 0.95),
}

SCORE_WEIGHTS = {
    "key": 0.34,
    "bpm": 0.30,
    "centroid": 0.22,
    "level": 0.14,
}

# Filename prefixes in the MUSDB-style corpus. ``mixture`` is a full mix and is
# never a usable layer.
_ROLE_PREFIXES = {
    "bass": ("bass", "808"),
    "rhythm": ("drums", "drum", "perc", "kick", "snare", "hat"),
    "vocal": ("vocals", "vocal", "vox"),
    "harmonic": ("other", "harm", "pad", "synth", "guitar", "keys", "piano"),
}
_BANNED_PREFIXES = ("mixture",)
# Filename / tag tokens that mark a bass slice on an index with no bass stem_type.
BASS_NAME_TOKENS = ("bass", "808")
# Directory names that cannot hold a vocal slice regardless of stem_type.
VOCAL_EXCLUDED_FOLDERS = ("harmonic", "rhythm", "drums", "bass")
BASS_CENTROID_FALLBACK_HZ = 450.0

# slice_index has no pack_id column. Session identity is the parent folder
# (``001 - ANiMAL - Clinic A``) or, when files sit under a role directory
# (``corpus_4s/rhythm/...``), the filename prefix before ``__``.
ROLE_PACK_DIRS = frozenset({
    "rhythm", "harmonic", "vocal", "vocals", "lead", "bass", "drums", "drum",
    "other", "stems", "slices", "oneshots", "fx",
})
AFFINITY_BONUS = 100.0
# Same root (1.0), relative maj/min (0.85), or neighbouring fifth (0.72).
AFFINITY_KEY_MIN = 0.72
_PHRASE_TAIL_RE = re.compile(r"_(phrase|s4|loop|oneshot)_\d+$", re.IGNORECASE)


def slug_pack_token(raw: str | None) -> str:
    """``001 - ANiMAL - Clinic A`` → ``001_animal_clinic_a``."""
    return re.sub(r"[^a-z0-9]+", "_", str(raw or "").lower()).strip("_")


def extract_session_slug(file_path: str | None) -> str:
    """Session slug from ``name__role.wav`` or the parent folder.

    ``vintage_funk_kit_01__drums.wav`` → ``vintage_funk_kit_01``
    ``stems/indie_groove_120/drums.wav`` → ``indie_groove_120``
    Role folders (``rhythm/``, ``harmonic/``) fall back to the filename
    prefix so they still cluster with the session directory of the same name.
    """
    if not file_path:
        return ""
    path = Path(str(file_path))
    stem_name = path.stem
    if "__" in stem_name:
        return stem_name.split("__", 1)[0]
    parent = path.parent.name
    if parent.lower() in ROLE_PACK_DIRS:
        stripped = _PHRASE_TAIL_RE.sub("", stem_name)
        return stripped or parent
    return parent


def pack_id_from_path(file_path: str | None) -> str:
    """Normalized pack id for scoring (``slice_index`` has no pack column)."""
    return slug_pack_token(extract_session_slug(file_path))


def apply_pack_affinity(
    ranked: list[dict[str, Any]],
    anchor_pack_id: str | None,
) -> list[dict[str, Any]]:
    """+100 to same-pack rows. Foreign packs only if no key-compatible same-pack hit."""
    if not ranked:
        return ranked
    anchor = slug_pack_token(anchor_pack_id) if anchor_pack_id else ""
    if not anchor:
        for item in ranked:
            item.setdefault("pack_id", pack_id_from_path(item.get("file_path")))
            item.setdefault("affinity_score", 0.0)
        return ranked
    for item in ranked:
        pid = pack_id_from_path(item.get("file_path"))
        item["pack_id"] = pid
        bonus = AFFINITY_BONUS if pid == anchor else 0.0
        item["affinity_score"] = bonus
        item["rank_key"] = float(item.get("rank_key") or item.get("score") or 0.0) + bonus
    ranked.sort(key=lambda item: (-float(item["rank_key"]), str(item.get("file_path") or "")))
    same_key = [
        item
        for item in ranked
        if float(item.get("affinity_score") or 0.0) >= AFFINITY_BONUS
        and float((item.get("score_detail") or {}).get("key") or 0.0) >= AFFINITY_KEY_MIN
    ]
    return same_key or ranked


def note_to_semitone(note: str | None) -> int | None:
    """Parse a root note to a 0-11 pitch class. Returns None when unparseable."""
    token = str(note or "").strip()
    if not token:
        return None
    token = token.replace("\u266d", "b").replace("\u266f", "#")
    head = token[:2].upper() if len(token) > 1 and token[1] in "#bB" else token[:1].upper()
    head = _FLATS.get(head, head)
    if head in NOTE_NAMES:
        return NOTE_NAMES.index(head)
    letter = token[:1].upper()
    if letter in NOTE_NAMES:
        return NOTE_NAMES.index(letter)
    return None


def key_compatibility(candidate_key: str | None, target_key: str | None) -> float:
    """Mode-agnostic root compatibility in ``[0, 1]``. See the module docstring."""
    target = note_to_semitone(target_key)
    if target is None:
        # No target key requested: key is not a discriminator, stay neutral.
        return 0.5
    candidate = note_to_semitone(candidate_key)
    if candidate is None:
        return 0.25
    # Circular distance, so 9 folds onto 3 (relative maj/min), 7 onto 5 (fifth),
    # and 10 onto 2 (two steps around the circle of fifths).
    distance = min((candidate - target) % 12, (target - candidate) % 12)
    if distance == 0:
        return 1.0
    if distance == 3:
        return 0.85
    if distance == 5:
        return 0.72
    if distance == 2:
        return 0.45
    return 0.15


def fold_bpm(candidate_bpm: float, target_bpm: float) -> float:
    """Fold a half/double-time estimate toward the target, as WSOLA lock does."""
    target = float(target_bpm)
    bpm = float(candidate_bpm)
    if target <= 1e-6 or bpm <= 1e-6:
        return bpm
    for _ in range(10):
        if bpm >= target * 0.70:
            break
        bpm *= 2.0
    for _ in range(10):
        if bpm <= target * 1.40:
            break
        bpm /= 2.0
    return bpm


def required_stretch_rate(candidate_bpm: float, target_bpm: float) -> float:
    """WSOLA rate needed to lock a candidate to the target, after octave folding."""
    folded = fold_bpm(float(candidate_bpm), float(target_bpm))
    if folded <= 1e-6:
        return 1.0
    return float(target_bpm) / folded


def bpm_compatibility(candidate_bpm: float | None, target_bpm: float | None) -> float:
    """1.0 at the target, decaying with the stretch rate needed to reach it.

    Octave folding means a half- or double-time estimate is not penalised, so
    in practice the folded rate lands inside ``[0.71, 1.43]`` and the 0.5-2.0
    WSOLA clamp is a safety net rather than a routine rejection. The score
    reaches 0 at the clamp edge, which keeps it monotone across the whole
    usable range.
    """
    if not target_bpm or float(target_bpm) <= 0:
        return 0.5
    if not candidate_bpm or float(candidate_bpm) <= 0:
        return 0.25
    rate = required_stretch_rate(float(candidate_bpm), float(target_bpm))
    if rate < STRETCH_RATE_MIN or rate > STRETCH_RATE_MAX:
        return 0.0
    octaves = abs(math.log2(rate))
    return float(max(0.0, 1.0 - min(1.0, octaves / 0.8)))


def centroid_fit(centroid_hz: float | None, role: str, target_hz: float | None = None) -> float:
    """Role fit from spectral centroid: sub-bass low, vocal chop upper-mid."""
    nominal, tolerance_oct = ROLE_CENTROID.get(role, ROLE_CENTROID["harmonic"])
    target = float(target_hz) if target_hz else float(nominal)
    value = float(centroid_hz or 0.0)
    if value <= 1.0:
        # 0.0 Hz centroid means a silent or DC-only slice.
        return 0.0
    octaves = abs(math.log2(value / max(1.0, target)))
    return float(max(0.0, 1.0 - min(1.0, octaves / max(0.1, tolerance_oct))))


def level_fit(rms_db: float | None, role: str) -> float:
    """Prefer slices already sitting in a usable window for their role."""
    if rms_db is None:
        return 0.25
    value = float(rms_db)
    lo, hi = ROLE_RMS_WINDOW.get(role, ROLE_RMS_WINDOW["harmonic"])
    if value <= DEAD_RMS_DBFS:
        return 0.0
    if lo <= value <= hi:
        return 1.0
    if value < lo:
        return float(max(0.0, 1.0 - (lo - value) / 18.0))
    return float(max(0.0, 1.0 - (value - hi) / 8.0))


def role_from_filename(filename: str) -> str | None:
    name = os.path.basename(str(filename or "")).lower()
    for banned in _BANNED_PREFIXES:
        if name.startswith(banned):
            return None
    # ``sub`` is a token (sub_*, *_sub_*), not a prefix of "subject".
    if name.startswith("sub_") or "_sub_" in name:
        return "bass"
    for role, prefixes in _ROLE_PREFIXES.items():
        for prefix in prefixes:
            if name.startswith(prefix) or f"_{prefix}_" in name:
                return role
    return None


def _bass_token_sql() -> tuple[str, list[str]]:
    """SQL that finds bass by filename/tags. There is no stem_type='bass'."""
    clauses: list[str] = []
    params: list[str] = []
    for token in BASS_NAME_TOKENS:
        clauses.append("LOWER(si.filename) LIKE ?")
        params.append(f"%{token}%")
        clauses.append("LOWER(COALESCE(si.tags, '')) LIKE ?")
        params.append(f"%{token}%")
    clauses.append("LOWER(si.filename) LIKE ?")
    params.append("sub_%")
    clauses.append("LOWER(si.filename) LIKE ?")
    params.append("%_sub_%")
    clauses.append("LOWER(' ' || COALESCE(si.tags, '') || ' ') LIKE ?")
    params.append("% sub %")
    return "(" + " OR ".join(clauses) + ")", params


BPM_INDEX_NAME = "idx_slice_index_bpm"
BPM_INDEX_DDL = (
    f"CREATE INDEX IF NOT EXISTS {BPM_INDEX_NAME} ON slice_index (stem_type, estimated_bpm)"
)
INDEXED_POOL_LIMIT = 200
BPM_ABS_WINDOW = 8.0


def _pitch_class(key: str | None) -> str:
    """``D_minor`` / ``D minor`` / ``Dm`` → ``D`` for ``detected_key`` equality."""
    semi = note_to_semitone(key)
    if semi is None:
        return ""
    return NOTE_NAMES[semi]


def _row_is_bass(row: dict[str, Any]) -> bool:
    name = os.path.basename(str(row.get("filename") or row.get("file_path") or "")).lower()
    tags = str(row.get("tags") or "").lower()
    if name.startswith("mixture"):
        return False
    if name.startswith("sub_") or "_sub_" in name or " sub " in f" {tags} ":
        return True
    return any(token in name or token in tags for token in BASS_NAME_TOKENS)


def fetch_indexed_pool(
    conn: sqlite3.Connection,
    stem_type: str,
    target_key: str | None,
    target_bpm: float | None,
    *,
    limit: int = INDEXED_POOL_LIMIT,
) -> list[dict[str, Any]]:
    """Indexed ``stem_type`` + key + ``ABS(bpm - target) <= 8`` pool.

    Maps the requested ``audio_slices(slice_id, bpm, key)`` shape onto
    ``slice_index(id, estimated_bpm, detected_key)``. Never ``LIKE '%slug%'``
    or ``ORDER BY RANDOM()`` — those scan the full 542k-row catalog.
    """
    stem = str(stem_type or "").strip().lower()
    if not stem:
        return []
    where = ["si.stem_type = ?"]
    params: list[Any] = [stem]
    key = _pitch_class(target_key)
    if key:
        where.append("si.detected_key = ?")
        params.append(key)
    if target_bpm is not None:
        bpm = float(target_bpm)
        # Equivalent to ABS(estimated_bpm - :bpm) <= 8.0; BETWEEN uses the
        # (stem_type, estimated_bpm) index instead of a full-table scan.
        where.append("si.estimated_bpm BETWEEN ? AND ?")
        params.extend([bpm - BPM_ABS_WINDOW, bpm + BPM_ABS_WINDOW])
    sql = (
        "SELECT si.id AS slice_id, si.file_path, si.estimated_bpm AS bpm, "
        "si.detected_key AS key, si.filename, si.stem_type, si.rms_db, "
        "si.spectral_centroid, si.duration_sec, si.tags, si.estimated_bpm, "
        "si.detected_key "
        "FROM slice_index AS si "
        f"WHERE {' AND '.join(where)} "
        "LIMIT ?"
    )
    params.append(max(1, int(limit)))
    try:
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.Error:
        return []
    keys = (
        "slice_id", "file_path", "bpm", "key", "filename", "stem_type",
        "rms_db", "spectral_centroid", "duration_sec", "tags",
        "estimated_bpm", "detected_key",
    )
    return [dict(zip(keys, row)) for row in rows]


def _attach_history(conn: sqlite3.Connection, rows: list[dict[str, Any]]) -> None:
    """Cooldown counts for the already-fetched pool only (never a catalog scan)."""
    paths = [str(row.get("file_path") or "") for row in rows if row.get("file_path")]
    if not paths:
        return
    placeholders = ",".join("?" * len(paths))
    try:
        hist = conn.execute(
            "SELECT file_path, last_used, COALESCE(use_count, 0) "
            f"FROM slice_history WHERE file_path IN ({placeholders})",
            paths,
        ).fetchall()
    except sqlite3.Error:
        return
    by_path = {str(path): (last_used, int(count or 0)) for path, last_used, count in hist}
    for row in rows:
        last_used, count = by_path.get(str(row.get("file_path") or ""), (None, 0))
        row["last_used"] = last_used
        row["use_count"] = count


def _python_role_filter(rows: list[dict[str, Any]], role: str) -> list[dict[str, Any]]:
    """Drop mixtures / wrong-role filenames after the indexed fetch."""
    kept: list[dict[str, Any]] = []
    for row in rows:
        name = str(row.get("filename") or "").lower()
        if name.startswith("mixture"):
            continue
        if role == "bass":
            if _row_is_bass(row):
                kept.append(row)
            continue
        if role == "harmonic" and name.startswith("bass"):
            continue
        kept.append(row)
    if role == "bass" and not kept:
        kept = [
            row
            for row in rows
            if not str(row.get("filename") or "").lower().startswith("mixture")
            and 1.0 < float(row.get("spectral_centroid") or 0.0) < BASS_CENTROID_FALLBACK_HZ
        ]
    return kept


def _merge_unique(
    primary: list[dict[str, Any]],
    extra: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    seen = {str(row.get("file_path") or "") for row in primary}
    merged = list(primary)
    for row in extra:
        path = str(row.get("file_path") or "")
        if path and path not in seen:
            seen.add(path)
            merged.append(row)
    return merged


def _indexed_candidates(
    conn: sqlite3.Connection,
    role: str,
    target_key: str | None,
    target_bpm: float | None,
    *,
    limit: int = INDEXED_POOL_LIMIT,
    min_rows: int = 1,
    use_cooldown: bool = False,
) -> list[dict[str, Any]]:
    """Stem + key + ±8 BPM, then widen key / BPM if the tight pool is short."""
    stem = _stem_type_for_role(role) or "harmonic"
    need = max(1, int(min_rows))
    rows = _python_role_filter(
        fetch_indexed_pool(conn, stem, target_key, target_bpm, limit=limit),
        role,
    )
    if len(rows) < need:
        rows = _merge_unique(
            rows,
            _python_role_filter(
                fetch_indexed_pool(conn, stem, None, target_bpm, limit=limit),
                role,
            ),
        )
    if len(rows) < need:
        rows = _merge_unique(
            rows,
            _python_role_filter(
                fetch_indexed_pool(conn, stem, None, None, limit=limit),
                role,
            ),
        )
    if use_cooldown:
        _attach_history(conn, rows)
    else:
        for row in rows:
            row.setdefault("last_used", None)
            row.setdefault("use_count", 0)
    return rows


def bpm_window_sql(
    target_bpm: float,
    tolerance: float,
    *,
    include_null: bool = False,
) -> tuple[str, list[float]]:
    """``estimated_bpm`` inside ±tolerance of target, half-time, or double-time.

    ``include_null`` keeps rows with no detected BPM (phrase material such as
    vocals); callers should rank those after rows with a measured tempo.
    """
    bpm = float(target_bpm)
    lo, hi = bpm * (1.0 - float(tolerance)), bpm * (1.0 + float(tolerance))
    clause = (
        "(si.estimated_bpm BETWEEN ? AND ?"
        " OR si.estimated_bpm BETWEEN ? AND ?"
        " OR si.estimated_bpm BETWEEN ? AND ?"
    )
    params = [lo, hi, lo / 2.0, hi / 2.0, lo * 2.0, hi * 2.0]
    if include_null:
        clause += " OR si.estimated_bpm IS NULL"
    return clause + ")", params


def bpm_distance_sql(target_bpm: float) -> tuple[str, list[float]]:
    """ORDER BY key: distance to the nearest of target / half / double tempo."""
    bpm = float(target_bpm)
    return (
        "MIN(ABS(si.estimated_bpm - ?), ABS(si.estimated_bpm * 2.0 - ?), "
        "ABS(si.estimated_bpm / 2.0 - ?))",
        [bpm, bpm, bpm],
    )


def score_candidate(
    row: dict[str, Any],
    role: str,
    target_key: str | None,
    target_bpm: float | None,
    *,
    centroid_target_hz: float | None = None,
    energy_level: float | None = None,
) -> dict[str, float]:
    """Weighted musical fit for one ``slice_index`` row.

    Returns the component scores plus a combined ``score`` in ``[0, 1]``.
    A dead (silent) slice scores 0 outright.

    ``energy_level`` (0..1 from ``SectionPlan``) softly biases level fit so
    sparse sections prefer quieter slices and climax sections prefer denser ones.
    """
    level = level_fit(row.get("rms_db"), role)
    if level <= 0.0:
        return {
            "key": 0.0,
            "bpm": 0.0,
            "centroid": 0.0,
            "level": 0.0,
            "energy": 0.0,
            "score": 0.0,
        }
    key = key_compatibility(row.get("detected_key"), target_key)
    bpm = bpm_compatibility(row.get("estimated_bpm"), target_bpm)
    centroid = centroid_fit(row.get("spectral_centroid"), role, centroid_target_hz)
    energy = 1.0
    if energy_level is not None:
        target = max(0.0, min(1.0, float(energy_level)))
        # Map RMS (~-40..-6) into 0..1 and reward proximity to section energy.
        rms = row.get("rms_db")
        try:
            rms_f = float(rms)
        except (TypeError, ValueError):
            rms_f = -20.0
        loudness = max(0.0, min(1.0, (rms_f + 40.0) / 34.0))
        energy = 1.0 - abs(loudness - target)
    score = (
        SCORE_WEIGHTS["key"] * key
        + SCORE_WEIGHTS["bpm"] * bpm
        + SCORE_WEIGHTS["centroid"] * centroid
        + SCORE_WEIGHTS["level"] * level * (0.65 + 0.35 * energy)
    )
    return {
        "key": round(key, 4),
        "bpm": round(bpm, 4),
        "centroid": round(centroid, 4),
        "level": round(level, 4),
        "energy": round(float(energy), 4),
        "score": round(float(score), 4),
    }


def _stem_type_for_role(role: str) -> str | None:
    """Index ``stem_type`` to filter on. ``bass``/``lead`` have no rows of their own."""
    if role == "vocal":
        return "vocal"
    if role == "rhythm":
        return "rhythm"
    if role in {"bass", "harmonic", "lead"}:
        return "harmonic"
    return None


def _stem_ml_enabled(conn: sqlite3.Connection) -> bool:
    """HYBRID_STEM_ML plus a live ``stem_type_ml`` column. Off by default."""
    flag = os.environ.get("HYBRID_STEM_ML", "").strip().lower()
    if flag not in {"1", "true", "yes", "on"}:
        return False
    try:
        cols = {str(row[1]) for row in conn.execute("PRAGMA table_info(slice_index)")}
    except sqlite3.Error:
        return False
    return "stem_type_ml" in cols


def fetch_candidate_rows(
    conn: sqlite3.Connection,
    role: str,
    *,
    tags: Iterable[str] | None = None,
    limit: int = 400,
    use_cooldown: bool = True,
    bass_source: str = "name",
    bpm_window: tuple[float, float] | None = None,
) -> list[dict[str, Any]]:
    """Pull candidate rows for a role, then score them offline.

    The cooldown join is a *soft* ordering, not a filter: ``slice_history``
    already holds 900+ rows on the live DB, and a hard cutoff would starve
    small stems. Rows never used sort first, then least-recently used.

    ``use_cooldown=False`` orders by ``file_path`` instead, which makes the
    candidate list independent of how many times the corpus has been rendered.
    That is what lets an explicit ``--seed`` reproduce a track exactly.

    ``bpm_window=(target_bpm, tolerance)`` applies the ±tolerance tempo filter
    (incl. half/double time) in SQL so ``limit`` is spent on in-tempo rows.

    Bass: ``stem_type`` has zero bass rows. ``bass_source='name'`` matches
    filename/tags (``bass``, ``808``, ``sub``) and optional ``stem_type_ml``.
    ``'low_centroid'`` is the harmonic fallback (centroid < 450 Hz) used when
    the name pool is empty.
    """
    stem = _stem_type_for_role(role)
    where = ["si.filename NOT LIKE 'mixture%'"]
    params: list[Any] = []
    if role == "bass":
        # Honest: do not filter stem_type='bass' — that value does not exist.
        where.append("si.stem_type != 'vocal'")
        token_sql, token_params = _bass_token_sql()
        if bass_source == "low_centroid":
            where.append("si.stem_type = 'harmonic'")
            where.append(f"NOT {token_sql}")
            params.extend(token_params)
            where.append("si.spectral_centroid > 1")
            where.append("si.spectral_centroid < ?")
            params.append(float(BASS_CENTROID_FALLBACK_HZ))
        else:
            if _stem_ml_enabled(conn):
                where.append(f"({token_sql} OR lower(si.stem_type_ml) = 'bass')")
            else:
                where.append(token_sql)
            params.extend(token_params)
    elif stem:
        where.append("si.stem_type = ?")
        params.append(stem)
        if role in {"harmonic", "lead"}:
            where.append("si.filename NOT LIKE 'bass%'")
        if role == "vocal":
            # The D: catalog labels ~470k corpus_4s\harmonic\ phrases as vocal.
            # live_index relabels the replica; this guards other index copies.
            for folder in VOCAL_EXCLUDED_FOLDERS:
                where.append("lower(replace(si.file_path, '/', '\\')) NOT LIKE ?")
                params.append(f"%\\{folder}\\%")
    cleaned = [str(t).strip() for t in (tags or []) if str(t).strip()]
    if cleaned:
        like = " OR ".join("si.tags LIKE ?" for _ in cleaned)
        where.append(f"({like})")
        params.extend(f"%{tag}%" for tag in cleaned)
    where.append("si.rms_db > ?")
    params.append(float(DEAD_RMS_DBFS))
    if bpm_window is not None:
        window_sql, window_params = bpm_window_sql(
            bpm_window[0], bpm_window[1], include_null=role == "vocal"
        )
        where.append(window_sql)
        params.extend(window_params)

    if role == "bass" and bass_source == "low_centroid":
        order_sql = "ORDER BY si.spectral_centroid ASC, si.file_path ASC "
    elif use_cooldown:
        order_sql = (
            "ORDER BY (sh.last_used IS NOT NULL), sh.last_used ASC, si.file_path ASC "
        )
    else:
        order_sql = "ORDER BY si.file_path ASC "

    sql = (
        "SELECT si.file_path, si.filename, si.stem_type, si.detected_key, "
        "si.estimated_bpm, si.rms_db, si.spectral_centroid, si.duration_sec, "
        "sh.last_used, COALESCE(sh.use_count, 0) AS use_count "
        "FROM slice_index AS si "
        "LEFT JOIN slice_history AS sh ON sh.file_path = si.file_path "
        f"WHERE {' AND '.join(where)} "
        + order_sql
        + "LIMIT ?"
    )
    params.append(max(1, int(limit)))
    try:
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.Error:
        return []
    keys = (
        "file_path", "filename", "stem_type", "detected_key", "estimated_bpm",
        "rms_db", "spectral_centroid", "duration_sec", "last_used", "use_count",
    )
    return [dict(zip(keys, row)) for row in rows]


def rank_candidates(
    rows: list[dict[str, Any]],
    role: str,
    target_key: str | None,
    target_bpm: float | None,
    *,
    centroid_target_hz: float | None = None,
    energy_level: float | None = None,
    require_on_disk: bool = True,
    use_cooldown: bool = True,
) -> list[dict[str, Any]]:
    """Score every row and return them best-first. Zero-scoring rows are dropped."""
    scored: list[dict[str, Any]] = []
    for row in rows:
        path = str(row.get("file_path") or "")
        if require_on_disk and not os.path.isfile(path):
            continue
        detail = score_candidate(
            row,
            role,
            target_key,
            target_bpm,
            centroid_target_hz=centroid_target_hz,
            energy_level=energy_level,
        )
        if detail["score"] <= 0.0:
            continue
        merged = dict(row)
        merged["score_detail"] = detail
        merged["score"] = detail["score"]
        # Cooldown nudge: a slice used many times slides down within its score
        # band so repeated requests do not all land on the same 64 files. It is
        # skipped in reproducible mode because it depends on render history.
        penalty = (
            0.012 * math.log1p(float(row.get("use_count") or 0)) if use_cooldown else 0.0
        )
        merged["rank_key"] = detail["score"] - penalty
        scored.append(merged)
    # file_path breaks score ties deterministically.
    scored.sort(key=lambda item: (-item["rank_key"], str(item["file_path"])))
    return scored


def pick_variants(
    ranked: list[dict[str, Any]],
    count: int,
    rng: Random,
    *,
    top_k: int = 12,
) -> list[dict[str, Any]]:
    """Seeded pick of ``count`` distinct slices from the top-scoring candidates.

    Selection is score-weighted rather than argmax, so the same prompt with a
    different seed lands on genuinely different (but still well-fitting) stems.
    """
    if not ranked or count <= 0:
        return []
    pool = ranked[: max(1, int(top_k))]
    chosen: list[dict[str, Any]] = []
    remaining = list(pool)
    while remaining and len(chosen) < int(count):
        weights = [max(1e-6, float(item["score"]) ** 3) for item in remaining]
        total = sum(weights)
        pick = rng.random() * total
        cursor = 0.0
        index = len(remaining) - 1
        for i, weight in enumerate(weights):
            cursor += weight
            if pick <= cursor:
                index = i
                break
        chosen.append(remaining.pop(index))
    # Not enough distinct top-K rows: extend from the rest of the ranking.
    overflow = [item for item in ranked[len(pool):] if item not in chosen]
    while overflow and len(chosen) < int(count):
        chosen.append(overflow.pop(0))
    return chosen


def select_for_role(
    conn: sqlite3.Connection,
    role: str,
    target_key: str | None,
    target_bpm: float | None,
    count: int,
    rng: Random,
    *,
    tags: Iterable[str] | None = None,
    centroid_target_hz: float | None = None,
    energy_level: float | None = None,
    fetch_limit: int = 400,
    top_k: int = 12,
    require_on_disk: bool = True,
    use_cooldown: bool = True,
    anchor_pack_id: str | None = None,
) -> list[dict[str, Any]]:
    """Fetch, score, and seeded-pick ``count`` slices for one role.

    Candidates come from the indexed stem + key + ±8 BPM pool (LIMIT 200),
    not a catalog-wide ``LIKE`` / ``RANDOM()`` scan.
    """
    _ = (tags, fetch_limit)  # tags are filename tokens; the indexed pool is the source.
    try:
        rows = _indexed_candidates(
            conn,
            role,
            target_key,
            target_bpm,
            limit=INDEXED_POOL_LIMIT,
            min_rows=max(int(count), int(top_k), 12),
            use_cooldown=use_cooldown,
        )
        ranked = rank_candidates(
            rows,
            role,
            target_key,
            target_bpm,
            centroid_target_hz=centroid_target_hz,
            energy_level=energy_level,
            require_on_disk=require_on_disk,
            use_cooldown=use_cooldown,
        )
    except Exception as exc:
        print(
            f"[SELECT] {role} picker failed ({type(exc).__name__}: {exc}) — empty",
            flush=True,
        )
        return []
    if role != "rhythm":
        ranked = apply_pack_affinity(ranked, anchor_pack_id)
    else:
        for item in ranked:
            item.setdefault("pack_id", pack_id_from_path(item.get("file_path")))
            item.setdefault("affinity_score", 0.0)
    return pick_variants(ranked, count, rng, top_k=top_k)


def fetch_stem_with_pack_affinity(
    conn: sqlite3.Connection,
    stem_type: str,
    anchor_slug: str,
    target_key: str,
    target_bpm: float,
    *,
    require_on_disk: bool = True,
    use_cooldown: bool = False,
) -> tuple[dict[str, Any] | None, str]:
    """One indexed pool (stem + key + ±8 BPM, LIMIT 200), then slug-match in Python.

    Never ``LIKE '%slug%'`` or ``ORDER BY RANDOM()`` on the 542k-row catalog.
    Zero matches return ``(None, "empty")`` — never raise.
    """
    family = str(stem_type or "").strip().lower()
    role = {
        "drums": "rhythm",
        "drum": "rhythm",
        "rhythm": "rhythm",
        "bass": "bass",
        "guitar": "harmonic",
        "rhythm_guitar": "harmonic",
        "keys": "harmonic",
        "synth": "harmonic",
        "harmonic": "harmonic",
        "vocal": "vocal",
        "vocals": "vocal",
    }.get(family, family or "harmonic")
    try:
        rows = _indexed_candidates(
            conn,
            role,
            target_key,
            target_bpm,
            limit=INDEXED_POOL_LIMIT,
            use_cooldown=use_cooldown,
        )
        ranked = rank_candidates(
            rows,
            role,
            target_key,
            target_bpm,
            require_on_disk=require_on_disk,
            use_cooldown=use_cooldown,
        )
        pool = ranked or rows
    except Exception as exc:
        print(
            f"[AFFINITY] picker failed ({type(exc).__name__}: {exc}) — empty",
            flush=True,
        )
        return None, "empty"
    if not pool:
        return None, "empty"
    want = str(anchor_slug or "")
    locked = [
        row
        for row in pool
        if extract_session_slug(row.get("file_path")) == want
        or pack_id_from_path(row.get("file_path")) == slug_pack_token(want)
    ]
    chosen = locked[0] if locked else pool[0]
    chosen["affinity_source"] = "session_locked" if locked else "global_fallback"
    chosen["pack_id"] = pack_id_from_path(chosen.get("file_path"))
    return chosen, chosen["affinity_source"]


def describe_selection(role: str, picks: list[dict[str, Any]]) -> str:
    if not picks:
        return f"[SELECT] {role}: no candidates"
    lines = []
    for item in picks:
        detail = item["score_detail"]
        lines.append(
            f"[SELECT] {role:<9} {os.path.basename(item['file_path']):<28} "
            f"score={detail['score']:.3f} key={item.get('detected_key')}"
            f"({detail['key']:.2f}) bpm={float(item.get('estimated_bpm') or 0):.0f}"
            f"({detail['bpm']:.2f}) cent={float(item.get('spectral_centroid') or 0):.0f}"
            f"({detail['centroid']:.2f}) rms={float(item.get('rms_db') or 0):.1f}"
            f"({detail['level']:.2f}) used={item.get('use_count') or 0}"
        )
    return "\n".join(lines)
