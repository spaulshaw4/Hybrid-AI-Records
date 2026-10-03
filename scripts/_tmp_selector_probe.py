"""Read-only probe: detected_key coverage + vocal centroid distribution."""
from __future__ import annotations

import sqlite3

DB = r"C:\live_web_outputs\db\corpus_index_live.sqlite"
uri = f"file:{DB.replace(chr(92), '/')}?mode=ro"
conn = sqlite3.connect(uri, uri=True, timeout=10)

print("total:", conn.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0])
print("\n-- detected_key distribution --")
for row in conn.execute(
    "SELECT COALESCE(detected_key,'<null>'), COUNT(*) FROM slice_index "
    "GROUP BY 1 ORDER BY 2 DESC LIMIT 20"
):
    print(f"  {row[0]:<8} {row[1]}")

print("\n-- detected_key by stem_type (top 4 keys each) --")
for stem in ("rhythm", "harmonic", "vocal"):
    rows = conn.execute(
        "SELECT COALESCE(detected_key,'<null>'), COUNT(*) FROM slice_index "
        "WHERE stem_type=? GROUP BY 1 ORDER BY 2 DESC LIMIT 5",
        (stem,),
    ).fetchall()
    tot = conn.execute(
        "SELECT COUNT(*) FROM slice_index WHERE stem_type=?", (stem,)
    ).fetchone()[0]
    print(f"  {stem} total={tot}: {rows}")

print("\n-- vocal spectral_centroid bands --")
bands = [(0, 1), (1, 300), (300, 1000), (1000, 2000), (2000, 4000),
         (4000, 5000), (5000, 6000), (6000, 8000), (8000, 20000)]
for lo, hi in bands:
    n = conn.execute(
        "SELECT COUNT(*) FROM slice_index WHERE stem_type='vocal' "
        "AND spectral_centroid >= ? AND spectral_centroid < ?",
        (lo, hi),
    ).fetchone()[0]
    print(f"  [{lo:>6}, {hi:>6}) {n}")

print("\n-- vocal pool after existing folder exclusions, by band --")
excl = ("harmonic", "rhythm", "drums", "bass")
where = " AND ".join(
    ["lower(replace(file_path,'/','\\')) NOT LIKE ?" for _ in excl]
)
for lo, hi in bands:
    n = conn.execute(
        "SELECT COUNT(*) FROM slice_index WHERE stem_type='vocal' "
        "AND filename NOT LIKE 'mixture%' AND rms_db > -55 "
        f"AND {where} AND spectral_centroid >= ? AND spectral_centroid < ?",
        tuple(f"%\\{f}\\%" for f in excl) + (lo, hi),
    ).fetchone()[0]
    print(f"  [{lo:>6}, {hi:>6}) {n}")

print("\n-- onset/chroma coverage table presence --")
for t in conn.execute(
    "SELECT name FROM sqlite_master WHERE type='table'"
):
    print("  ", t[0])
conn.close()
