import sqlite3
import time

conn = sqlite3.connect(
    "file:D:/MusicDatasets/db/corpus_index.sqlite?mode=ro", uri=True, timeout=60
)
conn.row_factory = sqlite3.Row
conn.execute("PRAGMA busy_timeout=60000")

print("-- campaign_files by status --")
for row in conn.execute(
    "SELECT status, COUNT(*) n, COALESCE(SUM(slices_written),0) s "
    "FROM campaign_files GROUP BY status ORDER BY n DESC"
):
    print(f"{row['status']:<14}{row['n']:>9}  slices={row['s']}")

row = conn.execute(
    "SELECT COUNT(*) n, COALESCE(SUM(slices_written),0) s FROM campaign_files"
).fetchone()
print(f"TOTAL         {row['n']:>9}  slices={row['s']}")

print("\n-- campaign_sources by kind/status --")
for row in conn.execute(
    "SELECT kind, status, COUNT(*) n, SUM(total_files) f FROM campaign_sources "
    "GROUP BY kind, status"
):
    print(f"{row['kind']:<10}{row['status']:<10}{row['n']:>5} sources  {row['f']} files")

print("\n-- recent runs --")
for row in conn.execute(
    "SELECT id, mode, workers, started_at, heartbeat_at, finished_at, files_done, "
    "slices_written, note FROM campaign_runs ORDER BY id DESC LIMIT 5"
):
    fmt = lambda v: time.strftime("%H:%M:%S", time.localtime(v)) if v else "-"
    print(
        f"run={row['id']} {row['mode']} w={row['workers']} start={fmt(row['started_at'])} "
        f"hb={fmt(row['heartbeat_at'])} end={fmt(row['finished_at'])} "
        f"files={row['files_done']} slices={row['slices_written']} {row['note']}"
    )

print("\n-- in-flight claims --")
for row in conn.execute(
    "SELECT file_path, claimed_at FROM campaign_files WHERE status='IN_PROGRESS' "
    "ORDER BY claimed_at LIMIT 5"
):
    print(f"  {time.strftime('%H:%M:%S', time.localtime(row['claimed_at']))} {row['file_path']}")

print("\n-- failures (top reasons) --")
for row in conn.execute(
    "SELECT substr(error,1,70) e, COUNT(*) n FROM campaign_files WHERE status='FAILED' "
    "GROUP BY e ORDER BY n DESC LIMIT 8"
):
    print(f"{row['n']:>7}  {row['e']}")

print("\n-- skipped reasons --")
for row in conn.execute(
    "SELECT substr(error,1,60) e, COUNT(*) n FROM campaign_files WHERE status='SKIPPED' "
    "GROUP BY e ORDER BY n DESC LIMIT 8"
):
    print(f"{row['n']:>7}  {row['e']}")

for table in ("oneshot_index", "slice_index"):
    try:
        n = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"\n{table} rows = {n}")
    except Exception as exc:
        print(f"\n{table}: {exc}")

try:
    n = conn.execute(
        "SELECT COUNT(*) FROM slice_index WHERE estimated_bpm IS NULL "
        "OR duration_sec IS NULL OR detected_key IS NULL OR detected_key=''"
    ).fetchone()[0]
    print(f"slice_index rows missing features = {n}")
except Exception as exc:
    print(f"feature gap: {exc}")
