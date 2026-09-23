"""Module 4 — Plan-conditioned SQLite stem retrieval.

Bridges ``GlobalSongPlan`` / ``SectionPlan`` queries to the corpus
``slice_index`` table with BPM (±8 %) and key (±2 semitone) tolerances.
"""
from __future__ import annotations

import math
import os
import sqlite3
from typing import Any, Iterable, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field

from engine.song_plan import GenreVector, NOTE_NAMES, _FLAT_TO_SHARP
from engine.stem_selector import (
    BASS_CENTROID_FALLBACK_HZ,
    BPM_INDEX_DDL,
    BPM_INDEX_NAME,
    DEAD_RMS_DBFS,
    _bass_token_sql,
    _stem_ml_enabled,
    _stem_type_for_role,
    bpm_distance_sql,
    bpm_window_sql,
    fold_bpm,
    note_to_semitone,
    score_candidate,
)

CANDIDATE_COLUMNS = (
    "file_path",
    "filename",
    "stem_type",
    "detected_key",
    "estimated_bpm",
    "rms_db",
    "spectral_centroid",
    "duration_sec",
)

# Instrument families from the Module 4 brief → corpus / bus roles.
INSTRUMENT_FAMILIES = (
    "drums",
    "bass",
    "rhythm_guitar",
    "lead_guitar",
    "synth",
    "synth_lead",
    "vocal",
)

FAMILY_TO_ROLE: dict[str, str] = {
    "drums": "rhythm",
    "bass": "bass",
    "rhythm_guitar": "harmonic",
    "lead_guitar": "harmonic",
    "synth": "harmonic",
    "synth_lead": "harmonic",
    "vocal": "vocal",
}

# Melodic leads get their own mixer bus so the mid-carve can key on them and
# carve the harmonic bed (they are retrieved from harmonic corpus rows).
LEAD_BUS = "lead"
LEAD_FAMILIES = frozenset({"lead_guitar", "synth_lead"})

MINOR_SCALES = frozenset({"minor", "natural_minor", "aeolian", "dorian", "phrygian", "harmonic_minor"})
MAJOR_SCALES = frozenset({"major", "ionian", "mixolydian", "lydian"})

ROLE_TO_BUS: dict[str, str] = {
    "rhythm": "rhythm",
    "bass": "bass",
    "harmonic": "harmonic",
    "vocal": "vocal",
    "lead": "harmonic",
}

BPM_TOLERANCE = 0.08  # ±8 % for pitch-neutral time-stretch
KEY_SEMITONE_TOLERANCE = 2
DEFAULT_FETCH_LIMIT = 400


class StemCandidateQuery(BaseModel):
    """Retrieval contract derived from an active ``SectionPlan``."""

    model_config = ConfigDict(extra="forbid")

    instrument_family: str = Field(
        ...,
        description="drums | bass | rhythm_guitar | lead_guitar | synth | vocal",
    )
    target_bpm: int = Field(..., ge=40, le=240)
    target_key: str
    target_chord: str = ""
    energy_tier: float = Field(0.5, ge=0.0, le=1.0)
    genre_vector: GenreVector = Field(default_factory=GenreVector)
    scale: str = ""
    time_signature: str = "4/4"

    def role(self) -> str:
        family = str(self.instrument_family or "").strip().lower()
        return FAMILY_TO_ROLE.get(family, "harmonic")

    def bus(self) -> str:
        family = str(self.instrument_family or "").strip().lower()
        if family in LEAD_FAMILIES:
            return LEAD_BUS
        return ROLE_TO_BUS.get(self.role(), "harmonic")


def normalize_key_root(raw: str | None) -> str | None:
    token = str(raw or "").strip()
    if not token:
        return None
    # Chord symbol → root only.
    head = token[:2].upper() if len(token) > 1 and token[1] in "#bB" else token[:1].upper()
    head = _FLAT_TO_SHARP.get(head, head)
    if head in NOTE_NAMES:
        return head
    pc = note_to_semitone(token)
    return NOTE_NAMES[pc] if pc is not None else None


