"""Read-only: list indexes on the two big tables so the join plan is informed."""
from __future__ import annotations

import sqlite3

for label, path, tbl in (
    ("index", r"C:\live_web_outputs\db\corpus_index_live.sqlite", "slice_index"),
    ("profiles", r"C:\live_web_outputs\db\hybrid_acoustic_profiles.db", "slice_musical"),
):
    conn = sqlite3.connect("file:{}?mode=ro".format(path.replace("\\", "/")), uri=True)
    conn.execute("PRAGMA busy_timeout=30000")
    print("\n### {} / {}".format(label, tbl))
    for row in conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=?", (tbl,)):
        print("  {} :: {}".format(row[0], row[1]))
    print("  table sql: {}".format(conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (tbl,)).fetchone()[0]))
    conn.close()
