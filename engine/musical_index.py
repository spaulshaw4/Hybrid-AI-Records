"""Read-only accessor for the isolated musical-feature DB.

``slice_musical`` is keyed on the same ``file_path`` as ``slice_index``, so the
picker can decorate candidate rows with chroma / onset grid without the live
index ever being written or path-matched.

Everything degrades to "no opinion": a missing DB, a missing row, or a partly
backfilled corpus leaves the fields absent and the scorer falls back to its
neutral 0.5, so selection never gets worse than it was before the backfill.
"""
from __future__ import annotations

import os
import sqlite3
from typing import Any, Iterable, Sequence

DEFAULT_MUSICAL_DB = r"C:\live_web_outputs\db\hybrid_acoustic_profiles.db"
_ENV_VAR = "HYBRID_MUSICAL_DB"
# Cap the IN(...) list so a large candidate pool cannot blow SQLite's limit.
_CHUNK = 400


def musical_db_path() -> str:
    return (os.environ.get(_ENV_VAR) or "").strip() or DEFAULT_MUSICAL_DB


def open_musical_db(path: str | None = None) -> sqlite3.Connection | None:
    """Read-only handle, or None when the backfill has not produced a DB yet."""
    target = path or musical_db_path()
    if not os.path.isfile(target):
        return None
    try:
        conn = sqlite3.connect(f"file:{target}?mode=ro", uri=True, check_same_thread=False)
        conn.execute("PRAGMA busy_timeout=15000")
        conn.execute("SELECT 1 FROM slice_musical LIMIT 1")
        return conn
    except sqlite3.Error:
        return None


def fetch_musical(
    conn: sqlite3.Connection | None,
    file_paths: Sequence[str],
) -> dict[str, dict[str, Any]]:
    """Map ``file_path`` -> {chroma, onset_grid, ...} for the paths that have rows."""
    if conn is None or not file_paths:
        return {}
    out: dict[str, dict[str, Any]] = {}
    paths = [str(p) for p in file_paths if p]
    for start in range(0, len(paths), _CHUNK):
        chunk = paths[start : start + _CHUNK]
        marks = ",".join("?" * len(chunk))
        try:
            rows = conn.execute(
                "SELECT file_path, chroma, onset_grid, chroma_root, chroma_is_minor, "
                f"chroma_confidence, downbeat_phase FROM slice_musical WHERE file_path IN ({marks})",
                chunk,
            ).fetchall()
        except sqlite3.Error:
            return out
        for path, chroma, grid, root, minor, conf, phase in rows:
            out[str(path)] = {
                "chroma": chroma,
                "onset_grid": grid,
                "chroma_root": root,
                "chroma_is_minor": bool(minor),
                "chroma_confidence": conf,
                "downbeat_phase": phase,
            }
    return out


def decorate_rows(
    rows: Iterable[dict[str, Any]],
    conn: sqlite3.Connection | None = None,
    *,
    close: bool = False,
) -> list[dict[str, Any]]:
    """Attach musical features in place. Returns the same list for chaining."""
    items = list(rows)
    if not items:
        return items
    owned = False
    if conn is None:
        conn = open_musical_db()
        owned = True
    if conn is None:
        return items
    try:
        found = fetch_musical(conn, [str(r.get("file_path") or "") for r in items])
        for row in items:
            extra = found.get(str(row.get("file_path") or ""))
            if extra:
                row.update(extra)
    finally:
        if owned or close:
            try:
                conn.close()
            except sqlite3.Error:
                pass
    return items


def coverage(conn: sqlite3.Connection | None = None) -> dict[str, int]:
    """How much of the corpus has musical features yet (for reporting)."""
    owned = conn is None
    conn = conn or open_musical_db()
    if conn is None:
        return {"musical_rows": 0}
    try:
        n = int(conn.execute("SELECT COUNT(*) FROM slice_musical").fetchone()[0])
    except sqlite3.Error:
        n = 0
    finally:
        if owned:
            try:
                conn.close()
            except sqlite3.Error:
                pass
    return {"musical_rows": n}
