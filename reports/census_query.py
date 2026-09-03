"""Ad-hoc read-only queries against the drive inventory built by drive_census_walk.py."""

import os
import sqlite3
import sys

INV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "drive_inventory.sqlite")
con = sqlite3.connect(INV)
con.create_function("gb", 1, lambda b: round((b or 0) / 1e9, 3))


def show(title, rows, headers):
    print(f"\n=== {title} ===")
    print(" | ".join(headers))
    for r in rows:
        print(" | ".join(str(x) for x in r))


mode = sys.argv[1]

if mode == "toplevel":
    # top level of D:\
    rows = con.execute(
        """
        SELECT CASE
                 WHEN instr(substr(path,4), '\\') = 0 THEN '<file at D:\\ root>'
                 ELSE substr(substr(path,4), 1, instr(substr(path,4),'\\')-1)
               END AS top,
               COUNT(*), SUM(size)
        FROM files GROUP BY top ORDER BY 3 DESC
        """
    ).fetchall()
    show("D:\\ TOP LEVEL", [(t, f"{c:,}", f"{s/1e9:.2f} GB") for t, c, s in rows],
         ["entry", "files", "bytes"])

    rows = con.execute(
        """
        SELECT CASE
                 WHEN instr(substr(path,20), '\\') = 0 THEN '<file at MusicDatasets root>'
                 ELSE substr(substr(path,20), 1, instr(substr(path,20),'\\')-1)
               END AS top,
               COUNT(*), SUM(size)
        FROM files WHERE path LIKE 'D:\\MusicDatasets\\%' GROUP BY top ORDER BY 3 DESC
        """
    ).fetchall()
    show("D:\\MusicDatasets TOP LEVEL", [(t, f"{c:,}", f"{s/1e9:.2f} GB") for t, c, s in rows],
         ["entry", "files", "bytes"])

elif mode == "ext":
    rows = con.execute(
        "SELECT ext, COUNT(*), SUM(size) FROM files GROUP BY ext ORDER BY 3 DESC LIMIT 30"
    ).fetchall()
    show("BY EXTENSION", [(e or "<none>", f"{c:,}", f"{s/1e9:.2f} GB") for e, c, s in rows],
         ["ext", "files", "bytes"])

elif mode == "big":
    rows = con.execute(
        "SELECT path, size FROM files ORDER BY size DESC LIMIT 40"
    ).fetchall()
    show("LARGEST FILES", [(p, f"{s/1e9:.2f} GB") for p, s in rows], ["path", "size"])

elif mode == "zips":
    rows = con.execute(
        "SELECT path, size, mtime FROM files WHERE ext IN ('.zip','.7z','.rar','.tar','.gz','.tgz','.bz2','.xz') ORDER BY size DESC"
    ).fetchall()
    print(f"count={len(rows)} total={sum(r[1] for r in rows)/1e9:.2f} GB")
    for p, s, m in rows:
        print(f"{s/1e9:10.3f} GB  {p}")

elif mode == "corpus":
    rows = con.execute(
        """
        SELECT substr(substr(path,28), 1, CASE WHEN instr(substr(path,28),'\\')=0 THEN 999
             ELSE instr(substr(path,28),'\\')-1 END) AS sub,
             COUNT(*), SUM(size)
        FROM files WHERE path LIKE 'D:\\MusicDatasets\\corpus_4s\\%'
        GROUP BY sub ORDER BY 2 DESC
        """
    ).fetchall()
    print(f"subdirs={len(rows)} files={sum(r[1] for r in rows):,} bytes={sum(r[2] for r in rows)/1e9:.2f} GB")
    for s, c, b in rows:
        print(f"{c:8,}  {b/1e9:8.3f} GB  {s}")

elif mode == "dirs2":
    prefix = sys.argv[2]
    n = len(prefix) + 1
    rows = con.execute(
        f"""
        SELECT substr(substr(path,{n+1}), 1, CASE WHEN instr(substr(path,{n+1}),'\\')=0 THEN 999
             ELSE instr(substr(path,{n+1}),'\\')-1 END) AS sub,
             COUNT(*), SUM(size)
        FROM files WHERE path LIKE ? GROUP BY sub ORDER BY 3 DESC
        """,
        (prefix + "\\%",),
    ).fetchall()
    print(f"{prefix}: entries={len(rows)} files={sum(r[1] for r in rows):,} bytes={sum(r[2] for r in rows)/1e9:.3f} GB")
    for s, c, b in rows:
        print(f"{c:8,}  {b/1e9:9.4f} GB  {s}")

elif mode == "dupes":
    rows = con.execute(
        """
        SELECT name, size, COUNT(*) c, SUM(size) tot FROM files
        WHERE size > 0 GROUP BY name, size HAVING c > 1 ORDER BY (tot - size) DESC LIMIT 40
        """
    ).fetchall()
    reclaim = con.execute(
        """
        SELECT SUM(tot - size) FROM (
          SELECT size, SUM(size) tot FROM files WHERE size > 0
          GROUP BY name, size HAVING COUNT(*) > 1)
        """
    ).fetchone()[0]
    print(f"potential dup reclaim (name+size, keep one): {reclaim/1e9:.2f} GB")
    for n_, s, c, t in rows:
        print(f"{c:6}x {s/1e6:10.2f} MB  wasted {(t-s)/1e9:8.3f} GB  {n_}")

elif mode == "dupetrees":
    rows = con.execute(
        """
        SELECT a.parent, b.parent, COUNT(*), SUM(a.size) FROM files a JOIN files b
          ON a.name=b.name AND a.size=b.size AND a.parent < b.parent
        WHERE a.size > 0
        GROUP BY a.parent, b.parent HAVING COUNT(*) > 5 ORDER BY 4 DESC LIMIT 40
        """
    ).fetchall()
    for p1, p2, c, s in rows:
        print(f"{c:7,} files  {s/1e9:8.3f} GB\n     {p1}\n     {p2}")
