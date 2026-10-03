"""Read-only: how many distinct source tracks the 200 stem_type_ml rows cover.

Matters because held-out accuracy measured over one or two songs is a far
weaker claim than the same number measured across many.
"""
from __future__ import annotations

import ntpath
import sqlite3
from collections import Counter

INDEX = r"C:\live_web_outputs\db\corpus_index_live.sqlite"


def main() -> int:
    conn = sqlite3.connect(
        "file:C:/live_web_outputs/db/corpus_index_live.sqlite?mode=ro", uri=True, timeout=30
    )
    conn.execute("PRAGMA query_only=ON")
    try:
        rows = conn.execute(
            "SELECT file_path, stem_type_ml FROM slice_index WHERE stem_type_ml IS NOT NULL"
        ).fetchall()
        ids = conn.execute(
            "SELECT MIN(id), MAX(id) FROM slice_index WHERE stem_type_ml IS NOT NULL"
        ).fetchone()
    finally:
        conn.close()

    tracks = Counter(ntpath.basename(ntpath.dirname(str(p))) for p, _ in rows)
    print(f"labelled rows: {len(rows)}  id range: {ids}")
    print(f"distinct source tracks: {len(tracks)}")
    for name, count in tracks.most_common():
        print(f"  {count:>4}  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
