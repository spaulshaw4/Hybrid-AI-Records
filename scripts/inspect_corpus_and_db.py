"""Read-only probe: corpus_4s slice naming/audio format and the live slice_index.

Layout is ``corpus_4s/<track dir>/<label>_s4_<n>.wav`` (and a nested ``dsd100/``
tree with the same shape), so the *source track* is the parent directory. That
directory is the grouping key any train/val split must respect.

Opens the SQLite index in read-only URI mode with a busy timeout so it cannot
interfere with the full reindex that is running.
"""
from __future__ import annotations

import os
import re
import sqlite3
from collections import Counter, defaultdict

CORPUS = r"D:\MusicDatasets\corpus_4s"
DB = r"D:\MusicDatasets\db\corpus_index.sqlite"
SLICE_RE = re.compile(r"^(drums|bass|vocals|other|mixture)_s4_(\d+)\.wav$", re.IGNORECASE)


def probe_corpus() -> None:
    print("=== corpus_4s labeled slices (label = filename prefix, track = parent dir) ===")
    per_label: Counter = Counter()
    tracks_per_label: dict[str, set[str]] = defaultdict(set)
    unmatched = 0
    unmatched_examples: list[str] = []
    for dirpath, _d, files in os.walk(CORPUS):
        track = os.path.relpath(dirpath, CORPUS)
        for name in files:
            if not name.lower().endswith(".wav"):
                continue
            match = SLICE_RE.match(name)
            if match:
                label = match.group(1).lower()
                per_label[label] += 1
                tracks_per_label[label].add(track)
            else:
                unmatched += 1
                if len(unmatched_examples) < 5:
                    unmatched_examples.append(os.path.join(track, name))
    print(f"  per-label slice counts: {dict(per_label.most_common())}")
    print(f"  distinct source tracks per label: "
          f"{ {k: len(v) for k, v in sorted(tracks_per_label.items())} }")
    all_tracks = set().union(*tracks_per_label.values()) if tracks_per_label else set()
    print(f"  distinct source tracks overall: {len(all_tracks)}")
    print(f"  wavs not matching the slice convention: {unmatched} e.g. {unmatched_examples}")

    print("\n=== audio format of a few labeled slices ===")
    import soundfile as sf

    shown = 0
    for dirpath, _d, files in os.walk(CORPUS):
        for name in files:
            if not SLICE_RE.match(name):
                continue
            path = os.path.join(dirpath, name)
            try:
                info = sf.info(path)
                print(
                    f"  {name}: sr={info.samplerate} ch={info.channels} "
                    f"frames={info.frames} dur={info.duration:.3f} subtype={info.subtype}"
                )
            except Exception as exc:  # pragma: no cover - diagnostic only
                print(f"  {name}: FAILED {exc}")
            shown += 1
            if shown >= 5:
                return


def probe_db() -> None:
    print("\n=== live slice_index ===")
    if not os.path.isfile(DB):
        print(f"  MISSING {DB}")
        return
    conn = sqlite3.connect(f"file:{DB.replace(os.sep, '/')}?mode=ro", uri=True)
    conn.execute("PRAGMA busy_timeout=30000")
    try:
        tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        print(f"  tables: {[t[0] for t in tables]}")
        cols = [r[1] for r in conn.execute("PRAGMA table_info(slice_index)")]
        print(f"  columns: {cols}")
        total = conn.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0]
        print(f"  rows: {total}")
        by_stem = conn.execute(
            "SELECT stem_type, COUNT(*) FROM slice_index GROUP BY 1 ORDER BY 2 DESC"
        ).fetchall()
        print(f"  by stem_type: {by_stem}")
        print(f"  journal_mode: {conn.execute('PRAGMA journal_mode').fetchone()}")
    finally:
        conn.close()


if __name__ == "__main__":
    probe_corpus()
    probe_db()
