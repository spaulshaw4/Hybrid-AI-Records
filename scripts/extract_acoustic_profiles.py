"""Walk C:\\staging_slices into an isolated acoustic-profile SQLite DB.

Does not open corpus_index_live.sqlite or the D: catalog. Resumable: already
indexed relative paths are skipped. Default process priority is BelowNormal
so the :8880 worker keeps the NVMe.

    python scripts/extract_acoustic_profiles.py --limit 50
    python scripts/extract_acoustic_profiles.py
"""
from __future__ import annotations

import argparse
import os
import sys
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.acoustic_profiles import (  # noqa: E402
    DEFAULT_DB,
    DEFAULT_STAGING,
    analyze_file,
    connect_profiles,
    existing_paths,
    insert_batch,
    row_for_file,
)


def _below_normal() -> None:
    try:
        import ctypes

        handle = ctypes.windll.kernel32.GetCurrentProcess()  # type: ignore[attr-defined]
        ctypes.windll.kernel32.SetPriorityClass(handle, 0x00004000)  # BELOW_NORMAL  # type: ignore[attr-defined]
    except Exception:
        pass


def iter_wavs(root: str):
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if name.lower().endswith(".wav"):
                yield os.path.join(dirpath, name)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staging", default=DEFAULT_STAGING)
    parser.add_argument("--db", default=DEFAULT_DB, help="Parallel DB (never the live index)")
    parser.add_argument("--batch", type=int, default=100)
    parser.add_argument("--limit", type=int, default=0, help="Stop after N new rows (0 = all)")
    parser.add_argument("--progress", type=int, default=100)
    args = parser.parse_args()

    _below_normal()
    if not os.path.isdir(args.staging):
        print(f"[ACOUSTIC] staging missing: {args.staging}", flush=True)
        return 1

    conn = connect_profiles(args.db)
    seen = existing_paths(conn)
    print(
        f"[ACOUSTIC] db={os.path.abspath(args.db)} staging={args.staging} "
        f"already={len(seen)}",
        flush=True,
    )

    batch: list[tuple] = []
    scanned = skipped = written = failed = 0
    t0 = time.time()
    try:
        for path in iter_wavs(args.staging):
            scanned += 1
            rel = os.path.relpath(path, args.staging).replace("\\", "/")
            if rel in seen:
                skipped += 1
                continue
            profile = analyze_file(path)
            if profile is None:
                failed += 1
                print(f"[ACOUSTIC] skip {rel}", flush=True)
                continue
            batch.append(row_for_file(args.staging, path, profile))
            seen.add(rel)
            if len(batch) >= max(1, args.batch):
                insert_batch(conn, batch)
                written += len(batch)
                batch = []
            if args.progress and scanned > 0 and scanned % args.progress == 0:
                elapsed = max(1e-6, time.time() - t0)
                print(
                    f"[ACOUSTIC] scanned={scanned} written={written + len(batch)} "
                    f"skipped={skipped} failed={failed} "
                    f"{(written + len(batch)) / elapsed:.1f} new/s",
                    flush=True,
                )
            if args.limit and (written + len(batch)) >= args.limit:
                break
        if batch:
            insert_batch(conn, batch)
            written += len(batch)
    finally:
        conn.close()

    print(
        f"[ACOUSTIC] done scanned={scanned} written={written} "
        f"skipped={skipped} failed={failed} elapsed={time.time() - t0:.1f}s "
        f"db={os.path.abspath(args.db)}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
