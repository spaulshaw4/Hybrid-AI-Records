"""Read-only join of the corpus index databases against the filesystem inventory."""

import os
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
INV = os.path.join(HERE, "drive_inventory.sqlite")
REAL = "D:\\MusicDatasets\\db\\corpus_index.sqlite"
LEGACY = "D:\\MusicDatasets\\database\\corpus_index.sqlite"


def schema(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    print(f"\n########## {path}")
    for (name, sql) in con.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='table'"
    ):
        cnt = con.execute(f"SELECT COUNT(*) FROM [{name}]").fetchone()[0]
        print(f"\n-- {name}  rows={cnt:,}\n{sql}")
    return con


real = schema(REAL)
schema(LEGACY)

inv = sqlite3.connect(f"file:{INV}?mode=ro", uri=True)

print("\n\n########## slice_index breakdown")
for row in real.execute(
    "SELECT stem_type, COUNT(*) FROM slice_index GROUP BY stem_type ORDER BY 2 DESC"
):
    print(row)

paths = [r[0] for r in real.execute("SELECT file_path FROM slice_index")]
print(f"\nslice_index rows: {len(paths):,}")
print("sample paths:")
for p in paths[:5]:
    print("   ", p)

# dangling check
have = {r[0].lower() for r in inv.execute("SELECT path FROM files")}
missing = [p for p in paths if p.lower() not in have]
print(f"\ndangling slice_index.file_path (file not on disk): {len(missing):,}")
for p in missing[:15]:
    print("   MISSING", p)

# how many corpus_4s wavs indexed
corpus_wavs = {
    r[0].lower()
    for r in inv.execute(
        "SELECT path FROM files WHERE ext='.wav' AND path LIKE 'D:\\MusicDatasets\\corpus_4s\\%'"
    )
}
indexed = {p.lower() for p in paths}
print(f"\ncorpus_4s wavs on disk: {len(corpus_wavs):,}")
print(f"indexed rows pointing into corpus_4s: {len(indexed & corpus_wavs):,}")
print(f"corpus_4s wavs NOT indexed: {len(corpus_wavs - indexed):,}")
print(f"index rows pointing OUTSIDE corpus_4s: {len(indexed - corpus_wavs):,}")
for p in list(indexed - corpus_wavs)[:10]:
    print("   OUTSIDE", p)


def sub_of(p):
    rest = p[len("d:\\musicdatasets\\corpus_4s\\"):]
    return rest.split("\\")[0] if "\\" in rest else "<root>"


from collections import Counter

on_disk = Counter(sub_of(p) for p in corpus_wavs)
idx = Counter(sub_of(p) for p in (indexed & corpus_wavs))
print(f"\n########## corpus_4s subdirs: indexed / on-disk  ({len(on_disk)} subdirs)")
zero = []
for sub, n in on_disk.most_common():
    k = idx.get(sub, 0)
    if k == 0:
        zero.append((sub, n))
    else:
        print(f"  {k:6,} / {n:6,}  {sub}")
print(f"\nsubdirs with ZERO indexed rows: {len(zero)} covering {sum(n for _, n in zero):,} wavs")
for sub, n in zero[:200]:
    print(f"       0 / {n:6,}  {sub}")

print("\n########## slice_history")
hist = [r[0] for r in real.execute("SELECT file_path FROM slice_history")]
hset = {p.lower() for p in hist}
print(f"rows: {len(hist):,}")
print(f"history entries that are also in slice_index: {len(hset & indexed):,}")
print(f"history entries NOT in slice_index: {len(hset - indexed):,}")
print(f"indexed but NEVER used in a render: {len(indexed - hset):,}")
print(f"history entries whose file is missing on disk: {len([p for p in hset if p not in have]):,}")
hsub = Counter(sub_of(p) for p in hset if p.startswith("d:\\musicdatasets\\corpus_4s\\"))
print("history by corpus_4s subdir (top 20):", hsub.most_common(20))
print("history sample:")
for p in hist[:5]:
    print("   ", p)
print("history roots:", Counter(p.lower()[:40] for p in hist).most_common(10))
for r in real.execute("SELECT * FROM slice_history ORDER BY use_count DESC LIMIT 5"):
    print("   top-used:", r)

print("\n########## pack_manifest")
for r in real.execute("SELECT * FROM pack_manifest"):
    print("  ", r)
