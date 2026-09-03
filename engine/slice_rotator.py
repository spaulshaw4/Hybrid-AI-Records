"""SQLite cooldown rotation over the same corpus ``slice_index`` database.

``slice_history`` lives next to ``slice_index`` (not a second catalog). Empty
tags mean ``1=1`` or ``stem_type`` only — this is the assembler-facing picker,
not a silent no-op. Missing ``slice_index`` is a hard error; callers that must
keep assembling catch it and fall back to a glob pool.
"""
from __future__ import annotations

import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from db.index_578gb_corpus import default_index_db  # noqa: E402

DEFAULT_COOLDOWN_HOURS = 6
# slice_index currently has 0 ``lead`` rows. Route lead queries to harmonic
# rather than inventing a stem_type or leaving the layer empty.
LEAD_FALLBACK_STEM = "harmonic"
_DIAGNOSED_QUERIES: set[tuple[str, tuple[str, ...], str]] = set()
_LEAD_ROUTE_LOGGED = False
SLICE_HISTORY_DDL = """
CREATE TABLE IF NOT EXISTS slice_history (
    file_path TEXT PRIMARY KEY,
    last_used TEXT NOT NULL,
    use_count INTEGER NOT NULL DEFAULT 1
);
"""
HISTORY_INDEX_DDL = "CREATE INDEX IF NOT EXISTS idx_history_last_used ON slice_history (last_used);"
UPSERT_HISTORY_SQL = """
INSERT INTO slice_history (file_path, last_used, use_count)
VALUES (?, ?, 1)
ON CONFLICT(file_path) DO UPDATE SET
    last_used = excluded.last_used,
    use_count = slice_history.use_count + 1
"""


class SliceIndexMissingError(RuntimeError):
    """The corpus DB has no ``slice_index`` table — do not invent wav paths."""


def rotation_db_path(explicit: str | None = None) -> str:
    if explicit and str(explicit).strip():
        return str(explicit).strip()
    return default_index_db()


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        (name,),
    ).fetchone()
    return bool(row)


def require_slice_index(conn: sqlite3.Connection) -> None:
    if _table_exists(conn, "slice_index"):
        return
    raise SliceIndexMissingError(
        "slice_index is missing on this database. Point at an existing smoke "
        "index (D:\\MusicDatasets\\database\\corpus_index.sqlite or "
        "db\\corpus_index.sqlite). Will not invent files or walk 50k wavs."
    )


def init_rotation_schema(conn: sqlite3.Connection) -> None:
    """Create ``slice_history``. Requires ``slice_index`` already present."""
    require_slice_index(conn)
    conn.execute(SLICE_HISTORY_DDL)
    conn.execute(HISTORY_INDEX_DDL)
    conn.commit()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _iso(ts: datetime) -> str:
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _tag_where(tags: list | None, stem_type: str | None) -> tuple[str, list[Any]]:
    cleaned = [str(tag).strip() for tag in (tags or []) if str(tag).strip()]
    clauses: list[str] = []
    params: list[Any] = []
    if cleaned:
        like_parts = " OR ".join(["si.tags LIKE ?" for _ in cleaned])
        clauses.append(f"({like_parts})")
        params.extend(f"%{tag}%" for tag in cleaned)
    else:
        clauses.append("1=1")
    if stem_type:
        clauses.append("si.stem_type = ?")
        params.append(str(stem_type))
    return " AND ".join(clauses), params


def _select_paths(
    conn: sqlite3.Connection,
    where_sql: str,
    params: list[Any],
    target_key: str,
    limit: int,
    cooldown_cutoff: str | None,
) -> list[str]:
    sql = (
        "SELECT si.file_path FROM slice_index AS si "
        "LEFT JOIN slice_history AS sh ON sh.file_path = si.file_path "
        f"WHERE {where_sql}"
    )
    bound = list(params)
    if cooldown_cutoff is not None:
        sql += " AND (sh.last_used IS NULL OR sh.last_used <= ?)"
        bound.append(cooldown_cutoff)
    sql += " ORDER BY CASE WHEN si.detected_key = ? THEN 0 ELSE 1 END, RANDOM() LIMIT ?"
    bound.append(str(target_key or ""))
    bound.append(max(1, int(limit)))
    rows = conn.execute(sql, bound).fetchall()
    return [str(row[0]) for row in rows if row and row[0]]


