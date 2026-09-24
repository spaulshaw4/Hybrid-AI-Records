"""Cheap read-only coverage re-check against slice_index.

Pure aggregate SQL, one pass, no row materialisation. Safe to run while the
slicer is writing: opens mode=ro with a 30s busy timeout and never writes.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys

DEFAULT_DB = r"D:\MusicDatasets\db\corpus_index.sqlite"

# Mirrors engine-side mapping: infer_stem_type() folds "bass" into "harmonic",
# so the bass bus is recovered from the path/tags instead of stem_type.
BUS_SQL = """
CASE
  WHEN lower(stem_type) = 'rhythm' THEN 'drums'
  WHEN lower(stem_type) IN ('lead','vocal') THEN 'lead_vocal'
  WHEN lower(file_path) LIKE '%bass%' OR lower(tags) LIKE '%bass%' THEN 'bass'
  ELSE 'harmonic'
END
"""
BPM_BIN_SQL = (
    "CASE WHEN estimated_bpm >= 60 AND estimated_bpm < 180"
    " THEN CAST((estimated_bpm - 60) / 8 AS INTEGER) ELSE -1 END"
)
ENERGY_SQL = (
    "CASE WHEN rms_db <= -60 THEN 'silent'"
    " WHEN rms_db < -30 THEN 'low' WHEN rms_db < -18 THEN 'mid' ELSE 'high' END"
)


def q(conn: sqlite3.Connection, sql: str) -> list[tuple]:
    return conn.execute(sql).fetchall()


def show(title: str, rows: list[tuple], fmt: str = "{:<28}{:>10}") -> None:
    print("\n== {} ==".format(title))
    for row in rows:
        label = " ".join("" if c is None else str(c) for c in row[:-1])
        print(fmt.format(label[:28], row[-1]))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=os.environ.get("CORPUS_INDEX_DB") or DEFAULT_DB)
    args = ap.parse_args(argv)
    if not os.path.isfile(args.db):
        print("[FATAL] no such db: {}".format(args.db), file=sys.stderr)
        return 2

    conn = sqlite3.connect("file:{}?mode=ro".format(args.db.replace("\\", "/")), uri=True)
    conn.execute("PRAGMA busy_timeout=30000")
    try:
        total = q(conn, "SELECT COUNT(*) FROM slice_index")[0][0]
        print("db            : {}".format(args.db))
        print("total rows    : {}".format(total))

        show("bus (bass recovered from path)",
             q(conn, "SELECT {b} AS bus, COUNT(*) c FROM slice_index"
                     " GROUP BY bus ORDER BY c DESC".format(b=BUS_SQL)))

        show("raw stem_type",
             q(conn, "SELECT stem_type, COUNT(*) c FROM slice_index"
                     " GROUP BY stem_type ORDER BY c DESC"))

        show("energy tier (rms_db)",
             q(conn, "SELECT {e} AS tier, COUNT(*) c FROM slice_index"
                     " GROUP BY tier ORDER BY c DESC".format(e=ENERGY_SQL)))

        show("detected_key (pitch class)",
             q(conn, "SELECT detected_key, COUNT(*) c FROM slice_index"
                     " GROUP BY detected_key ORDER BY c DESC"))

        show("bpm bin (-1 = outside 60-180)",
             q(conn, "SELECT {p} AS bin, COUNT(*) c FROM slice_index"
                     " GROUP BY bin ORDER BY bin".format(p=BPM_BIN_SQL)))

        show("top 12 exact bpm values",
             q(conn, "SELECT estimated_bpm, COUNT(*) c FROM slice_index"
                     " GROUP BY estimated_bpm ORDER BY c DESC LIMIT 12"))

        distinct_bpm = q(conn, "SELECT COUNT(DISTINCT estimated_bpm) FROM slice_index")[0][0]
        print("\ndistinct bpm values : {}".format(distinct_bpm))

        # Occupancy of the declared grid. 12 pitch classes only: detected_key
        # carries no major/minor mode, so 24-key cells cannot be filled.
        occ = q(conn,
                "SELECT COUNT(*), SUM(c >= 5), SUM(c > 0) FROM ("
                " SELECT COUNT(*) c FROM slice_index"
                " WHERE {p} >= 0 AND rms_db > -60 AND detected_key IS NOT NULL"
                " GROUP BY {p}, detected_key, {b}, {e})".format(
                    p=BPM_BIN_SQL, b=BUS_SQL, e=ENERGY_SQL))[0]
        cells, ge5, occupied = occ[0] or 0, occ[1] or 0, occ[2] or 0
        print("\n== grid occupancy (non-silent, in-range rows) ==")
        print("reachable cells (15 bpm x 12 key x 4 bus x 3 energy) : 2160")
        print("declared cells  (15 x 24 x 4 x 3)                    : 4320")
        print("cells occupied                                       : {}".format(occupied))
        print("cells with >= 5 slices                               : {}".format(ge5))
        print("cells empty vs reachable 2160                        : {}".format(2160 - occupied))
        print("cells empty vs declared 4320                         : {}".format(4320 - occupied))

        show("source tree (top 12)",
             q(conn, "SELECT CASE"
                     " WHEN lower(file_path) LIKE '%\\dsd100\\%' ESCAPE '\\' THEN 'dsd100'"
                     " WHEN lower(file_path) LIKE '%\\mtg\\%' ESCAPE '\\' THEN 'mtg'"
                     " WHEN lower(file_path) LIKE '%\\slakh\\%' ESCAPE '\\' THEN 'slakh'"
                     " WHEN lower(file_path) LIKE '%\\medley\\%' ESCAPE '\\' THEN 'medley'"
                     " WHEN lower(file_path) LIKE '%\\fma\\%' ESCAPE '\\' THEN 'fma'"
                     " ELSE 'musdb18_or_packs' END AS src, COUNT(*) c"
                     " FROM slice_index GROUP BY src ORDER BY c DESC LIMIT 12"))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
