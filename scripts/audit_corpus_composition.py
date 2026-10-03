"""Read-only: how much of the corpus has informative filenames vs. none.

Sizes the real opportunity for an audio-based classifier. Where filenames
already carry the stem label, a model adds little. Where they do not, the rule
has nothing to work with and everything lands in ``harmonic``.
"""
from __future__ import annotations

import sqlite3

URI = "file:C:/live_web_outputs/db/corpus_index_live.sqlite?mode=ro"


def main() -> int:
    conn = sqlite3.connect(URI, uri=True, timeout=30)
    conn.execute("PRAGMA query_only=ON")
    try:
        total = conn.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0]
        print(f"slice_index rows: {total}\n")

        groups = {
            "musdb/dsd style (drums|bass|vocals|other _s4_)":
                "filename LIKE 'drums[_]s4[_]%' ESCAPE '' OR filename LIKE 'bass_s4_%' "
                "OR filename LIKE 'vocals_s4_%' OR filename LIKE 'other_s4_%'",
            "name contains 'bass'": "lower(filename) LIKE '%bass%'",
            "name contains 'drum' or 'kick'/'snare'/'hat'":
                "lower(filename) LIKE '%drum%' OR lower(filename) LIKE '%kick%' "
                "OR lower(filename) LIKE '%snare%' OR lower(filename) LIKE '%hat%'",
            "name contains 'vocal'/'vox'": "lower(filename) LIKE '%vocal%' "
                "OR lower(filename) LIKE '%vox%'",
            "name contains 'gtr'/'guitar'": "lower(filename) LIKE '%guitar%' "
                "OR lower(filename) LIKE '%gtr%'",
            "name contains 'pad'/'synth'/'key'": "lower(filename) LIKE '%pad%' "
                "OR lower(filename) LIKE '%synth%' OR lower(filename) LIKE '%key%'",
        }
        for label, where in groups.items():
            try:
                n = conn.execute(
                    f"SELECT COUNT(*) FROM slice_index WHERE {where}"
                ).fetchone()[0]
            except sqlite3.Error as exc:
                print(f"  {label:<48} query error: {exc}")
                continue
            print(f"  {label:<48} {n:>9}  ({100.0 * n / max(total,1):5.2f}%)")

        print("\nstem_type vs whether the name says 'bass':")
        rows = conn.execute(
            "SELECT stem_type, SUM(CASE WHEN lower(filename) LIKE '%bass%' THEN 1 ELSE 0 END), "
            "COUNT(*) FROM slice_index GROUP BY stem_type ORDER BY COUNT(*) DESC"
        ).fetchall()
        for stem, bassish, n in rows:
            print(f"  {str(stem):<10} total={n:>9}  name-says-bass={bassish:>8}")

        print("\nharmonic rows whose name gives no instrument hint at all:")
        n = conn.execute(
            "SELECT COUNT(*) FROM slice_index WHERE stem_type='harmonic' "
            "AND lower(filename) NOT LIKE '%bass%' AND lower(filename) NOT LIKE '%guitar%' "
            "AND lower(filename) NOT LIKE '%gtr%' AND lower(filename) NOT LIKE '%pad%' "
            "AND lower(filename) NOT LIKE '%synth%' AND lower(filename) NOT LIKE '%key%' "
            "AND lower(filename) NOT LIKE '%piano%' AND lower(filename) NOT LIKE '%other%'"
        ).fetchone()[0]
        print(f"  {n}  ({100.0 * n / max(total,1):.2f}% of the whole corpus)")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
