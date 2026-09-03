"""Read-only census of corpus_index.sqlite (BPM / key / stem_type).

Connects URI mode=ro with PRAGMA busy_timeout=30000. Never writes to the DB.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys

DEFAULT_DB = r"D:\MusicDatasets\db\corpus_index.sqlite"
CENSUS_TABLES = ("slice_index", "pack_manifest", "slice_history")
BPM_BIN_EDGES = tuple(range(60, 181, 10))  # 60,70,...,180


def connect_ro(db_path: str) -> sqlite3.Connection:
    uri = "file:{}?mode=ro".format(db_path.replace("\\", "/"))
    conn = sqlite3.connect(uri, uri=True)
    conn.execute("PRAGMA busy_timeout=30000")
    conn.row_factory = sqlite3.Row
    return conn


def _safe_ident(name: str) -> str:
    if not name.replace("_", "").isalnum():
        raise ValueError(f"unsafe identifier: {name}")
    return name


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone()
    return row is not None


def column_names(conn: sqlite3.Connection, table: str) -> set[str]:
    ident = _safe_ident(table)
    return {r[1] for r in conn.execute(f"PRAGMA table_info({ident})")}


def fmt(n: object) -> str:
    if n is None:
        return "NULL"
    if isinstance(n, float):
        return f"{n:.4f}"
    if isinstance(n, int):
        return f"{n:,}"
    return str(n)


def print_counts(conn: sqlite3.Connection) -> None:
    print("=== TABLE COUNTS ===")
    for table in CENSUS_TABLES:
        if not table_exists(conn, table):
            print(f"  {table}: TABLE MISSING")
            continue
        n = conn.execute(f"SELECT COUNT(*) FROM {_safe_ident(table)}").fetchone()[0]
        print(f"  {table}: {n:,}")
    print()


def print_stem_types(conn: sqlite3.Connection) -> None:
    print("=== STEM_TYPE DISTRIBUTION ===")
    if not table_exists(conn, "slice_index") or "stem_type" not in column_names(
        conn, "slice_index"
    ):
        print("  stem_type column missing")
        print()
        return
    rows = conn.execute(
        """
        SELECT
            CASE
                WHEN stem_type IS NULL THEN '<NULL>'
                WHEN TRIM(stem_type) = '' THEN '<EMPTY>'
                ELSE stem_type
            END AS stem,
            COUNT(*) AS n
        FROM slice_index
        GROUP BY stem
        ORDER BY n DESC, stem
        """
    ).fetchall()
    total = sum(int(r["n"]) for r in rows) or 1
    for r in rows:
        pct = 100.0 * int(r["n"]) / total
        print(f"  {r['stem']:<20} {int(r['n']):>10,}  ({pct:5.1f}%)")
    print(f"  {'TOTAL':<20} {total:>10,}")
    print()


def _bpm_histogram(conn: sqlite3.Connection) -> list[tuple[str, int]]:
    """10-BPM bins [60,70) ... [170,180] inclusive of 180, plus other."""
    cases: list[str] = []
    for lo, hi in zip(BPM_BIN_EDGES[:-1], BPM_BIN_EDGES[1:]):
        if hi < 180:
            label = f"{lo}-{hi - 1}"
            cases.append(
                f"WHEN estimated_bpm >= {lo} AND estimated_bpm < {hi} THEN '{label}'"
            )
        else:
            label = f"{lo}-{hi}"
            cases.append(
                f"WHEN estimated_bpm >= {lo} AND estimated_bpm <= {hi} THEN '{label}'"
            )
    case_sql = " ".join(cases)
    rows = conn.execute(
        f"""
        SELECT
            CASE
                {case_sql}
                ELSE 'other'
            END AS bin,
            COUNT(*) AS n
        FROM slice_index
        WHERE estimated_bpm IS NOT NULL AND estimated_bpm != 0
        GROUP BY bin
        """
    ).fetchall()
    counts = {str(r["bin"]): int(r["n"]) for r in rows}
    ordered: list[tuple[str, int]] = []
    for lo, hi in zip(BPM_BIN_EDGES[:-1], BPM_BIN_EDGES[1:]):
        label = f"{lo}-{hi - 1}" if hi < 180 else f"{lo}-{hi}"
        ordered.append((label, counts.get(label, 0)))
    ordered.append(("other", counts.get("other", 0)))
    return ordered


def print_bpm(conn: sqlite3.Connection) -> None:
    print("=== ESTIMATED_BPM ===")
    if not table_exists(conn, "slice_index") or "estimated_bpm" not in column_names(
        conn, "slice_index"
    ):
        print("  estimated_bpm column missing")
        print()
        return

    stats = conn.execute(
        """
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN estimated_bpm IS NULL THEN 1 ELSE 0 END) AS n_null,
            SUM(CASE WHEN estimated_bpm = 0 THEN 1 ELSE 0 END) AS n_zero,
            MIN(CASE WHEN estimated_bpm IS NOT NULL AND estimated_bpm != 0
                     THEN estimated_bpm END) AS bpm_min,
            MAX(CASE WHEN estimated_bpm IS NOT NULL AND estimated_bpm != 0
                     THEN estimated_bpm END) AS bpm_max,
            AVG(CASE WHEN estimated_bpm IS NOT NULL AND estimated_bpm != 0
                     THEN estimated_bpm END) AS bpm_avg
        FROM slice_index
        """
    ).fetchone()

    total = int(stats["total"] or 0)
    n_null = int(stats["n_null"] or 0)
    n_zero = int(stats["n_zero"] or 0)
    usable = total - n_null - n_zero
    print(f"  total rows:     {total:,}")
    print(f"  NULL:           {n_null:,}")
    print(f"  zero:           {n_zero:,}")
    print(f"  usable (non-null, non-zero): {usable:,}")
    print(f"  min:            {fmt(stats['bpm_min'])}")
    print(f"  max:            {fmt(stats['bpm_max'])}")
    print(f"  avg:            {fmt(stats['bpm_avg'])}")
    print()
    print("  histogram (10-BPM bins, 60-180; NULL/0 counted separately):")

    bin_counts = _bpm_histogram(conn)
    max_n = max((n for _, n in bin_counts), default=0) or 1
    for label, n in bin_counts:
        bar = "#" * int(40 * n / max_n) if n else ""
        print(f"    {label:<12} {n:>10,}  {bar}")
    print()

    if usable == 0 or (n_null + n_zero) / max(total, 1) > 0.5:
        print("  NOTE: BPM is mostly NULL/0. Tempo axis is not usable yet.")
        print("        Do not claim enough variety for any tempo.")
        print()
    else:
        other_n = next((n for label, n in bin_counts if label == "other"), 0)
        if other_n / max(usable, 1) > 0.2:
            print(
                f"  NOTE: 'other' is {other_n:,} / {usable:,} usable rows "
                f"({100.0 * other_n / usable:.1f}%)."
            )
            print("        Do not claim enough variety for any tempo.")
            print()


def print_keys(conn: sqlite3.Connection) -> None:
    print("=== DETECTED_KEY ===")
    if not table_exists(conn, "slice_index") or "detected_key" not in column_names(
        conn, "slice_index"
    ):
        print("  detected_key column missing")
        print()
        return

    stats = conn.execute(
        """
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN detected_key IS NULL THEN 1 ELSE 0 END) AS n_null,
            SUM(CASE WHEN detected_key IS NOT NULL AND TRIM(detected_key) = ''
                     THEN 1 ELSE 0 END) AS n_empty
        FROM slice_index
        """
    ).fetchone()
    total = int(stats["total"] or 0)
    n_null = int(stats["n_null"] or 0)
    n_empty = int(stats["n_empty"] or 0)
    print(f"  total rows:     {total:,}")
    print(f"  NULL:           {n_null:,}")
    print(f"  empty:          {n_empty:,}")
    print()
    print("  value counts:")
    rows = conn.execute(
        """
        SELECT
            CASE
                WHEN detected_key IS NULL THEN '<NULL>'
                WHEN TRIM(detected_key) = '' THEN '<EMPTY>'
                ELSE detected_key
            END AS k,
            COUNT(*) AS n
        FROM slice_index
        GROUP BY k
        ORDER BY n DESC, k
        """
    ).fetchall()
    for r in rows:
        pct = 100.0 * int(r["n"]) / max(total, 1)
        print(f"    {r['k']:<20} {int(r['n']):>10,}  ({pct:5.1f}%)")
    print()

    populated = total - n_null - n_empty
    distinct_real = int(
        conn.execute(
            """
            SELECT COUNT(DISTINCT detected_key) FROM slice_index
            WHERE detected_key IS NOT NULL AND TRIM(detected_key) != ''
            """
        ).fetchone()[0]
        or 0
    )
    n_mode = int(
        conn.execute(
            """
            SELECT COUNT(*) FROM slice_index
            WHERE detected_key LIKE '%maj%'
               OR detected_key LIKE '%min%'
               OR detected_key LIKE '%m'
            """
        ).fetchone()[0]
        or 0
    )
    if populated == 0 or (n_null + n_empty) / max(total, 1) > 0.5:
        print("  NOTE: detected_key is mostly NULL/empty.")
        print("        The 24-key axis is not usable yet.")
        print()
    elif n_mode == 0 or distinct_real < 24:
        print(
            f"  NOTE: {distinct_real} distinct keys, {n_mode:,} rows with "
            "major/minor mode."
        )
        print("        The 24-key axis is not usable yet.")
        print()


def print_rms(conn: sqlite3.Connection) -> None:
    print("=== RMS_DB ===")
    if not table_exists(conn, "slice_index") or "rms_db" not in column_names(
        conn, "slice_index"
    ):
        print("  rms_db column missing")
        print()
        return
    stats = conn.execute(
        """
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN rms_db IS NULL THEN 1 ELSE 0 END) AS n_null,
            MIN(rms_db) AS rms_min,
            MAX(rms_db) AS rms_max,
            AVG(rms_db) AS rms_avg
        FROM slice_index
        """
    ).fetchone()
    print(f"  total rows:     {fmt(int(stats['total'] or 0))}")
    print(f"  NULL:           {fmt(int(stats['n_null'] or 0))}")
    print(f"  min:            {fmt(stats['rms_min'])}")
    print(f"  max:            {fmt(stats['rms_max'])}")
    print(f"  avg:            {fmt(stats['rms_avg'])}")
    print()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=DEFAULT_DB, help="Path to corpus_index.sqlite")
    args = parser.parse_args(argv)

    db_path = args.db
    if not os.path.isfile(db_path):
        print(f"ERROR: DB not found: {db_path}", file=sys.stderr)
        return 1

    print(f"DB: {db_path}")
    print("mode: read-only URI (file:...?mode=ro), busy_timeout=30000")
    print()

    conn = connect_ro(db_path)
    try:
        print_counts(conn)
        print_stem_types(conn)
        print_bpm(conn)
        print_keys(conn)
        print_rms(conn)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
