"""Read-only: can a stem classifier be trained on ALREADY-COMPUTED columns?

If the musdb/dsd slices (which carry trustworthy filename labels) all have rows
in ``slice_musical``, then a classifier can be trained on chroma + onset grid +
transient density + centroid + level with no audio decoding at all -- and then
applied to all 1.385M rows the same way. That would replace a ~17 h decode job
with a few minutes of matrix work.

This script only counts. It trains nothing and writes nothing.
"""
from __future__ import annotations

import sqlite3

INDEX_URI = "file:C:/live_web_outputs/db/corpus_index_live.sqlite?mode=ro"
PROFILES = r"C:\live_web_outputs\db\hybrid_acoustic_profiles.db"

LABEL_PREFIXES = ("drums_s4_", "bass_s4_", "vocals_s4_", "other_s4_")


def main() -> int:
    conn = sqlite3.connect(INDEX_URI, uri=True, timeout=30)
    conn.execute("PRAGMA query_only=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    try:
        conn.execute(
            "ATTACH DATABASE ? AS prof",
            (f"file:{PROFILES.replace(chr(92), '/')}?mode=ro",),
        )
    except sqlite3.Error as exc:
        print(f"attach failed: {exc}")
        return 1
    try:
        print("labelled population available for supervised training:\n")
        grand = 0
        for prefix in LABEL_PREFIXES:
            like = prefix.replace("_", "@_") + "%"
            n_idx = conn.execute(
                "SELECT COUNT(*) FROM slice_index WHERE filename LIKE ? ESCAPE '@'",
                (like,),
            ).fetchone()[0]
            n_join = conn.execute(
                "SELECT COUNT(*) FROM slice_index si JOIN prof.slice_musical m "
                "ON m.file_path = si.file_path WHERE si.filename LIKE ? ESCAPE '@'",
                (like,),
            ).fetchone()[0]
            grand += n_join
            cover = 100.0 * n_join / max(n_idx, 1)
            print(f"  {prefix:<12} index rows={n_idx:>7}  with features={n_join:>7} "
                  f"({cover:5.1f}% feature coverage)")
        print(f"\n  total trainable rows with features already computed: {grand}")

        total = conn.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0]
        joined = conn.execute(
            "SELECT COUNT(*) FROM slice_index si JOIN prof.slice_musical m "
            "ON m.file_path = si.file_path"
        ).fetchone()[0]
        print(f"\n  whole-corpus join coverage: {joined}/{total} "
              f"({100.0 * joined / max(total,1):.2f}%)")
        print("  -> this is the population an inference pass could label "
              "without touching audio")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
