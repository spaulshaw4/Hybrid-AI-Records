"""Read-only audit of stem_type_ml quality and musical-feature health.

Touches only the C: replicas. Never opens the D: catalogue and never writes.

Ground truth for the audit comes from musdb/dsd derived slices, whose filenames
(``drums_s4_*``, ``bass_s4_*``, ``vocals_s4_*``, ``other_s4_*``) are reliable
labels. That is exactly the population the classifier was trained on, so it is
the fairest available check on the labels that landed in the index.
"""
from __future__ import annotations

import os
import re
import sqlite3
from collections import Counter, defaultdict

INDEX = r"C:\live_web_outputs\db\corpus_index_live.sqlite"
PROFILES = r"C:\live_web_outputs\db\hybrid_acoustic_profiles.db"

TRUTH_RE = re.compile(r"^(drums|bass|vocals|other)_s4_\d+", re.IGNORECASE)
ROLE_TO_STEM = {"drums": "rhythm", "bass": "bass", "vocals": "vocal", "other": "harmonic"}


def ro(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path.replace(os.sep, '/')}?mode=ro", uri=True, timeout=30)
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA query_only=ON")
    return conn


def audit_ml() -> None:
    conn = ro(INDEX)
    try:
        total = conn.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0]
        labelled = conn.execute(
            "SELECT COUNT(*) FROM slice_index WHERE stem_type_ml IS NOT NULL"
        ).fetchone()[0]
        print(f"slice_index rows      : {total}")
        print(f"stem_type_ml populated: {labelled}  ({100.0 * labelled / max(total,1):.4f}%)")
        print("ml label distribution :",
              conn.execute("SELECT stem_type_ml, COUNT(*) FROM slice_index "
                           "WHERE stem_type_ml IS NOT NULL GROUP BY 1 ORDER BY 2 DESC"
                           ).fetchall())
        print("rule stem_type distrib:",
              conn.execute("SELECT stem_type, COUNT(*) FROM slice_index "
                           "GROUP BY 1 ORDER BY 2 DESC").fetchall())

        rows = conn.execute(
            "SELECT filename, stem_type, stem_type_ml, stem_type_ml_confidence "
            "FROM slice_index WHERE stem_type_ml IS NOT NULL"
        ).fetchall()
    finally:
        conn.close()

    graded = [(TRUTH_RE.match(f).group(1).lower(), str(ml).lower(), conf, st)
              for f, st, ml, conf in rows if TRUTH_RE.match(f or "")]
    print(f"\nof the {len(rows)} labelled rows, {len(graded)} have a trustworthy "
          f"filename ground truth")
    if not graded:
        return

    labels = ["drums", "bass", "vocals", "other"]
    idx = {lab: i for i, lab in enumerate(labels)}
    mat = [[0] * len(labels) for _ in labels]
    unknown = Counter()
    correct = 0
    confs: list[float] = []
    for truth, pred, conf, _st in graded:
        confs.append(float(conf or 0.0))
        if pred in idx and truth in idx:
            mat[idx[truth]][idx[pred]] += 1
            correct += int(truth == pred)
        else:
            unknown[pred] += 1
    n = len(graded)
    print(f"\nMEASURED accuracy of the shipped .pt labels on these rows: "
          f"{correct}/{n} = {correct / n:.3f}")
    if unknown:
        print(f"predictions outside the 4 trained classes: {dict(unknown)}")
    width = 9
    print("\nconfusion (rows=filename truth, cols=stem_type_ml)")
    print(" " * width + "".join(f"{l:>9}" for l in labels))
    for i, lab in enumerate(labels):
        print(f"{lab:<{width}}" + "".join(f"{v:>9}" for v in mat[i]))
    confs.sort()
    if confs:
        mid = confs[len(confs) // 2]
        print(f"\nconfidence: min={confs[0]:.3f} median={mid:.3f} max={confs[-1]:.3f}")
        print(f"fraction with confidence < 0.60: "
              f"{sum(c < 0.60 for c in confs) / len(confs):.2%}")

    truth_vs_rule = sum(ROLE_TO_STEM.get(t) == st for t, _p, _c, st in graded)
    print(f"existing rule stem_type agreement with truth on same rows: "
          f"{truth_vs_rule}/{n} = {truth_vs_rule / n:.3f}")


def audit_musical() -> None:
    print("\n" + "=" * 60)
    conn = ro(PROFILES)
    try:
        total = conn.execute("SELECT COUNT(*) FROM slice_musical").fetchone()[0]
        print(f"slice_musical rows: {total}")
        for label, sql in (
            ("chroma_confidence < 0.01", "chroma_confidence < 0.01"),
            ("chroma_confidence < 0.05", "chroma_confidence < 0.05"),
            ("chroma_confidence >= 0.20", "chroma_confidence >= 0.20"),
            ("chroma NULL/empty", "chroma IS NULL OR chroma = ''"),
            ("onset_grid NULL/empty", "onset_grid IS NULL OR onset_grid = ''"),
            ("analyzed_bpm IS NULL", "analyzed_bpm IS NULL"),
        ):
            n = conn.execute(f"SELECT COUNT(*) FROM slice_musical WHERE {sql}").fetchone()[0]
            print(f"  {label:<28} {n:>9}  ({100.0 * n / max(total,1):5.2f}%)")
        quantiles = conn.execute(
            "SELECT MIN(chroma_confidence), AVG(chroma_confidence), "
            "MAX(chroma_confidence) FROM slice_musical"
        ).fetchone()
        print(f"  chroma_confidence min/avg/max: {quantiles}")
        roots = conn.execute(
            "SELECT chroma_root, COUNT(*) FROM slice_musical GROUP BY 1 ORDER BY 2 DESC LIMIT 14"
        ).fetchall()
        print(f"  chroma_root distribution: {roots}")
        n_feat = conn.execute("SELECT COUNT(*) FROM stem_features").fetchone()[0]
        dead = conn.execute(
            "SELECT COUNT(*) FROM stem_features WHERE spectral_centroid = 0 "
            "OR transient_density = 0"
        ).fetchone()[0]
        print(f"  stem_features rows: {n_feat}, with zeroed centroid/transients: "
              f"{dead} ({100.0 * dead / max(n_feat,1):.2f}%)")
    finally:
        conn.close()


if __name__ == "__main__":
    audit_ml()
    audit_musical()
