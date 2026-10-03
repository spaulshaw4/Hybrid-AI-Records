"""Read-only: characterise the rows whose filename yields no retrieval role."""
from __future__ import annotations

import collections
import re
import sqlite3

INDEX_DB = r"C:\live_web_outputs\db\corpus_index_live.sqlite"

ROLE_SQL = """
CASE
  WHEN lower(filename) LIKE 'mixture%' THEN 'mixture_excluded'
  WHEN lower(filename) LIKE 'sub!_%' ESCAPE '!' OR instr(lower(filename),'_sub_')>0 THEN 'bass'
  WHEN lower(filename) LIKE 'bass%' OR lower(filename) LIKE '808%' THEN 'bass'
  WHEN lower(filename) LIKE 'drums%' OR lower(filename) LIKE 'drum%'
       OR lower(filename) LIKE 'perc%' OR lower(filename) LIKE 'kick%'
       OR lower(filename) LIKE 'snare%' OR lower(filename) LIKE 'hat%' THEN 'rhythm'
  WHEN lower(filename) LIKE 'vocals%' OR lower(filename) LIKE 'vocal%'
       OR lower(filename) LIKE 'vox%' THEN 'vocal'
  WHEN lower(filename) LIKE 'other%' OR lower(filename) LIKE 'harm%'
       OR lower(filename) LIKE 'pad%' OR lower(filename) LIKE 'synth%'
       OR lower(filename) LIKE 'guitar%' OR lower(filename) LIKE 'keys%'
       OR lower(filename) LIKE 'piano%' THEN 'harmonic'
  ELSE 'unmapped'
END
"""

conn = sqlite3.connect("file:{}?mode=ro".format(INDEX_DB.replace("\\", "/")), uri=True)
conn.execute("PRAGMA busy_timeout=30000")

print("=== 30 sample unmapped filenames + paths ===")
for fp, fn, st in conn.execute(
        "SELECT file_path, filename, stem_type FROM slice_index"
        " WHERE {r} = 'unmapped' LIMIT 30".format(r=ROLE_SQL)):
    print("  {:<58} | stem={:<9} | {}".format(fn[:58], st, fp[:90]))

print("\n=== leading alpha token of unmapped filenames (top 30) ===")
tok = collections.Counter()
for (fn,) in conn.execute(
        "SELECT filename FROM slice_index WHERE {r} = 'unmapped'".format(r=ROLE_SQL)):
    m = re.match(r"^([A-Za-z]+)", fn or "")
    tok[(m.group(1).lower() if m else "<non-alpha>")] += 1
for name, c in tok.most_common(30):
    print("  {:<28} {}".format(name, c))

print("\n=== unmapped: parent directory (top 20) ===")
d = collections.Counter()
for (fp,) in conn.execute(
        "SELECT file_path FROM slice_index WHERE {r} = 'unmapped'".format(r=ROLE_SQL)):
    p = (fp or "").replace("/", "\\")
    d[p.rsplit("\\", 2)[-2] if p.count("\\") >= 2 else p] += 1
for name, c in d.most_common(20):
    print("  {:<58} {}".format(name[:58], c))

print("\n=== unmapped by stem_type ===")
for st, c in conn.execute(
        "SELECT stem_type, COUNT(*) FROM slice_index WHERE {r}='unmapped'"
        " GROUP BY stem_type ORDER BY 2 DESC".format(r=ROLE_SQL)):
    print("  {:<16} {}".format(str(st), c))

print("\n=== corpus-wide detected_key vs chroma_root agreement (all rows) ===")
conn.execute("ATTACH DATABASE ? AS prof",
             ("file:C:/live_web_outputs/db/hybrid_acoustic_profiles.db?mode=ro",))
row = conn.execute("""
 SELECT COUNT(*),
   SUM(CASE WHEN si.detected_key = CASE m.chroma_root
     WHEN 0 THEN 'C' WHEN 1 THEN 'C#' WHEN 2 THEN 'D' WHEN 3 THEN 'D#'
     WHEN 4 THEN 'E' WHEN 5 THEN 'F' WHEN 6 THEN 'F#' WHEN 7 THEN 'G'
     WHEN 8 THEN 'G#' WHEN 9 THEN 'A' WHEN 10 THEN 'A#' ELSE 'B' END
   THEN 1 ELSE 0 END)
 FROM slice_index si JOIN prof.slice_musical m ON m.file_path = si.file_path
""").fetchone()
print("  rows joined={}  agree={}  pct={}".format(
    row[0], row[1], round(100.0 * row[1] / row[0], 1) if row[0] else None))
conn.close()
