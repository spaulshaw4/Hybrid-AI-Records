"""Read-only: sample the corpus_4s\\harmonic folder that holds ~93% of the index."""
from __future__ import annotations

import collections
import re
import sqlite3

conn = sqlite3.connect(
    "file:C:/live_web_outputs/db/corpus_index_live.sqlite?mode=ro", uri=True)
conn.execute("PRAGMA busy_timeout=30000")

print("=== 40 random-ish filenames from corpus_4s\\harmonic ===")
for (fn,) in conn.execute(
        "SELECT filename FROM slice_index"
        " WHERE instr(lower(replace(file_path,'/','\\')), '\\corpus_4s\\harmonic\\') > 0"
        " ORDER BY id DESC LIMIT 40"):
    print("   " + fn)

print("\n=== 20 from the oldest ids in that folder ===")
for (fn,) in conn.execute(
        "SELECT filename FROM slice_index"
        " WHERE instr(lower(replace(file_path,'/','\\')), '\\corpus_4s\\harmonic\\') > 0"
        " ORDER BY id ASC LIMIT 20"):
    print("   " + fn)

print("\n=== token after the LAST double underscore (top 30) ===")
tail = collections.Counter()
for (fn,) in conn.execute(
        "SELECT filename FROM slice_index"
        " WHERE instr(lower(replace(file_path,'/','\\')), '\\corpus_4s\\harmonic\\') > 0"):
    n = (fn or "").lower().removesuffix(".wav")
    parts = n.split("__")
    tail[parts[-1] if len(parts) > 1 else "<no __>"] += 1
for t, c in tail.most_common(30):
    print("  {:<46} {}".format(t[:46], c))

print("\n=== structural shape: strip trailing digits, keep the skeleton (top 25) ===")
shape = collections.Counter()
for (fn,) in conn.execute(
        "SELECT filename FROM slice_index"
        " WHERE instr(lower(replace(file_path,'/','\\')), '\\corpus_4s\\harmonic\\') > 0"):
    n = (fn or "").lower().removesuffix(".wav")
    n = re.sub(r"\d+", "#", n)
    shape[n] += 1
for s, c in shape.most_common(25):
    print("  {:<58} {}".format(s[:58], c))

conn.close()
