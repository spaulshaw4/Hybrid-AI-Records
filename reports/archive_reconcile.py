"""Read-only archive/extracted reconciliation.

Opens each .zip for its central directory only (no extraction, no writes) and
checks whether the member files already exist somewhere on the drive, matched by
basename + uncompressed size against the inventory. Tar archives cannot be
listed without streaming the whole file, so they are classified by name only.
"""

import json
import os
import sqlite3
import sys
import time
import zipfile
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
inv = sqlite3.connect(f"file:{os.path.join(HERE,'drive_inventory.sqlite')}?mode=ro", uri=True)

by_name_size = defaultdict(list)
for path, name, size in inv.execute("SELECT path, name, size FROM files"):
    by_name_size[(name.lower(), size)].append(path)

archives = inv.execute(
    "SELECT path, size FROM files WHERE ext IN ('.zip','.7z','.rar','.tar','.gz','.tgz') ORDER BY size DESC"
).fetchall()

SAMPLE = 400
results = []
for apath, asize in archives:
    rec = {"archive": apath, "zip_bytes": asize}
    ext = os.path.splitext(apath)[1].lower()
    if ext != ".zip":
        rec.update(status="UNKNOWN_TAR", reason="tar/gz requires full stream to list")
        results.append(rec)
        continue
    t0 = time.time()
    try:
        with zipfile.ZipFile(apath) as zf:
            infos = [i for i in zf.infolist() if not i.is_dir()]
    except Exception as exc:  # corrupt / unreadable
        rec.update(status="UNREADABLE", reason=str(exc)[:200])
        results.append(rec)
        continue
    rec["members"] = len(infos)
    rec["uncompressed_bytes"] = sum(i.file_size for i in infos)
    rec["list_secs"] = round(time.time() - t0, 2)
    if not infos:
        rec.update(status="EMPTY")
        results.append(rec)
        continue
    step = max(1, len(infos) // SAMPLE)
    sample = infos[::step][:SAMPLE]
    found = 0
    where = defaultdict(int)
    for i in sample:
        base = os.path.basename(i.filename).lower()
        hits = by_name_size.get((base, i.file_size))
        if hits:
            found += 1
            for h in hits:
                if h.lower() != apath.lower():
                    where[os.path.dirname(h)] += 1
    frac = found / len(sample)
    rec["sampled"] = len(sample)
    rec["sample_found"] = found
    rec["found_fraction"] = round(frac, 3)
    rec["top_locations"] = sorted(where.items(), key=lambda x: -x[1])[:3]
    if frac >= 0.95:
        rec["status"] = "EXTRACTED"
    elif frac >= 0.05:
        rec["status"] = "PARTIAL"
    else:
        rec["status"] = "NOT_EXTRACTED"
    results.append(rec)
    print(f"{rec['status']:14} {frac if 'found_fraction' in rec else '':>6} {asize/1e9:8.3f}GB {apath}", flush=True)

out = os.path.join(HERE, "archive_reconciliation.json")
if os.path.exists(out):
    print("refusing to overwrite", out)
else:
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=1)

print("\n===== SUMMARY =====")
agg = defaultdict(lambda: [0, 0])
for r in results:
    a = agg[r["status"]]
    a[0] += 1
    a[1] += r["zip_bytes"]
for k, (c, b) in sorted(agg.items(), key=lambda x: -x[1][1]):
    print(f"{k:15} {c:4} archives  {b/1e9:10.2f} GB")
