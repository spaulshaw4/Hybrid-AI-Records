"""Read-only: corrected 808-contamination test + the pool sizes retrieval sees."""
from __future__ import annotations

import re
import sqlite3

conn = sqlite3.connect(
    "file:C:/live_web_outputs/db/corpus_index_live.sqlite?mode=ro", uri=True)
conn.execute("PRAGMA busy_timeout=30000")
conn.execute("ATTACH DATABASE ? AS prof",
             ("file:C:/live_web_outputs/db/hybrid_acoustic_profiles.db?mode=ro",))

# Percussion suffix immediately before _phrase / end: avoids matching band names
# like "Dark Ride". Anchored on the 808 one-shot pack convention.
PERC = re.compile(
    r"_(bd|sd|hh|ohh|tom\d?|cymbal|rim|clave|cp|cb|mar|kick|snare|hat|clap|crash|ride"
    r"|shaker|tamb|conga|bongo|cowbell)(?:_phrase_\d+)?$")

BASS_FILTER = (
    " stem_type='harmonic' AND filename NOT LIKE 'mixture%'"
    " AND (lower(filename) LIKE '%bass%' OR lower(filename) LIKE '%808%'"
    "      OR lower(filename) LIKE 'sub!_%' ESCAPE '!'"
    "      OR lower(filename) LIKE '%!_sub!_%' ESCAPE '!')")

tot = 0
perc = 0
ex = []
for (fn,) in conn.execute("SELECT filename FROM slice_index WHERE" + BASS_FILTER):
    tot += 1
    stem = (fn or "").lower().removesuffix(".wav")
    if PERC.search(stem):
        perc += 1
        if len(ex) < 12:
            ex.append(fn)
print("=== bass role pool, drawn from stem_type='harmonic' by name token ===")
print("  total rows the bass role would consider : {}".format(tot))
print("  of those, percussion one-shots (808 kit) : {} ({}%)".format(
    perc, round(100 * perc / tot, 2) if tot else 0))
print("  examples: {}".format(", ".join(ex)))

print("\n=== pool size per role as retrieval filters it (stem_type based) ===")
print("  {:<10} {:>12} {:>14} {:>16} {:>18}".format(
    "role", "stem_type", "non-silent", "+bpm 60-180", "+conf key>=0.30"))
for role, where in (
    ("rhythm", "si.stem_type='rhythm'"),
    ("vocal", "si.stem_type='vocal'"),
    ("harmonic", "si.stem_type='harmonic' AND lower(si.filename) NOT LIKE '%bass%'"
                 " AND lower(si.filename) NOT LIKE '%808%'"),
    ("bass", BASS_FILTER.replace("stem_type", "si.stem_type")
             .replace("filename", "si.filename")),
    ("lead", "si.stem_type='lead'"),
):
    base = "FROM slice_index si LEFT JOIN prof.slice_musical m ON m.file_path=si.file_path WHERE "
    a = conn.execute("SELECT COUNT(*) " + base + where).fetchone()[0]
    b = conn.execute("SELECT COUNT(*) " + base + where +
                     " AND si.rms_db > -60").fetchone()[0]
    c = conn.execute("SELECT COUNT(*) " + base + where +
                     " AND si.rms_db > -60 AND si.estimated_bpm >= 60"
                     " AND si.estimated_bpm < 180").fetchone()[0]
    d = conn.execute("SELECT COUNT(*) " + base + where +
                     " AND si.rms_db > -60 AND si.estimated_bpm >= 60"
                     " AND si.estimated_bpm < 180 AND m.chroma_confidence >= 0.30"
                     ).fetchone()[0]
    print("  {:<10} {:>12} {:>14} {:>16} {:>18}".format(role, a, b, c, d))

print("\n=== worked example: the only request ever rendered (A minor, 120 BPM) ===")
print("  BPM window 112.8-127.2 (+/-6%), chroma_root=9 (A), minor, conf>=0.30")
print("  {:<10} {:>10} {:>14} {:>16}".format("role", "key+bpm", "relaxed key", "relaxed bpm"))
for role, where in (
    ("rhythm", "si.stem_type='rhythm'"),
    ("vocal", "si.stem_type='vocal'"),
    ("harmonic", "si.stem_type='harmonic' AND lower(si.filename) NOT LIKE '%bass%'"
                 " AND lower(si.filename) NOT LIKE '%808%'"),
    ("bass", BASS_FILTER.replace("stem_type", "si.stem_type")
             .replace("filename", "si.filename")),
):
    base = ("FROM slice_index si JOIN prof.slice_musical m ON m.file_path=si.file_path"
            " WHERE " + where + " AND si.rms_db > -60")
    strict = conn.execute(
        "SELECT COUNT(*) " + base +
        " AND si.estimated_bpm BETWEEN 112.8 AND 127.2"
        " AND m.chroma_root=9 AND m.chroma_is_minor=1 AND m.chroma_confidence>=0.30"
    ).fetchone()[0]
    nokey = conn.execute(
        "SELECT COUNT(*) " + base +
        " AND si.estimated_bpm BETWEEN 112.8 AND 127.2").fetchone()[0]
    nobpm = conn.execute(
        "SELECT COUNT(*) " + base +
        " AND m.chroma_root=9 AND m.chroma_is_minor=1 AND m.chroma_confidence>=0.30"
    ).fetchone()[0]
    print("  {:<10} {:>10} {:>14} {:>16}".format(role, strict, nokey, nobpm))

conn.close()
