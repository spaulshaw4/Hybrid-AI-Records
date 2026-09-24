"""Light read-only status probe: manifest grouping + cheap live-DB row estimates.

Avoids full table scans on the live corpus index (the ingester is writing to it
and the disk is saturated) by using max(rowid) instead of COUNT(*).
"""

import collections
import sqlite3
import sys

MANIFEST = r"C:\Users\spaul\Downloads\Hybrid AI Forge (10)\reports\dataset_manifest.sqlite"
LIVE = r"D:\MusicDatasets\db\corpus_index.sqlite"

print("===== Sept-8 dataset_manifest by source tree =====")
c = sqlite3.connect(f"file:{MANIFEST}?mode=ro", uri=True)
top = collections.Counter()
sub = collections.Counter()
for (p,) in c.execute("SELECT slice_path FROM manifest"):
    parts = p.replace("/", "\\").lower().split("\\")
    top["\\".join(parts[1:3])] += 1
    if len(parts) > 3:
        sub["\\".join(parts[1:4])] += 1
print(f"total rows: {sum(top.values()):,}")
for k, v in top.most_common(20):
    print(f"{v:10,}  {k}")
print("-- one level deeper --")
for k, v in sub.most_common(12):
    print(f"{v:10,}  {k}")

print("\n===== live corpus_index.sqlite (cheap probes) =====")
try:
    l = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True, timeout=20)
    l.execute("PRAGMA busy_timeout=20000")
    for t in ("slice_index", "slice_history", "pack_manifest"):
        try:
            mx = l.execute(f"SELECT max(rowid) FROM [{t}]").fetchone()[0]
            print(f"  {t}: max(rowid)={mx}")
        except Exception as exc:
            print(f"  {t}: {exc}")
    try:
        print("  pack_manifest status:",
              l.execute("SELECT status, COUNT(*) FROM pack_manifest GROUP BY status").fetchall())
    except Exception as exc:
        print("  pack_manifest status err:", exc)
    try:
        rows = l.execute(
            "SELECT * FROM slice_index ORDER BY rowid DESC LIMIT 3"
        ).fetchall()
        for r in rows:
            print("  newest:", r[1] if len(r) > 1 else r)
    except Exception as exc:
        print("  newest err:", exc)
except Exception as exc:
    print("  could not open live db:", exc)
