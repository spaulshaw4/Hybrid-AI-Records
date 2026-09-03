"""Read-only probes: archive magic bytes, dsd100 flat-dump overlap, sampled hashing."""

import hashlib
import os
import sqlite3
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
inv = sqlite3.connect(f"file:{os.path.join(HERE,'drive_inventory.sqlite')}?mode=ro", uri=True)

SUSPECT = [
    r"D:\MusicDatasets\fma\fma_large.zip",
    r"D:\MusicDatasets\aam\aam_multitracks.zip",
    r"D:\MusicDatasets\pod_stems\scratch\aam-stems\aam-1000-multitracks.zip",
    r"D:\MusicDatasets\pod_stems\scratch\spheres\multichannel.zip",
    r"D:\MusicDatasets\fma\fma_full.zip",
    r"D:\MusicDatasets\fma_full.zip",
    r"D:\MusicDatasets\pod_stems\scratch\ensembleset\ensembleset.zip",
    r"D:\MusicDatasets\fsd50k\FSD50K.eval_audio.zip",
    r"D:\MusicDatasets\fsd50k\FSD50K.dev_audio.zip",
    r"D:\MusicDatasets\spheres\multichannel.zip",
    r"D:\MusicDatasets\medley\medley_solos.tar.gz",
    r"D:\MusicDatasets\bass_db\bass_db.tar.gz",
    r"D:\MusicDatasets\pod_stems\scratch.tar",
    r"D:\MusicDatasets\Chill House Vocals.zip",
]

print("===== ARCHIVE HEAD/TAIL PROBE =====")
for p in SUSPECT:
    try:
        sz = os.path.getsize(p)
        with open(p, "rb") as fh:
            head = fh.read(16)
            tail = b""
            if sz > 32:
                fh.seek(-16, os.SEEK_END)
                tail = fh.read(16)
    except OSError as exc:
        print(f"  ERR {p}: {exc}")
        continue
    verdict = "?"
    if head[:2] == b"PK":
        verdict = "zip-ish head"
        if b"PK\x05\x06" not in tail and sz > 1e6:
            verdict += " but NO end-of-central-dir near tail -> TRUNCATED"
    elif head[:2] == b"\x1f\x8b":
        verdict = "gzip head"
    elif head[:5] in (b"<!DOC", b"<html"):
        verdict = "HTML (error page, not an archive)"
    elif head[257:262] == b"ustar":
        verdict = "tar"
    print(f"  {sz/1e9:8.3f} GB  head={head!r}\n            tail={tail!r}\n            -> {verdict}  {p}")

print("\n===== corpus_4s\\dsd100 flat dump vs song folders =====")
flat = {}
for path, name, size in inv.execute(
    "SELECT path,name,size FROM files WHERE path LIKE 'D:\\MusicDatasets\\corpus_4s\\dsd100\\%'"
):
    flat[(name.lower(), size)] = path
songs = defaultdict(list)
for path, name, size in inv.execute(
    "SELECT path,name,size FROM files WHERE path LIKE 'D:\\MusicDatasets\\corpus_4s\\0%' "
    "OR path LIKE 'D:\\MusicDatasets\\corpus_4s\\1%'"
):
    songs[(name.lower(), size)].append(path)
overlap = set(flat) & set(songs)
print(f"flat dsd100 files: {len(flat):,}")
print(f"song-folder files: {sum(len(v) for v in songs.values()):,} ({len(songs):,} distinct name+size)")
print(f"name+size collisions: {len(overlap):,}")
flat_bytes = sum(k[1] for k in flat)
print(f"flat dsd100 bytes: {flat_bytes/1e9:.3f} GB")
print("flat filename shapes:", Counter(os.path.basename(p).split("_s4_")[0] for p in list(flat.values())[:4000]).most_common(12))
print("flat sample paths:")
for p in list(flat.values())[:5]:
    print("   ", p)


def sha(path, limit=None):
    h = hashlib.sha1()
    with open(path, "rb") as fh:
        while True:
            b = fh.read(1 << 20)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


print("\n===== SAMPLED HASH CONFIRMATION (name+size collisions) =====")
sample = list(overlap)[:60]
same = diff = 0
for key in sample:
    a = flat[key]
    b = songs[key][0]
    try:
        if sha(a) == sha(b):
            same += 1
        else:
            diff += 1
    except OSError:
        pass
print(f"sampled {len(sample)} colliding pairs: identical={same} different={diff}")
if same + diff:
    print(f"=> name+size collision implies identical content {same/(same+diff)*100:.1f}% of the time here")

print("\n===== cross-tree duplicate hashing sample (uploaded_slices vs corpus_4s) =====")
pairs = inv.execute(
    """
    SELECT a.path, b.path, a.size FROM files a JOIN files b
      ON a.name=b.name AND a.size=b.size
    WHERE a.path LIKE 'D:\\MusicDatasets\\uploaded_slices\\%'
      AND b.path LIKE 'D:\\MusicDatasets\\corpus_4s\\%'
    LIMIT 40
    """
).fetchall()
print(f"uploaded_slices/corpus_4s name+size collisions sampled: {len(pairs)}")
s = d = 0
for a, b, _ in pairs:
    try:
        if sha(a) == sha(b):
            s += 1
        else:
            d += 1
    except OSError:
        pass
print(f"identical={s} different={d}")

print("\n===== archive vs completed_raw vs spliced_staging vs curated_vault =====")
for name in ("archive", "completed_raw", "spliced_staging", "curated_vault"):
    row = inv.execute(
        "SELECT COUNT(*), COALESCE(SUM(size),0) FROM files WHERE path LIKE ?",
        (f"D:\\MusicDatasets\\{name}\\%",),
    ).fetchone()
    print(f"  {name:18} files={row[0]:>7,}  {row[1]/1e9:8.3f} GB  {'(does not exist)' if row[0]==0 else ''}")
