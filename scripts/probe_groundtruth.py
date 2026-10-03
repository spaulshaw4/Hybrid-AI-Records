"""Read-only: validate the BPM/key estimators against ground truth encoded in
sample-pack filenames, and measure bass-pool contamination by drum one-shots.
"""
from __future__ import annotations

import collections
import re
import sqlite3

BPM_RE = re.compile(r"(\d{2,3})\s*bpm")
KEY_RE = re.compile(r"key([a-g])(#|b)?(min|maj|m|M)?(?![a-z])")
NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
IDX = {n: i for i, n in enumerate(NOTE)}
FLAT = {"ab": "G#", "bb": "A#", "db": "C#", "eb": "D#", "gb": "F#"}

# Percussion tokens used by the 808 one-shot packs.
DRUM_TOKENS = ("_bd", "_sd", "_hh", "_ohh", "_tom", "_cymbal", "_rim", "_clave",
               "_cp", "_cb", "_mar", "_kick", "_snare", "_hat", "_clap", "_crash",
               "_ride", "_perc", "_shaker", "_tamb")

conn = sqlite3.connect(
    "file:C:/live_web_outputs/db/corpus_index_live.sqlite?mode=ro", uri=True)
conn.execute("PRAGMA busy_timeout=30000")
conn.execute("ATTACH DATABASE ? AS prof",
             ("file:C:/live_web_outputs/db/hybrid_acoustic_profiles.db?mode=ro",))

bpm_pairs = []
key_pairs = []
key_pairs_chroma = []
conf_of_key = []
rows = conn.execute("""
 SELECT si.filename, si.estimated_bpm, si.detected_key,
        m.chroma_root, m.chroma_is_minor, m.chroma_confidence
 FROM slice_index si LEFT JOIN prof.slice_musical m ON m.file_path = si.file_path
 WHERE si.filename LIKE '%bpm%' OR si.filename LIKE '%key%'
""")
for fn, bpm, dkey, root, minor, conf in rows:
    name = (fn or "").lower()
    mb = BPM_RE.search(name)
    if mb and bpm is not None:
        truth = int(mb.group(1))
        if 40 <= truth <= 220:
            bpm_pairs.append((truth, float(bpm)))
    mk = KEY_RE.search(name)
    if mk:
        letter = mk.group(1).upper()
        acc = mk.group(2) or ""
        note = FLAT.get((letter + acc).lower(), letter + ("#" if acc == "#" else ""))
        if note in IDX:
            ti = IDX[note]
            is_min = 1 if (mk.group(3) or "").lower().startswith("m") and \
                (mk.group(3) or "").lower() != "maj" else 0
            if dkey and dkey.strip().upper() in IDX:
                key_pairs.append((ti, IDX[dkey.strip().upper()]))
            if root is not None:
                key_pairs_chroma.append((ti, int(root) % 12, is_min, int(minor or 0)))
                conf_of_key.append((conf or 0.0, ti == int(root) % 12))

print("=== BPM estimator vs filename ground truth ===")
print("  pairs with a parsable BPM in the name : {}".format(len(bpm_pairs)))
if bpm_pairs:
    def close(t, e, tol):
        if abs(e - t) <= tol * t:
            return True
        for mult in (0.5, 2.0, 1 / 3.0, 3.0, 0.75, 1.5):
            if abs(e - t * mult) <= tol * t * mult:
                return True
        return False
    exact = sum(1 for t, e in bpm_pairs if abs(e - t) <= 0.03 * t)
    octv = sum(1 for t, e in bpm_pairs if close(t, e, 0.03))
    within6 = sum(1 for t, e in bpm_pairs if abs(e - t) <= 0.06 * t)
    errs = sorted(abs(e - t) / t for t, e in bpm_pairs)
    print("  within +/-3%% of truth              : {} ({}%)".format(
        exact, round(100 * exact / len(bpm_pairs), 1)))
    print("  within +/-6%% of truth              : {} ({}%)".format(
        within6, round(100 * within6 / len(bpm_pairs), 1)))
    print("  within +/-3%% allowing octave/triplet: {} ({}%)".format(
        octv, round(100 * octv / len(bpm_pairs), 1)))
    print("  median relative error              : {}%".format(
        round(100 * errs[len(errs) // 2], 1)))
    print("  sample (truth -> estimated): {}".format(
        ", ".join("{}->{}".format(t, e) for t, e in bpm_pairs[:12])))

print("\n=== key: filename ground truth vs detected_key (pitch class) ===")
if key_pairs:
    ok = sum(1 for t, d in key_pairs if t == d)
    print("  pairs={}  agree={} ({}%)".format(
        len(key_pairs), ok, round(100 * ok / len(key_pairs), 1)))
else:
    print("  no parsable key pairs")

print("\n=== key: filename ground truth vs chroma_root ===")
if key_pairs_chroma:
    ok = sum(1 for t, r, _tm, _cm in key_pairs_chroma if t == r)
    okmode = sum(1 for t, r, tm, cm in key_pairs_chroma if t == r and tm == cm)
    print("  pairs={}  root agree={} ({}%)  root+mode agree={} ({}%)".format(
        len(key_pairs_chroma), ok, round(100 * ok / len(key_pairs_chroma), 1),
        okmode, round(100 * okmode / len(key_pairs_chroma), 1)))
    hi = [(c, a) for c, a in conf_of_key if c >= 0.30]
    if hi:
        print("  restricted to chroma_confidence>=0.30: n={} root agree={}%".format(
            len(hi), round(100 * sum(1 for _c, a in hi if a) / len(hi), 1)))

print("\n=== bass-pool contamination (stem_type='harmonic' rows matching bass tokens) ===")
tot = conn.execute(
    "SELECT COUNT(*) FROM slice_index WHERE stem_type='harmonic'"
    " AND filename NOT LIKE 'mixture%'"
    " AND (lower(filename) LIKE '%bass%' OR lower(filename) LIKE '%808%'"
    "      OR lower(filename) LIKE 'sub!_%' ESCAPE '!' OR lower(filename) LIKE '%!_sub!_%' ESCAPE '!')"
).fetchone()[0]
print("  rows that the 'bass' role would pull in : {}".format(tot))
drum = 0
examples = []
for (fn,) in conn.execute(
        "SELECT filename FROM slice_index WHERE stem_type='harmonic'"
        " AND filename NOT LIKE 'mixture%'"
        " AND (lower(filename) LIKE '%bass%' OR lower(filename) LIKE '%808%'"
        "      OR lower(filename) LIKE 'sub!_%' ESCAPE '!' OR lower(filename) LIKE '%!_sub!_%' ESCAPE '!')"):
    n = (fn or "").lower()
    if any(t in n for t in DRUM_TOKENS):
        drum += 1
        if len(examples) < 10:
            examples.append(fn)
print("  of those, names carrying a percussion token : {} ({}%)".format(
    drum, round(100 * drum / tot, 1) if tot else 0))
print("  examples: {}".format(", ".join(examples)))

print("\n=== how many pack slices encode bpm or key in the name at all ===")
for label, pat in (("bpm", "%bpm%"), ("key", "%key%")):
    c = conn.execute(
        "SELECT COUNT(*) FROM slice_index WHERE lower(filename) LIKE ?", (pat,)).fetchone()[0]
    print("  filename contains '{}' : {}".format(label, c))

conn.close()
