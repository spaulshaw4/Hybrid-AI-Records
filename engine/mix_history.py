"""Ledger of what the picker offered, what it chose, and how that landed.

The scorer's weights are currently hand-set constants. To replace judgement
with evidence the engine has to remember three things:

* **what it was asked for** — key, tempo, the chord progression, the weights in
  force (``mix_sessions``)
* **what it considered and what won** — every scored candidate per role, with
  its component fits, flagged chosen or not (``mix_decisions``)
* **how the finished track was treated** — exported and played through are
  positives, skipped early is a negative (``mix_verdicts``)

Written during the render, never afterwards: delivery purges the scratch tree
(a recent session freed 420 MB), so the stems are gone by the time a verdict
arrives. Verdicts attach later by ``session_id``.

Each chosen stem beats ~190 it was ranked against, so one finished track yields
hundreds of labelled comparisons rather than a single row -- which is what
makes learning viable at this catalogue's track count.

Lives in its own SQLite file. The live corpus index is never written.
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence

DEFAULT_LEDGER = r"C:\live_web_outputs\db\hybrid_mix_history.db"
_ENV_VAR = "HYBRID_MIX_HISTORY_DB"

# Same guard as the profiles DB: these are read-only catalogues, never targets.
PROTECTED_DBS = (
    os.path.normcase(os.path.abspath(r"C:\live_web_outputs\db\corpus_index_live.sqlite")),
    os.path.normcase(os.path.abspath(r"D:\MusicDatasets\db\corpus_index.sqlite")),
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS mix_sessions (
    session_id TEXT PRIMARY KEY,
    created_at TEXT,
    prompt TEXT,
    genre TEXT,
    song_key TEXT,
    scale TEXT,
    bpm REAL,
    total_bars INTEGER,
    seed TEXT,
    progression TEXT,
    pitch_weights TEXT,
    scorer TEXT,
    harmonic_fit REAL,
    rms_contrast_db REAL,
    kick_bass_transient_gap REAL
);

CREATE TABLE IF NOT EXISTS mix_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT,
    file_path TEXT,
    chosen INTEGER NOT NULL DEFAULT 0,
    rank INTEGER,
    score REAL,
    fit_key REAL,
    fit_chord REAL,
    fit_bpm REAL,
    fit_centroid REAL,
    fit_level REAL,
    fit_groove REAL
);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON mix_decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_chosen ON mix_decisions(chosen);

-- Implicit feedback. ``label`` is the training target: +1 exported,
-- playthrough scaled by how much was heard, negative for an early skip.
CREATE TABLE IF NOT EXISTS mix_verdicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    event TEXT NOT NULL,
    position_sec REAL,
    duration_sec REAL,
    label REAL,
    at TEXT
);
CREATE INDEX IF NOT EXISTS idx_verdicts_session ON mix_verdicts(session_id);
"""

# Below this fraction heard, a play is a rejection rather than a weak positive.
SKIP_FRACTION = 0.33


def ledger_path() -> str:
    return (os.environ.get(_ENV_VAR) or "").strip() or DEFAULT_LEDGER


def _refuse_protected(path: str) -> str:
    target = os.path.abspath(path)
    if os.path.normcase(target) in PROTECTED_DBS:
        raise RuntimeError(f"refusing to write the live corpus index: {target}")
    return target


