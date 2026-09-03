"""Read-only census walker for the D: music data volume.

Walks the drive once and records every file into a SQLite inventory so that all
subsequent analysis (sizes, archive reconciliation, duplicate detection, index
joins) can run without re-walking ~600 GB.

Creates nothing outside the report directory. Never modifies the scanned drive.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import time

ROOT = sys.argv[1] if len(sys.argv) > 1 else "D:\\"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "drive_inventory.sqlite"
)

if os.path.exists(OUT):
    print(f"refusing to overwrite existing {OUT}")
    sys.exit(1)

con = sqlite3.connect(OUT)
con.execute("PRAGMA journal_mode=OFF")
con.execute("PRAGMA synchronous=OFF")
con.execute(
    "CREATE TABLE files (path TEXT, parent TEXT, name TEXT, ext TEXT, size INTEGER, mtime REAL)"
)
con.execute("CREATE TABLE errors (path TEXT, err TEXT)")

batch = []
n_files = 0
n_dirs = 0
total = 0
start = time.time()


def walk(dirpath: str) -> None:
    global n_files, n_dirs, total
    try:
        it = os.scandir(dirpath)
    except OSError as exc:
        con.execute("INSERT INTO errors VALUES (?,?)", (dirpath, str(exc)))
        return
    subdirs = []
    with it:
        while True:
            try:
                entry = next(it)
            except StopIteration:
                break
            except OSError as exc:
                con.execute("INSERT INTO errors VALUES (?,?)", (dirpath, str(exc)))
                break
            try:
                if entry.is_dir(follow_symlinks=False):
                    n_dirs += 1
                    subdirs.append(entry.path)
                elif entry.is_file(follow_symlinks=False):
                    st = entry.stat(follow_symlinks=False)
                    name = entry.name
                    ext = os.path.splitext(name)[1].lower()
                    batch.append((entry.path, dirpath, name, ext, st.st_size, st.st_mtime))
                    n_files += 1
                    total += st.st_size
                    if len(batch) >= 20000:
                        con.executemany(
                            "INSERT INTO files VALUES (?,?,?,?,?,?)", batch
                        )
                        batch.clear()
                        print(
                            f"  {n_files:,} files  {total/1e9:.1f} GB  {time.time()-start:.0f}s",
                            flush=True,
                        )
            except OSError as exc:
                con.execute("INSERT INTO errors VALUES (?,?)", (entry.path, str(exc)))
    for sub in subdirs:
        walk(sub)


sys.setrecursionlimit(20000)
walk(ROOT)
if batch:
    con.executemany("INSERT INTO files VALUES (?,?,?,?,?,?)", batch)
con.commit()
con.execute("CREATE INDEX idx_parent ON files(parent)")
con.execute("CREATE INDEX idx_name_size ON files(name, size)")
con.execute("CREATE INDEX idx_ext ON files(ext)")
con.commit()
print(f"DONE files={n_files:,} dirs={n_dirs:,} bytes={total:,} ({total/1e9:.2f} GB) in {time.time()-start:.0f}s")
