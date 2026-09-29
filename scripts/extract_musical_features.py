"""Measure chroma + onset grid for every row in the live corpus index.

Reads ``slice_index`` read-only and writes an isolated profiles DB keyed on the
same ``file_path``, so the picker can join without guessing paths. The live
index is never written.

Resumable: rows already present are skipped, so Ctrl-C costs at most one batch.
Runs BelowNormal with a worker pool; ~46 ms/slice single-process is ~18 h for
1.38M files, so the pool is the difference between overnight and a weekend.

    python scripts/extract_musical_features.py --limit 2000      # sample
    python scripts/extract_musical_features.py --workers 6       # full run
"""
from __future__ import annotations

import argparse
import multiprocessing as mp
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.acoustic_profiles import DEFAULT_DB, connect_profiles  # noqa: E402

LIVE_INDEX = r"C:\live_web_outputs\db\corpus_index_live.sqlite"


def _below_normal() -> None:
    try:
        import ctypes

        h = ctypes.windll.kernel32.GetCurrentProcess()  # type: ignore[attr-defined]
        ctypes.windll.kernel32.SetPriorityClass(h, 0x00004000)  # BELOW_NORMAL  # type: ignore[attr-defined]
    except Exception:
        pass


def analyze_one(task: tuple[str, float]) -> tuple | None:
    """Worker body. Returns a ``slice_musical`` row, or None if unreadable."""
    path, bpm = task
    try:
        import soundfile as sf

        from engine.musical_features import (
            chroma_vector,
            downbeat_phase,
            estimate_root,
            onset_grid,
            pack_floats,
        )

        data, sr = sf.read(path, always_2d=True, dtype="float64")
        chroma = chroma_vector(data, int(sr))
        root, minor, conf = estimate_root(chroma)
        grid = onset_grid(data, int(sr), float(bpm or 0.0))
        return (
            path,
            pack_floats(chroma),
            int(root),
            int(bool(minor)),
            float(conf),
            pack_floats(grid),
            float(downbeat_phase(grid)),
            float(grid.mean()),
            float(bpm or 0.0),
            datetime.now(timezone.utc).isoformat(),
        )
    except Exception:
        return None


def pending_tasks(conn: sqlite3.Connection, limit: int) -> list[tuple[str, float]]:
    """Index rows that have no musical features yet."""
    done = {r[0] for r in conn.execute("SELECT file_path FROM slice_musical")}
    live = sqlite3.connect(f"file:{LIVE_INDEX}?mode=ro", uri=True)
    live.execute("PRAGMA busy_timeout=30000")
    tasks: list[tuple[str, float]] = []
    for path, bpm in live.execute("SELECT file_path, estimated_bpm FROM slice_index"):
        if path in done:
            continue
        tasks.append((str(path), float(bpm or 0.0)))
        if limit and len(tasks) >= limit:
            break
    live.close()
    return tasks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 2))
    parser.add_argument("--batch", type=int, default=250)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--progress", type=int, default=1000)
    args = parser.parse_args()

    _below_normal()
    conn = connect_profiles(args.db)
    print("[MUSICAL] collecting pending rows from the live index (read-only)...", flush=True)
    tasks = pending_tasks(conn, args.limit)
    print(f"[MUSICAL] pending={len(tasks)} workers={args.workers} db={os.path.abspath(args.db)}",
          flush=True)
    if not tasks:
        conn.close()
        print("[MUSICAL] nothing to do", flush=True)
        return 0

    written = failed = 0
    batch: list[tuple] = []
    t0 = time.time()
    try:
        with mp.Pool(processes=max(1, args.workers), initializer=_below_normal) as pool:
            for row in pool.imap_unordered(analyze_one, tasks, chunksize=16):
                if row is None:
                    failed += 1
                    continue
                batch.append(row)
                if len(batch) >= args.batch:
                    conn.executemany(
                        "INSERT OR REPLACE INTO slice_musical VALUES (?,?,?,?,?,?,?,?,?,?)", batch
                    )
                    conn.commit()
                    written += len(batch)
                    batch = []
                    if args.progress and written % args.progress == 0:
                        rate = written / max(1e-6, time.time() - t0)
                        left = (len(tasks) - written) / max(1e-6, rate) / 3600.0
                        print(
                            f"[MUSICAL] {written}/{len(tasks)} failed={failed} "
                            f"{rate:.0f}/s eta={left:.1f}h",
                            flush=True,
                        )
        if batch:
            conn.executemany(
                "INSERT OR REPLACE INTO slice_musical VALUES (?,?,?,?,?,?,?,?,?,?)", batch
            )
            conn.commit()
            written += len(batch)
    except KeyboardInterrupt:
        if batch:
            conn.executemany(
                "INSERT OR REPLACE INTO slice_musical VALUES (?,?,?,?,?,?,?,?,?,?)", batch
            )
            conn.commit()
            written += len(batch)
        print(f"[MUSICAL] interrupted; {written} rows are committed and will be skipped on resume",
              flush=True)
    finally:
        conn.close()

    print(
        f"[MUSICAL] done written={written} failed={failed} "
        f"elapsed={(time.time() - t0) / 60.0:.1f} min",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    mp.freeze_support()
    raise SystemExit(main())