def bpm_within_tolerance(
    candidate_bpm: float | None,
    target_bpm: float,
    *,
    tolerance: float = BPM_TOLERANCE,
) -> bool:
    """True when folded candidate BPM sits inside ±tolerance of target."""
    if not candidate_bpm or float(candidate_bpm) <= 0 or float(target_bpm) <= 0:
        return False
    folded = fold_bpm(float(candidate_bpm), float(target_bpm))
    ratio = folded / float(target_bpm)
    return (1.0 - tolerance) <= ratio <= (1.0 + tolerance)


def key_within_tolerance(
    candidate_key: str | None,
    target_key: str | None,
    *,
    max_semitones: int = KEY_SEMITONE_TOLERANCE,
    scale: str | None = None,
) -> tuple[bool, int]:
    """Exact or within ±max_semitones. Returns (ok, signed semitone shift).

    ``detected_key`` is a pitch class only (no mode). With a known ``scale``,
    the relative major/minor root shares the target's pitch set, so it is
    accepted with no shift (e.g. G for E minor, C#/Db for E major).
    """
    tgt = normalize_key_root(target_key)
    src = normalize_key_root(candidate_key)
    if tgt is None:
        return True, 0
    if src is None:
        return False, 0
    src_pc = NOTE_NAMES.index(src)
    tgt_pc = NOTE_NAMES.index(tgt)
    mode = str(scale or "").strip().lower()
    if mode in MINOR_SCALES and src_pc == (tgt_pc + 3) % 12:
        return True, 0
    if mode in MAJOR_SCALES and src_pc == (tgt_pc + 9) % 12:
        return True, 0
    # Shortest signed distance in [-6, +5].
    delta = (tgt_pc - src_pc + 6) % 12 - 6
    return abs(delta) <= int(max_semitones), int(delta)


def energy_rms_window(energy_tier: float) -> tuple[float, float]:
    """Map section energy (0..1) to an acceptable RMS dBFS window."""
    tier = max(0.0, min(1.0, float(energy_tier)))
    # Sparse → quieter (-38..-22); climax → denser (-28..-10).
    lo = -38.0 + 10.0 * tier
    hi = -22.0 + 12.0 * tier
    return float(lo), float(hi)


def energy_tier_match(rms_db: float | None, energy_tier: float) -> bool:
    if rms_db is None:
        return False
    value = float(rms_db)
    if value <= DEAD_RMS_DBFS:
        return False
    lo, hi = energy_rms_window(energy_tier)
    # Soft pad so borderline slices still enter the pool.
    return (lo - 6.0) <= value <= (hi + 4.0)


def build_stem_sql(
    query: StemCandidateQuery,
    *,
    fetch_limit: int = DEFAULT_FETCH_LIMIT,
    use_ml_bass: bool = False,
    bpm_tolerance: float = BPM_TOLERANCE,
    bass_source: str = "name",
    tags: Iterable[str] | None = None,
) -> tuple[str, list[Any]]:
    """Parameterized SQL executed by ``SQLiteStemRetriever.retrieve``.

    Role, non-silent RMS, the section energy window, and the BPM tolerance
    (target, half-time, double-time) are all applied in SQL, so ``LIMIT``
    returns in-tempo rows ranked by tempo distance — not the first N paths.
    Vocal rows with no detected BPM stay eligible but rank last. Key
    tolerance and scoring still run in Python (``filter_candidates``).
    """
    role = query.role()
    where = ["si.filename NOT LIKE 'mixture%'"]
    params: list[Any] = []

    if role == "bass":
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
            if use_ml_bass:
                where.append(f"({token_sql} OR lower(si.stem_type_ml) = 'bass')")
            else:
                where.append(token_sql)
            params.extend(token_params)
    else:
        stem = _stem_type_for_role(role)
        if stem:
            where.append("si.stem_type = ?")
            params.append(stem)
        if role in {"harmonic", "lead"}:
            where.append("si.filename NOT LIKE 'bass%'")

    cleaned = [str(t).strip() for t in (tags or []) if str(t).strip()]
    if cleaned:
        where.append("(" + " OR ".join("si.tags LIKE ?" for _ in cleaned) + ")")
        params.extend(f"%{tag}%" for tag in cleaned)

    where.append("si.rms_db > ?")
    params.append(float(DEAD_RMS_DBFS))

    window_sql, window_params = bpm_window_sql(
        float(query.target_bpm), bpm_tolerance, include_null=role == "vocal"
    )
    where.append(window_sql)
    params.extend(window_params)

    lo, hi = energy_rms_window(query.energy_tier)
    where.append("si.rms_db >= ?")
    params.append(lo - 8.0)
    where.append("si.rms_db <= ?")
    params.append(hi + 6.0)

    distance_sql, distance_params = bpm_distance_sql(float(query.target_bpm))
    sql = (
        "SELECT " + ", ".join(f"si.{col}" for col in CANDIDATE_COLUMNS) + " "
        "FROM slice_index AS si "
        f"WHERE {' AND '.join(where)} "
        f"ORDER BY (si.estimated_bpm IS NULL) ASC, {distance_sql} ASC, si.file_path ASC "
        "LIMIT ?"
    )
    params.extend(distance_params)
    params.append(max(1, int(fetch_limit)))
    return sql, params


