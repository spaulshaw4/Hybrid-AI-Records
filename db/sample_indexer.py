"""Assembler-facing corpus query API over the unified ``slice_index`` schema.

Empty ``tags`` → ``query_corpus_slices`` returns [] (no untagged-by-key scan).
``resolve_corpus_bank`` substitutes ``[stem_type]`` when tags are empty, prefers
matching ``detected_key``, and skips missing files.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from typing import Any

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from db.index_578gb_corpus import (  # noqa: E402
    INSERT_SQL,
    analyze_single_slice,
    assert_safe_corpus,
    default_index_db,
    discover_wavs,
    infer_stem_type,
    init_db,
    tags_from_path,
)


def _table_exists(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='slice_index'"
    ).fetchone()
    return bool(row)


def query_corpus_slices(
    conn: sqlite3.Connection,
    tags: list | None,
    target_key: str,
    limit: int = 12,
    stem_type: str | None = None,
) -> list[str]:
    """Best-fit paths from ``slice_index`` (parameterized LIKE, key preferred).

    Empty or missing ``tags`` returns [] without error. This does **not** fall
    back to an untagged key-only scan — use ``resolve_corpus_bank`` for that.
    """
    cleaned = [str(tag).strip() for tag in (tags or []) if str(tag).strip()]
    if not cleaned:
        return []
    if not _table_exists(conn):
        return []
    like_parts = " OR ".join(["tags LIKE ?" for _ in cleaned])
    params: list[Any] = [f"%{tag}%" for tag in cleaned]
    sql = f"SELECT file_path FROM slice_index WHERE ({like_parts})"
    if stem_type:
        sql += " AND stem_type = ?"
        params.append(str(stem_type))
    sql += " ORDER BY CASE WHEN detected_key = ? THEN 0 ELSE 1 END, RANDOM() LIMIT ?"
    params.append(str(target_key or ""))
    params.append(max(1, int(limit)))
    rows = conn.execute(sql, params).fetchall()
    return [str(row[0]) for row in rows if row and row[0]]


def resolve_corpus_bank(
    db_path: str,
    tags: list | None,
    stem_type: str,
    target_key: str,
    limit: int = 16,
) -> list[str]:
    """Open ``db_path`` and degrade: tags+stem → tags → stem_type only.

    Empty tags no longer LIKE the stem name (harmonic rows are tagged from
    paths, not the word ``harmonic``). Skip missing files.
    """
    if not db_path or not os.path.isfile(db_path):
        return []
    cleaned = [str(tag).strip() for tag in (tags or []) if str(tag).strip()]
    query_stem = str(stem_type or "").strip()
    conn = sqlite3.connect(db_path)
    try:
        if not _table_exists(conn):
            return []
        if query_stem == "lead":
            lead_n = conn.execute(
                "SELECT COUNT(*) FROM slice_index WHERE stem_type = ?",
                ("lead",),
            ).fetchone()
            if not lead_n or int(lead_n[0]) < 1:
                query_stem = "harmonic"

        want = max(1, int(limit))
        key = str(target_key or "")
        attempts: list[tuple[str, list[str], str | None]] = []
        if cleaned and query_stem:
            attempts.append(("tags+stem", cleaned, query_stem))
        if cleaned:
            attempts.append(("tags", cleaned, None))
        if query_stem:
            attempts.append(("stem", [], query_stem))

        for _label, attempt_tags, attempt_stem in attempts:
            params: list[Any] = []
            clauses: list[str] = []
            if attempt_stem:
                clauses.append("stem_type = ?")
                params.append(attempt_stem)
            if attempt_tags:
                like_parts = " OR ".join(["tags LIKE ?" for _ in attempt_tags])
                clauses.append(f"({like_parts})")
                params.extend(f"%{tag}%" for tag in attempt_tags)
            if not clauses:
                continue
            sql = (
                f"SELECT file_path FROM slice_index WHERE {' AND '.join(clauses)} "
                "ORDER BY CASE WHEN detected_key = ? THEN 0 ELSE 1 END, RANDOM() LIMIT ?"
            )
            params.extend([key, want])
            rows = conn.execute(sql, params).fetchall()
            existing = [
                str(row[0])
                for row in rows
                if row and row[0] and os.path.isfile(str(row[0]))
            ]
            if existing:
                return existing
        return []
    finally:
        conn.close()


def index_count(db_path: str) -> int:
    if not db_path or not os.path.isfile(db_path):
        return 0
    conn = sqlite3.connect(db_path)
    try:
        if not _table_exists(conn):
            return 0
        return int(conn.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0])
    except sqlite3.Error:
        return 0
    finally:
        conn.close()


def _path_only_row(file_path: str) -> dict[str, Any]:
    duration = None
    try:
        import soundfile as sf

        info = sf.info(file_path)
        if info.samplerate and info.frames:
            duration = round(float(info.frames) / float(info.samplerate), 2)
    except Exception:
        duration = None
    path_clean = file_path.lower().replace("\\", "/")
    return {
        "file_path": file_path,
        "filename": os.path.basename(file_path),
        "stem_type": infer_stem_type(path_clean),
        "detected_key": None,
        "estimated_bpm": None,
        "rms_db": None,
        "spectral_centroid": None,
        "tags": tags_from_path(file_path),
        "duration_sec": duration,
    }


def index_directory(
    corpus_dir: str,
    db: str,
    limit: int | None = 200,
    analyze_audio: bool = False,
) -> int:
    """Walk wavs; tags from filename/folder only unless ``analyze_audio``."""
    assert_safe_corpus(corpus_dir)
    files = discover_wavs(corpus_dir, limit=limit)
    conn = init_db(db)
    try:
        batch = []
        for path in files:
            res = analyze_single_slice(path) if analyze_audio else _path_only_row(path)
            if not res:
                continue
            batch.append(
                (
                    res["file_path"],
                    res["filename"],
                    res["stem_type"],
                    res.get("detected_key"),
                    res.get("estimated_bpm"),
                    res.get("rms_db"),
                    res.get("spectral_centroid"),
                    res["tags"],
                    res.get("duration_sec"),
                )
            )
            if len(batch) >= 500:
                conn.executemany(INSERT_SQL, batch)
                conn.commit()
                batch.clear()
        if batch:
            conn.executemany(INSERT_SQL, batch)
            conn.commit()
        return int(conn.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0])
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Query or lightly index slice_index")
    parser.add_argument("--index-dir", default=None)
    parser.add_argument("--db", default=default_index_db())
    parser.add_argument("--query-tags", default="", help="Comma or space separated tags")
    parser.add_argument("--key", default="A")
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--stem-type", default=None)
    parser.add_argument("--analyze", action="store_true", help="Cheap DSP features while indexing")
    args = parser.parse_args(argv)

    if args.index_dir:
        try:
            count = index_directory(
                args.index_dir,
                args.db,
                limit=args.limit,
                analyze_audio=args.analyze,
            )
        except ValueError as exc:
            print(f"[FATAL] {exc}", file=sys.stderr)
            return 1
        print(f"[INDEX] {count} row(s) in {args.db}")

    tags = [part.strip() for part in args.query_tags.replace(",", " ").split() if part.strip()]
    if tags or not args.index_dir:
        created = False
        if os.path.isfile(args.db):
            conn = sqlite3.connect(args.db)
        else:
            conn = sqlite3.connect(":memory:")
            created = True
        try:
            if created:
                conn.executescript(
                    "CREATE TABLE IF NOT EXISTS slice_index ("
                    "id INTEGER PRIMARY KEY, file_path TEXT UNIQUE, filename TEXT, "
                    "stem_type TEXT, detected_key TEXT, estimated_bpm REAL, "
                    "rms_db REAL, spectral_centroid REAL, tags TEXT, duration_sec REAL)"
                )
            hits = query_corpus_slices(
                conn,
                tags,
                args.key,
                limit=args.limit,
                stem_type=args.stem_type,
            )
        finally:
            conn.close()
        print(f"[QUERY] {len(hits)} hit(s)")
        for path in hits:
            print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
