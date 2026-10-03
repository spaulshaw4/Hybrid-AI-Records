"""Read-only schema + row-count probe for the three live databases."""
from __future__ import annotations

import sqlite3

DBS = {
    "index": r"C:\live_web_outputs\db\corpus_index_live.sqlite",
    "profiles": r"C:\live_web_outputs\db\hybrid_acoustic_profiles.db",
    "mix_history": r"C:\live_web_outputs\db\hybrid_mix_history.db",
}


def ro(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect("file:{}?mode=ro".format(path.replace("\\", "/")), uri=True)
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


for label, path in DBS.items():
    print("\n############ {} :: {}".format(label, path))
    try:
        conn = ro(path)
    except Exception as exc:
        print("  [ERR] {}".format(exc))
        continue
    try:
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        for tbl in tables:
            try:
                n = conn.execute('SELECT COUNT(*) FROM "{}"'.format(tbl)).fetchone()[0]
            except Exception as exc:
                print("  {} -> count failed: {}".format(tbl, exc))
                continue
            cols = [(r[1], r[2]) for r in conn.execute('PRAGMA table_info("{}")'.format(tbl))]
            print("\n  TABLE {}  rows={}".format(tbl, n))
            print("    cols: {}".format(", ".join("{}:{}".format(c, t) for c, t in cols)))
            if n:
                row = conn.execute('SELECT * FROM "{}" LIMIT 1'.format(tbl)).fetchone()
                shown = []
                for (c, _t), v in zip(cols, row):
                    s = str(v)
                    shown.append("{}={}".format(c, s[:60] + ("..." if len(s) > 60 else "")))
                print("    sample: {}".format(" | ".join(shown)))
    finally:
        conn.close()
