"""Read-only: confirm the anonymous <digits>_phrase_<digits> slice population."""
from __future__ import annotations

import sqlite3

conn = sqlite3.connect(
    "file:C:/live_web_outputs/db/corpus_index_live.sqlite?mode=ro", uri=True)
conn.execute("PRAGMA busy_timeout=30000")
conn.execute("ATTACH DATABASE ? AS prof",
             ("file:C:/live_web_outputs/db/hybrid_acoustic_profiles.db?mode=ro",))

# GLOB gives us a real digits-only test; LIKE cannot express it.
ANON = "si.filename GLOB '[0-9]*_phrase_[0-9]*.wav' AND si.filename NOT GLOB '*[a-z]*_*[a-z]*'"

print("=== count of purely numeric-stem phrase slices ===")
n = conn.execute(
    "SELECT COUNT(*) FROM slice_index si WHERE si.filename GLOB"
    " '[0-9]*_phrase_[0-9]*.wav'").fetchone()[0]
print("  filename GLOB '[0-9]*_phrase_[0-9]*.wav' : {}".format(n))

print("\n=== 15 full rows of those ===")
for fp, fn, st, dk, bpm, rms, tags in conn.execute(
        "SELECT file_path, filename, stem_type, detected_key, estimated_bpm, rms_db, tags"
        " FROM slice_index si WHERE si.filename GLOB '[0-9]*_phrase_[0-9]*.wav' LIMIT 15"):
    print("  {:<26} stem={:<9} key={:<3} bpm={:<6} rms={:<8}".format(fn, st, dk, bpm, rms))
    print("      path={}".format(fp))
    print("      tags={}".format((tags or "")[:100]))

print("\n=== distinct parent dirs for those ===")
for d, c in conn.execute(
        "SELECT substr(si.file_path, 1, length(si.file_path)-length(si.filename)-1) AS d,"
        " COUNT(*) FROM slice_index si WHERE si.filename GLOB '[0-9]*_phrase_[0-9]*.wav'"
        " GROUP BY d ORDER BY 2 DESC LIMIT 10"):
    print("  {:<62} {}".format(d, c))

print("\n=== their stem_type / key / energy profile ===")
for st, c in conn.execute(
        "SELECT stem_type, COUNT(*) FROM slice_index si"
        " WHERE si.filename GLOB '[0-9]*_phrase_[0-9]*.wav' GROUP BY 1 ORDER BY 2 DESC"):
    print("  stem_type={:<12} {}".format(str(st), c))

row = conn.execute("""
 SELECT COUNT(*), SUM(si.rms_db > -60), SUM(si.estimated_bpm >= 60 AND si.estimated_bpm < 180),
        SUM(m.chroma_confidence >= 0.18), ROUND(AVG(m.chroma_confidence),4),
        ROUND(AVG(si.spectral_centroid),1), ROUND(AVG(m.transient_density),4)
 FROM slice_index si JOIN prof.slice_musical m ON m.file_path = si.file_path
 WHERE si.filename GLOB '[0-9]*_phrase_[0-9]*.wav'
""").fetchone()
print("\n  rows={}  non-silent={}  bpm-in-range={}  confident-key={}".format(*row[:4]))
print("  avg chroma_conf={}  avg centroid={}Hz  avg transient_density={}".format(*row[4:]))

print("\n=== for contrast: the named MUSDB-style slices ===")
row2 = conn.execute("""
 SELECT COUNT(*), ROUND(AVG(si.spectral_centroid),1), ROUND(AVG(m.transient_density),4),
        ROUND(AVG(m.chroma_confidence),4)
 FROM slice_index si JOIN prof.slice_musical m ON m.file_path = si.file_path
 WHERE si.filename NOT GLOB '[0-9]*_phrase_[0-9]*.wav'
""").fetchone()
print("  rows={}  avg centroid={}Hz  avg transient_density={}  avg chroma_conf={}".format(*row2))

conn.close()