def has_bpm_index(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?",
        (BPM_INDEX_NAME,),
    ).fetchone()
    return bool(row and int(row[0]) > 0)


_BPM_INDEX_REPORTED: set[tuple[str, bool]] = set()


def report_bpm_index(conn: sqlite3.Connection, *, label: str) -> bool:
    """Log the tempo-index state once per catalog per process; return presence."""
    present = has_bpm_index(conn)
    key = (str(label), present)
    if key not in _BPM_INDEX_REPORTED:
        _BPM_INDEX_REPORTED.add(key)
        if present:
            print(f"[RETRIEVER] {BPM_INDEX_NAME} present on {label}; tempo-window queries indexed", flush=True)
        else:
            print(
                f"[RETRIEVER] slice_index on {label} has no BPM index; tempo-window "
                f"queries will scan. Run: python db/migrate_slice_index.py "
                f"(DDL: {BPM_INDEX_DDL})",
                flush=True,
            )
    return present


def filter_candidates(
    rows: Sequence[Mapping[str, Any]],
    query: StemCandidateQuery,
    *,
    bpm_tolerance: float = BPM_TOLERANCE,
    key_semitones: int = KEY_SEMITONE_TOLERANCE,
) -> list[dict[str, Any]]:
    """Apply BPM ±tol, key ±N, and energy_tier filters; attach pitch-shift meta."""
    out: list[dict[str, Any]] = []
    for row in rows:
        bpm_ok = bpm_within_tolerance(
            row.get("estimated_bpm"),
            float(query.target_bpm),
            tolerance=bpm_tolerance,
        )
        # Allow missing BPM through (adapter will estimate) but mark it.
        if row.get("estimated_bpm") is not None and not bpm_ok:
            continue
        key_ok, shift = key_within_tolerance(
            row.get("detected_key"),
            query.target_key,
            max_semitones=key_semitones,
            scale=query.scale,
        )
        if not key_ok:
            continue
        if not energy_tier_match(row.get("rms_db"), query.energy_tier):
            continue
        merged = dict(row)
        merged["pitch_shift_semitones"] = int(shift)
        merged["bpm_ok"] = bool(bpm_ok or row.get("estimated_bpm") is None)
        merged["instrument_family"] = query.instrument_family
        merged["role"] = query.role()
        merged["bus"] = query.bus()
        merged["target_chord"] = query.target_chord
        merged["scale"] = query.scale
        detail = score_candidate(
            row,
            query.role(),
            query.target_key,
            float(query.target_bpm),
            energy_level=query.energy_tier,
        )
        # Soft genre bias: aggression prefers brighter centroids.
        aggression = float(query.genre_vector.spectral_aggression)
        centroid = float(row.get("spectral_centroid") or 0.0)
        if centroid > 1.0:
            bright = min(1.0, math.log10(max(10.0, centroid)) / 4.0)
            detail["score"] = round(
                float(detail["score"]) * (0.85 + 0.30 * (1.0 - abs(bright - aggression))),
                4,
            )
        merged["score_detail"] = detail
        merged["score"] = detail["score"]
        if detail["score"] > 0.0:
            out.append(merged)
    out.sort(key=lambda item: (-float(item["score"]), str(item.get("file_path") or "")))
    return out