def query_rotated_slices(
    conn: sqlite3.Connection,
    tags: list | None,
    target_key: str,
    limit: int = 12,
    stem_type: str | None = None,
    cooldown_hours: float = DEFAULT_COOLDOWN_HOURS,
) -> list[str]:
    """Prefer unused / cooled-down rows. Falls back if the cooldown starves the bank."""
    require_slice_index(conn)
    if not _table_exists(conn, "slice_history"):
        init_rotation_schema(conn)

    where_sql, params = _tag_where(tags, stem_type)
    want = max(1, int(limit))
    hours = max(0.0, float(cooldown_hours))
    cutoff = _iso(_utc_now() - timedelta(hours=hours)) if hours > 0 else None

    hits = _select_paths(conn, where_sql, params, target_key, want, cutoff)
    if len(hits) >= want:
        return hits
    # Cooldown left too few rows — ignore recency and refill from the same filter.
    return _select_paths(conn, where_sql, params, target_key, want, cooldown_cutoff=None)


def mark_slices_used(
    conn: sqlite3.Connection,
    paths: list[str],
    used_at: datetime | None = None,
) -> int:
    """Upsert ``slice_history`` for each path. Parameterized. Returns rows touched."""
    require_slice_index(conn)
    if not _table_exists(conn, "slice_history"):
        init_rotation_schema(conn)
    stamp = _iso(used_at or _utc_now())
    cleaned = [str(path) for path in paths if str(path).strip()]
    if not cleaned:
        return 0
    conn.executemany(UPSERT_HISTORY_SQL, [(path, stamp) for path in cleaned])
    conn.commit()
    return len(cleaned)


def _stem_count(conn: sqlite3.Connection, stem_type: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) FROM slice_index WHERE stem_type = ?",
        (str(stem_type),),
    ).fetchone()
    return int(row[0]) if row else 0


def _existing_paths(paths: list[str]) -> list[str]:
    return [path for path in paths if path and os.path.isfile(path)]


def print_query_funnel(
    conn: sqlite3.Connection,
    tags: list | None,
    stem_type: str | None,
    target_key: str,
    *,
    cooldown_hours: float = DEFAULT_COOLDOWN_HOURS,
    limit: int = 8,
) -> None:
    """Print the SELECT SQL, bound params, and row counts each WHERE clause survives."""
    cleaned = [str(tag).strip() for tag in (tags or []) if str(tag).strip()]
    key = str(target_key or "")

    def _n(sql: str, params: list[Any]) -> int:
        row = conn.execute(sql, params).fetchone()
        return int(row[0]) if row else 0

    total = _n("SELECT COUNT(*) FROM slice_index", [])
    n_stem = (
        _n("SELECT COUNT(*) FROM slice_index WHERE stem_type = ?", [stem_type])
        if stem_type
        else total
    )
    n_key = (
        _n(
            "SELECT COUNT(*) FROM slice_index WHERE stem_type = ? AND detected_key = ?",
            [stem_type, key],
        )
        if stem_type
        else _n("SELECT COUNT(*) FROM slice_index WHERE detected_key = ?", [key])
    )
    if cleaned:
        like_sql = " OR ".join(["tags LIKE ?" for _ in cleaned])
        like_params: list[Any] = [f"%{tag}%" for tag in cleaned]
        n_tags = _n(f"SELECT COUNT(*) FROM slice_index WHERE ({like_sql})", like_params)
        n_tags_stem = (
            _n(
                f"SELECT COUNT(*) FROM slice_index WHERE stem_type = ? AND ({like_sql})",
                [stem_type, *like_params],
            )
            if stem_type
            else n_tags
        )
        n_tags_stem_key = (
            _n(
                f"SELECT COUNT(*) FROM slice_index WHERE stem_type = ? AND detected_key = ? "
                f"AND ({like_sql})",
                [stem_type, key, *like_params],
            )
            if stem_type
            else 0
        )
    else:
        n_tags = total
        n_tags_stem = n_stem
        n_tags_stem_key = n_key

    hours = max(0.0, float(cooldown_hours))
    cutoff = _iso(_utc_now() - timedelta(hours=hours)) if hours > 0 else None
    where_sql, params = _tag_where(tags, stem_type)
    sql = (
        "SELECT si.file_path FROM slice_index AS si "
        "LEFT JOIN slice_history AS sh ON sh.file_path = si.file_path "
        f"WHERE {where_sql}"
    )
    bound: list[Any] = list(params)
    if cutoff is not None:
        sql += " AND (sh.last_used IS NULL OR sh.last_used <= ?)"
        bound.append(cutoff)
    sql += " ORDER BY CASE WHEN si.detected_key = ? THEN 0 ELSE 1 END, RANDOM() LIMIT ?"
    bound.append(key)
    bound.append(max(1, int(limit)))
    print(f"[SQL] {sql}")
    print(f"[PARAMS] {bound}")
    print(
        f"[FUNNEL] total={total} stem_type={n_stem} stem+key={n_key} "
        f"tags_only={n_tags} tags+stem={n_tags_stem} tags+stem+key={n_tags_stem_key}"
    )
    if stem_type:
        sample = [
            str(row[0])
            for row in conn.execute(
                "SELECT file_path FROM slice_index WHERE stem_type = ? LIMIT 20",
                (stem_type,),
            ).fetchall()
        ]
        on_disk = sum(1 for path in sample if path and os.path.isfile(path))
        print(f"[FUNNEL] sample_isfile={on_disk}/20 stem={stem_type!r}")


