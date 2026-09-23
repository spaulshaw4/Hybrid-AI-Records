"""Add the tempo-window index to a ``slice_index`` corpus catalog.

    python db/migrate_slice_index.py                      # live C: replica
    python db/migrate_slice_index.py --db path/to/catalog.sqlite
    python db/migrate_slice_index.py --db D:\\...\\corpus_index.sqlite --allow-source-index

Creates ``idx_slice_index_bpm ON slice_index (stem_type, estimated_bpm)``
(used by ``engine.stem_retriever.build_stem_sql``), refreshes planner
statistics, and prints the query plan of a representative tempo-window
query so you can confirm the index is picked up. Idempotent.

The Learner's D: source catalog is refused unless ``--allow-source-index``:
the live worker must not take write locks on it (see ``engine.live_index``).
The live replica also gets this index automatically on every refresh via
``engine.live_index.ROLE_INDEX_DDL``.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

INDEX_NAME = "idx_slice_index_bpm"
INDEX_DDL = (
    f"CREATE INDEX IF NOT EXISTS {INDEX_NAME} ON slice_index (stem_type, estimated_bpm)"
)


def _default_db() -> str:
    try:
        from engine.live_index import live_index_path

        return live_index_path()
    except Exception:
        return r"C:\live_web_outputs\db\corpus_index_live.sqlite"


def _is_source_index(path: str) -> bool:
    try:
        from engine.live_index import is_source_index

        return bool(is_source_index(path))
    except Exception:
        return False


def _index_exists(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", (INDEX_NAME,)
    ).fetchone()
    return bool(row and int(row[0]) > 0)


def _sample_query_plan(conn: sqlite3.Connection) -> list[str]:
    from engine.song_plan import GenreVector
    from engine.stem_retriever import StemCandidateQuery, build_stem_sql

    query = StemCandidateQuery(
        instrument_family="drums",
        target_bpm=124,
        target_key="E",
        energy_tier=0.6,
        genre_vector=GenreVector(),
    )
    sql, params = build_stem_sql(query, fetch_limit=400)
    return [str(row[-1]) for row in conn.execute("EXPLAIN QUERY PLAN " + sql, params)]


def run_migration(db_path: str | None = None, *, allow_source_index: bool = False) -> dict:
    path = os.path.abspath(db_path or _default_db())
    if not os.path.isfile(path):
        raise FileNotFoundError(f"catalog not found: {path}")
    if _is_source_index(path) and not allow_source_index:
        raise PermissionError(
            f"{path} is the Learner source catalog; pass --allow-source-index to migrate it"
        )
    conn = sqlite3.connect(path, timeout=30)
    try:
        has_table = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='slice_index'"
        ).fetchone()
        if not has_table or int(has_table[0]) == 0:
            raise RuntimeError(f"{path} has no slice_index table")
        rows = int(conn.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0])
        existed = _index_exists(conn)
        print(f"[MIGRATE] {path} rows={rows} {INDEX_NAME}={'present' if existed else 'missing'}")
        t0 = time.perf_counter()
        if not existed:
            print(f"[MIGRATE] Creating index {INDEX_NAME} on slice_index...", flush=True)
        conn.execute(INDEX_DDL)
        conn.execute("ANALYZE slice_index")
        conn.commit()
        elapsed = time.perf_counter() - t0
        plan = _sample_query_plan(conn)
    finally:
        conn.close()
    uses_index = any(INDEX_NAME in step for step in plan)
    print(f"[MIGRATE] done in {elapsed:.2f}s; tempo-window query plan:")
    for step in plan:
        print(f"    {step}")
    print(
        "[MIGRATE] Migration complete. Stem queries indexed."
        if uses_index
        else f"[MIGRATE] Index present, but the planner did not choose {INDEX_NAME} for the sample query."
    )
    return {
        "db": path,
        "rows": rows,
        "created": not existed,
        "seconds": round(elapsed, 3),
        "plan": plan,
        "uses_index": uses_index,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--db", default=None, help="catalog path (default: live C: replica)")
    parser.add_argument(
        "--allow-source-index",
        action="store_true",
        help="permit migrating the Learner's D: source catalog",
    )
    args = parser.parse_args(argv)
    try:
        run_migration(args.db, allow_source_index=args.allow_source_index)
    except (FileNotFoundError, PermissionError, RuntimeError, sqlite3.Error) as exc:
        print(f"[MIGRATE] FAILED: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
