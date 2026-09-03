"""Register corpus_4s wavs into slice_index without re-analyzing audio.

Path + tags + stem_type only. Existing analyzed rows are left untouched.
Refuses uploaded_slices. Does not start a second DSP indexer.
Safe to run while the slicing campaign writes new wavs (WAL + busy_timeout).
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from db.index_578gb_corpus import (  # noqa: E402
    DEFAULT_CORPUS,
    assert_safe_corpus,
    default_index_db,
    discover_wavs,
    infer_stem_type,
    init_db,
    tags_from_path,
)

INSERT_NEW_SQL = """
INSERT OR IGNORE INTO slice_index
    (file_path, filename, stem_type, detected_key, estimated_bpm,
     rms_db, spectral_centroid, tags, duration_sec)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def _path_row(file_path: str, read_headers: bool) -> tuple:
    duration = None
    if read_headers:
        try:
            import soundfile as sf

            info = sf.info(file_path)
            if info.samplerate and info.frames:
                duration = round(float(info.frames) / float(info.samplerate), 2)
        except Exception:
            duration = None
    path_clean = file_path.lower().replace("\\", "/")
    return (
        file_path,
        os.path.basename(file_path),
        infer_stem_type(path_clean),
        None,
        None,
        None,
        None,
        tags_from_path(file_path),
        duration,
    )


def register_corpus(
    corpus_dir: str,
    db_path: str,
    read_headers: bool = False,
) -> dict[str, int]:
    assert_safe_corpus(corpus_dir)
    t0 = time.perf_counter()
    wavs = discover_wavs(corpus_dir, limit=None)
    conn = init_db(db_path)
    try:
        existing = {
            str(row[0])
            for row in conn.execute("SELECT file_path FROM slice_index")
        }
        todo = [path for path in wavs if path not in existing]
        inserted = 0
        batch: list[tuple] = []
        for path in todo:
            batch.append(_path_row(path, read_headers))
            if len(batch) >= 1000:
                conn.executemany(INSERT_NEW_SQL, batch)
                conn.commit()
                inserted += len(batch)
                batch.clear()
                print(f"  -> registered {inserted}/{len(todo)} new", flush=True)
        if batch:
            conn.executemany(INSERT_NEW_SQL, batch)
            conn.commit()
            inserted += len(batch)
        total = int(conn.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0])
    finally:
        conn.close()
    elapsed = time.perf_counter() - t0
    print(
        f"[COMPLETE] scanned={len(wavs)} already={len(existing)} "
        f"inserted={inserted} slice_index={total} in {elapsed:.1f}s db={db_path}",
        flush=True,
    )
    return {
        "scanned": len(wavs),
        "already": len(existing),
        "inserted": inserted,
        "total": total,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", default=DEFAULT_CORPUS)
    parser.add_argument("--db", default=default_index_db())
    parser.add_argument(
        "--headers",
        action="store_true",
        help="Read soundfile headers for duration_sec (slower).",
    )
    args = parser.parse_args(argv)
    try:
        register_corpus(args.corpus, args.db, read_headers=args.headers)
    except ValueError as exc:
        print(f"[FATAL] {exc}", file=sys.stderr)
        return 1
    except sqlite3.Error as exc:
        print(f"[FATAL] sqlite: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