def query_rotated_bank(
    db_path: str,
    tags: list | None,
    stem_type: str,
    target_key: str,
    limit: int = 16,
    cooldown_hours: float = DEFAULT_COOLDOWN_HOURS,
    mark_used: bool = True,
    diagnose: bool = True,
) -> list[str]:
    """Open ``db_path``, rotate, optionally mark, skip missing files.

    Degrades tags+stem → tags → stem_type only so a populated stem (e.g. 1215
    harmonic rows) is never empty just because blueprint tags missed. ``lead``
    with 0 index rows is routed to ``harmonic``. Returns [] when the DB file
    is absent or ``slice_index`` is missing so assemble can glob-fallback.
    """
    if not db_path or not os.path.isfile(db_path):
        return []
    conn = sqlite3.connect(db_path)
    try:
        try:
            init_rotation_schema(conn)
        except SliceIndexMissingError:
            return []
        requested = str(stem_type or "").strip()
        query_stem = requested
        global _LEAD_ROUTE_LOGGED
        if requested == "lead" and _stem_count(conn, "lead") == 0:
            query_stem = LEAD_FALLBACK_STEM
            if not _LEAD_ROUTE_LOGGED:
                print(
                    f"[STAGE] lead index COUNT(*)=0; documented fallback "
                    f"stem_type={LEAD_FALLBACK_STEM}"
                )
                _LEAD_ROUTE_LOGGED = True

        attempts: list[tuple[str, list | None, str | None]] = [
            ("tags+stem", tags, query_stem),
        ]
        cleaned = [str(tag).strip() for tag in (tags or []) if str(tag).strip()]
        if cleaned:
            attempts.append(("tags", tags, None))
        attempts.append(("stem", [], query_stem))

        for label, attempt_tags, attempt_stem in attempts:
            hits = query_rotated_slices(
                conn,
                attempt_tags,
                target_key,
                limit=limit,
                stem_type=attempt_stem,
                cooldown_hours=cooldown_hours,
            )
            existing = _existing_paths(hits)
            if existing:
                if label != "tags+stem":
                    print(
                        f"[STAGE] {requested or query_stem} filled via {label} "
                        f"({len(existing)} files, stem={attempt_stem!r})"
                    )
                if mark_used:
                    mark_slices_used(conn, existing)
                return existing
            if diagnose and label == "tags+stem":
                diag_key = (requested, tuple(cleaned), str(target_key or ""))
                if diag_key not in _DIAGNOSED_QUERIES:
                    _DIAGNOSED_QUERIES.add(diag_key)
                    print(
                        f"[STAGE] {requested} tags+stem returned 0; diagnosing "
                        f"tags={cleaned!r} key={target_key!r}"
                    )
                    print_query_funnel(
                        conn,
                        attempt_tags,
                        attempt_stem,
                        target_key,
                        cooldown_hours=cooldown_hours,
                        limit=limit,
                    )
        return []
    except sqlite3.Error:
        return []
    finally:
        conn.close()
