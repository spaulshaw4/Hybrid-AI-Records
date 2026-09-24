"""Read-only status probe of the live slice_index. No corpus walk, no writes.

Safe to run while the ingest is active: opens the DB read-only with a busy
timeout and only issues aggregate SELECTs.
"""
from __future__ import annotations

import os
import sqlite3

DB = os.environ.get("CORPUS_INDEX_DB", r"D:\MusicDatasets\db\corpus_index.sqlite")


def main() -> int:
    if not os.path.isfile(DB):
        print(f"MISSING {DB}")
        return 1
    uri = f"file:{DB.replace(os.sep, '/')}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=30)
    conn.execute("PRAGMA busy_timeout=30000")
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(slice_index)")]
        print(f"columns: {cols}")
        print(f"rows: {conn.execute('SELECT COUNT(*) FROM slice_index').fetchone()[0]}")
        print("by stem_type:",
              conn.execute("SELECT stem_type, COUNT(*) FROM slice_index "
                           "GROUP BY 1 ORDER BY 2 DESC").fetchall())
        if "stem_type_ml" in cols:
            print("by stem_type_ml:",
                  conn.execute("SELECT stem_type_ml, COUNT(*) FROM slice_index "
                               "GROUP BY 1 ORDER BY 2 DESC").fetchall())
            labelled = conn.execute(
                "SELECT COUNT(*) FROM slice_index WHERE stem_type_ml IS NOT NULL"
            ).fetchone()[0]
            print(f"rows with stem_type_ml: {labelled}")
        print("distinct key values:",
              conn.execute("SELECT COUNT(DISTINCT detected_key) FROM slice_index").fetchone()[0])
        print("bpm==120.0 rows (estimator fallback):",
              conn.execute("SELECT COUNT(*) FROM slice_index "
                           "WHERE estimated_bpm = 120.0").fetchone()[0])
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
