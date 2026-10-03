"""Read-only: recover the role token embedded in the new slice naming scheme.

New slices are named ``<NNN>_<artist>_<title>__<role>_s<NNNNN>.wav`` so the role
sits after a double underscore rather than at the start of the name, which is
why the prefix-based retriever classifies them as unmapped.
"""
from __future__ import annotations

import collections
import re
import sqlite3

INDEX_DB = r"C:\live_web_outputs\db\corpus_index_live.sqlite"
PROFILES_DB = r"C:\live_web_outputs\db\hybrid_acoustic_profiles.db"

EMBED = re.compile(r"__([a-z]+?)(?:_phrase)?_s\d+", re.IGNORECASE)
ANY_TOKEN = re.compile(r"__([a-z]+)", re.IGNORECASE)

ROLE_OF = {
    "bass": "bass", "808": "bass", "sub": "bass",
    "drums": "rhythm", "drum": "rhythm", "beats": "rhythm", "perc": "rhythm",
    "kick": "rhythm", "snare": "rhythm", "hat": "rhythm", "hihat": "rhythm",
    "vocals": "vocal", "vocal": "vocal", "vox": "vocal", "voice": "vocal",
    "other": "harmonic", "harm": "harmonic", "harmonic": "harmonic",
    "pad": "harmonic", "synth": "harmonic", "guitar": "harmonic",
    "keys": "harmonic", "piano": "harmonic", "acoustic": "harmonic",
    "chords": "harmonic", "melody": "lead", "lead": "lead", "melodic": "lead",
    "mixture": "MIXTURE",
}

conn = sqlite3.connect("file:{}?mode=ro".format(INDEX_DB.replace("\\", "/")), uri=True)
conn.execute("PRAGMA busy_timeout=30000")
conn.execute("ATTACH DATABASE ? AS prof",
             ("file:{}?mode=ro".format(PROFILES_DB.replace("\\", "/")),))

tok_counts = collections.Counter()
role_counts = collections.Counter()
unparsed = collections.Counter()
# role -> (bpm_in_range_and_loud, confident_key) tallies
renderable = collections.Counter()
role_key = collections.Counter()
NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

rows = conn.execute("""
 SELECT si.filename, si.rms_db, si.estimated_bpm,
        m.chroma_root, m.chroma_is_minor, m.chroma_confidence
 FROM slice_index si LEFT JOIN prof.slice_musical m ON m.file_path = si.file_path
""")

total = 0
for fn, rms, bpm, root, minor, conf in rows:
    total += 1
    name = (fn or "").lower()
    m = EMBED.search(name)
    tok = m.group(1) if m else None
    if tok is None:
        m2 = ANY_TOKEN.search(name)
        tok = m2.group(1) if m2 else None
    if tok is None:
        # fall back to the leading prefix form (old musdb naming)
        lead = re.match(r"^([a-z]+)", name)
        tok = lead.group(1) if lead else "<none>"
    tok_counts[tok] += 1
    role = ROLE_OF.get(tok)
    if role is None:
        unparsed[tok] += 1
        continue
    if role == "MIXTURE":
        role_counts["mixture_excluded"] += 1
        continue
    role_counts[role] += 1
    ok_level = rms is not None and rms > -60
    ok_bpm = bpm is not None and 60.0 <= bpm < 180.0
    ok_key = conf is not None and conf >= 0.18
    if ok_level and ok_bpm:
        renderable[(role, "level+bpm")] += 1
        if ok_key:
            renderable[(role, "level+bpm+key")] += 1
            if root is not None:
                role_key[(role, int(root) % 12, int(minor or 0))] += 1

print("total rows scanned: {}".format(total))
print("\n=== embedded/leading token frequency (top 35) ===")
for t, c in tok_counts.most_common(35):
    print("  {:<16} {:>9}   -> {}".format(t, c, ROLE_OF.get(t, "UNMAPPED")))

print("\n=== recovered role totals ===")
for r, c in role_counts.most_common():
    print("  {:<18} {:>9}  ({}%)".format(r, c, round(100.0 * c / total, 1)))
print("  {:<18} {:>9}  ({}%)".format("still unmapped", sum(unparsed.values()),
                                     round(100.0 * sum(unparsed.values()) / total, 1)))

print("\n=== renderable depth per role ===")
print("  {:<12} {:>12} {:>16} {:>18}".format("role", "recovered", "level+bpm ok", "+confident key"))
for r in ("rhythm", "bass", "harmonic", "vocal", "lead"):
    print("  {:<12} {:>12} {:>16} {:>18}".format(
        r, role_counts.get(r, 0),
        renderable.get((r, "level+bpm"), 0),
        renderable.get((r, "level+bpm+key"), 0)))

print("\n=== role x 24-key occupancy (confident, renderable) ===")
for r in ("rhythm", "bass", "harmonic", "vocal", "lead"):
    cells = {(k, mi): n for (rr, k, mi), n in role_key.items() if rr == r}
    filled = len(cells)
    ge20 = sum(1 for v in cells.values() if v >= 20)
    ge5 = sum(1 for v in cells.values() if v >= 5)
    print("  {:<10} keys_filled={:>2}/24  >=5 slices={:>2}  >=20 slices={:>2}  total={}".format(
        r, filled, ge5, ge20, sum(cells.values())))

print("\n=== thinnest 24-key cells by role (confident, renderable) ===")
for r in ("rhythm", "bass", "harmonic", "vocal", "lead"):
    cells = {"{}{}".format(NOTE[k], "m" if mi else "M"): n
             for (rr, k, mi), n in role_key.items() if rr == r}
    missing = [ "{}{}".format(NOTE[k], mo)
                for k in range(12) for mo in ("M", "m")
                if "{}{}".format(NOTE[k], mo) not in cells ]
    print("  {:<10} empty keys: {}".format(r, ", ".join(missing) if missing else "none"))

conn.close()