class SQLiteStemRetriever:
    """Query ``slice_index`` for section-conditioned stem candidates."""

    def __init__(
        self,
        conn: sqlite3.Connection | None = None,
        *,
        index_db: str | None = None,
        bpm_tolerance: float = BPM_TOLERANCE,
        key_semitones: int = KEY_SEMITONE_TOLERANCE,
        fetch_limit: int = DEFAULT_FETCH_LIMIT,
        require_on_disk: bool = True,
    ) -> None:
        self._owned = False
        self.conn = conn
        self.index_db = index_db
        self.bpm_tolerance = float(bpm_tolerance)
        self.key_semitones = int(key_semitones)
        self.fetch_limit = int(fetch_limit)
        self.require_on_disk = bool(require_on_disk)
        if self.conn is None and index_db:
            self.conn = self._open(index_db)
            self._owned = self.conn is not None
        if self.conn is not None:
            report_bpm_index(self.conn, label=index_db or "<connection>")

    @staticmethod
    def _open(path: str) -> sqlite3.Connection | None:
        if not path or not os.path.isfile(path):
            return None
        try:
            conn = sqlite3.connect(path)
            row = conn.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='slice_index'"
            ).fetchone()
            if not row or int(row[0]) < 1:
                conn.close()
                return None
            return conn
        except sqlite3.Error:
            return None

    def close(self) -> None:
        if self._owned and self.conn is not None:
            self.conn.close()
            self.conn = None

    def __enter__(self) -> "SQLiteStemRetriever":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def query_sql(self, query: StemCandidateQuery) -> tuple[str, list[Any]]:
        return build_stem_sql(
            query, fetch_limit=self.fetch_limit, bpm_tolerance=self.bpm_tolerance
        )

    def _execute(
        self,
        query: StemCandidateQuery,
        *,
        tags: Iterable[str] | None = None,
        use_ml_bass: bool = False,
        bass_source: str = "name",
    ) -> list[dict[str, Any]]:
        if self.conn is None:
            return []
        sql, params = build_stem_sql(
            query,
            fetch_limit=self.fetch_limit,
            use_ml_bass=use_ml_bass,
            bpm_tolerance=self.bpm_tolerance,
            bass_source=bass_source,
            tags=tags,
        )
        return [dict(zip(CANDIDATE_COLUMNS, row)) for row in self.conn.execute(sql, params)]

    def retrieve(
        self,
        query: StemCandidateQuery,
        *,
        limit: int = 12,
        tags: Iterable[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Return scored candidates within BPM/key/energy tolerances.

        ``sqlite3.Error`` propagates so callers can record why retrieval failed.
        """
        if self.conn is None:
            return []
        role = query.role()
        use_ml_bass = role == "bass" and _stem_ml_enabled(self.conn)
        rows = self._execute(query, tags=tags, use_ml_bass=use_ml_bass)
        if role == "bass" and not rows:
            rows = self._execute(query, tags=tags, bass_source="low_centroid")
        filtered = filter_candidates(
            rows,
            query,
            bpm_tolerance=self.bpm_tolerance,
            key_semitones=self.key_semitones,
        )
        if self.require_on_disk:
            filtered = [
                row for row in filtered if os.path.isfile(str(row.get("file_path") or ""))
            ]
        return filtered[: max(1, int(limit))]

    def best_candidate(
        self,
        query: StemCandidateQuery,
        *,
        tags: Iterable[str] | None = None,
    ) -> dict[str, Any] | None:
        hits = self.retrieve(query, limit=1, tags=tags)
        return hits[0] if hits else None