def open_ledger(path: str | None = None) -> sqlite3.Connection:
    target = _refuse_protected(path or ledger_path())
    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    conn = sqlite3.connect(target, timeout=30.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=20000")
    conn.executescript(SCHEMA)
    return conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def record_session(
    conn: sqlite3.Connection,
    session_id: str,
    *,
    prompt: str = "",
    genre: str = "",
    song_key: str = "",
    scale: str = "",
    bpm: float = 0.0,
    total_bars: int = 0,
    seed: Any = None,
    progression: Sequence[str] | None = None,
    pitch_weights: Any = None,
    scorer: str = "legacy",
) -> None:
    """Upsert the request side of one render."""
    from engine.musical_features import pack_floats

    weights_txt = None
    if pitch_weights is not None:
        try:
            weights_txt = pack_floats(pitch_weights)
        except Exception:
            weights_txt = None
    conn.execute(
        """
        INSERT INTO mix_sessions
            (session_id, created_at, prompt, genre, song_key, scale, bpm, total_bars,
             seed, progression, pitch_weights, scorer)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET
            prompt=excluded.prompt, genre=excluded.genre, song_key=excluded.song_key,
            scale=excluded.scale, bpm=excluded.bpm, total_bars=excluded.total_bars,
            seed=excluded.seed, progression=excluded.progression,
            pitch_weights=excluded.pitch_weights, scorer=excluded.scorer
        """,
        (
            str(session_id),
            _now(),
            str(prompt)[:2000],
            str(genre),
            str(song_key),
            str(scale),
            float(bpm or 0.0),
            int(total_bars or 0),
            str(seed) if seed is not None else None,
            ",".join(str(c) for c in (progression or ())) or None,
            weights_txt,
            str(scorer),
        ),
    )
    conn.commit()


def record_decisions(
    conn: sqlite3.Connection,
    session_id: str,
    role: str,
    ranked: Iterable[Mapping[str, Any]],
    chosen_paths: Iterable[str],
    *,
    max_rows: int = 200,
) -> int:
    """Log the candidate pool for one role, flagging which stems were staged.

    The losers are the point: a chosen stem is only informative relative to the
    ones it was ranked against.
    """
    chosen = {str(p) for p in chosen_paths if p}
    rows: list[tuple] = []
    for rank, item in enumerate(list(ranked)[:max_rows]):
        detail = item.get("score_detail") or {}
        path = str(item.get("file_path") or "")
        rows.append(
            (
                str(session_id),
                str(role),
                path,
                int(path in chosen),
                int(rank),
                float(item.get("score") or 0.0),
                _num(detail.get("key")),
                _num(detail.get("chord")),
                _num(detail.get("bpm")),
                _num(detail.get("centroid")),
                _num(detail.get("level")),
                _num(detail.get("groove")),
            )
        )
    if not rows:
        return 0
    conn.executemany(
        """
        INSERT INTO mix_decisions
            (session_id, role, file_path, chosen, rank, score,
             fit_key, fit_chord, fit_bpm, fit_centroid, fit_level, fit_groove)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def _num(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def record_mix_math(
    conn: sqlite3.Connection,
    session_id: str,
    *,
    harmonic_fit: float | None = None,
    rms_contrast_db: float | None = None,
    kick_bass_transient_gap: float | None = None,
) -> None:
    """Attach the render's acoustic summary once the buses are staged."""
    conn.execute(
        """
        UPDATE mix_sessions
           SET harmonic_fit = COALESCE(?, harmonic_fit),
               rms_contrast_db = COALESCE(?, rms_contrast_db),
               kick_bass_transient_gap = COALESCE(?, kick_bass_transient_gap)
         WHERE session_id = ?
        """,
        (_num(harmonic_fit), _num(rms_contrast_db), _num(kick_bass_transient_gap), str(session_id)),
    )
    conn.commit()


def label_for_play(position_sec: float, duration_sec: float) -> float:
    """Implicit label from how much of a track was heard.

    A skip inside the first third is the negative example the loop needs;
    beyond that the label rises with the fraction played, reaching +1 on a
    full playthrough. No rating widget, no extra clicks.
    """
    try:
        pos, dur = float(position_sec), float(duration_sec)
    except (TypeError, ValueError):
        return 0.0
    if dur <= 0.0:
        return 0.0
    heard = max(0.0, min(1.0, pos / dur))
    if heard < SKIP_FRACTION:
        # -1 for an instant skip, easing to 0 at the threshold.
        return round(-1.0 * (1.0 - heard / SKIP_FRACTION), 4)
    return round((heard - SKIP_FRACTION) / (1.0 - SKIP_FRACTION), 4)


def record_verdict(
    conn: sqlite3.Connection,
    session_id: str,
    event: str,
    *,
    position_sec: float = 0.0,
    duration_sec: float = 0.0,
    label: float | None = None,
) -> float:
    """Log one implicit signal. ``export`` is a full positive on its own."""
    kind = str(event or "").strip().lower()
    if label is None:
        label = 1.0 if kind == "export" else label_for_play(position_sec, duration_sec)
    conn.execute(
        "INSERT INTO mix_verdicts (session_id, event, position_sec, duration_sec, label, at) "
        "VALUES (?,?,?,?,?,?)",
        (str(session_id), kind, float(position_sec or 0.0), float(duration_sec or 0.0),
         float(label), _now()),
    )
    conn.commit()
    return float(label)


def training_pairs(conn: sqlite3.Connection, *, min_label: float = 0.25) -> list[dict[str, Any]]:
    """Chosen stems from tracks that landed well, with their component fits.

    One row per staged stem in an approved render — the positive side of the
    ranking problem. Losers stay in ``mix_decisions`` for the pairwise fit.
    """
    rows = conn.execute(
        """
        SELECT d.session_id, d.role, d.file_path, d.score,
               d.fit_key, d.fit_chord, d.fit_bpm, d.fit_centroid, d.fit_level, d.fit_groove,
               AVG(v.label) AS label
          FROM mix_decisions AS d
          JOIN mix_verdicts  AS v ON v.session_id = d.session_id
         WHERE d.chosen = 1
         GROUP BY d.id
        HAVING label >= ?
        """,
        (float(min_label),),
    ).fetchall()
    keys = (
        "session_id", "role", "file_path", "score",
        "fit_key", "fit_chord", "fit_bpm", "fit_centroid", "fit_level", "fit_groove", "label",
    )
    return [dict(zip(keys, r)) for r in rows]


def summary(conn: sqlite3.Connection) -> dict[str, int]:
    def count(table: str) -> int:
        try:
            return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        except sqlite3.Error:
            return 0

    return {
        "sessions": count("mix_sessions"),
        "decisions": count("mix_decisions"),
        "chosen": int(
            conn.execute("SELECT COUNT(*) FROM mix_decisions WHERE chosen = 1").fetchone()[0]
        )
        if count("mix_decisions")
        else 0,
        "verdicts": count("mix_verdicts"),
    }
