import sqlite3
import time
import datetime

uri = r"file:D:/MusicDatasets/db/corpus_index.sqlite?mode=ro&nolock=1"
con = sqlite3.connect(uri, uri=True, timeout=2)
con.row_factory = sqlite3.Row
now = time.time()
print("now", datetime.datetime.fromtimestamp(now).isoformat(timespec="seconds"))
d = dict(
    con.execute(
        "SELECT id,pid,files_done,slices_written,started_at,heartbeat_at "
        "FROM campaign_runs WHERE id=(SELECT MAX(id) FROM campaign_runs)"
    ).fetchone()
)
print(
    "run",
    d["id"],
    "pid",
    d["pid"],
    "files_done",
    d["files_done"],
    "slices",
    d["slices_written"],
)
print("started", datetime.datetime.fromtimestamp(d["started_at"]).isoformat(timespec="seconds"))
print(
    "heartbeat",
    datetime.datetime.fromtimestamp(d["heartbeat_at"]).isoformat(timespec="seconds"),
    "age_min",
    round((now - d["heartbeat_at"]) / 60, 1),
)
rows = list(
    con.execute(
        "SELECT status, COUNT(*) n, COALESCE(SUM(slices_written),0) slices "
        "FROM campaign_files WHERE campaign='corpus_4s_bulk' GROUP BY status"
    )
)
counts = {x["status"]: x["n"] for x in rows}
for x in rows:
    print(dict(x))
total = sum(x["n"] for x in rows)
settled = counts.get("DONE", 0) + counts.get("SKIPPED", 0) + counts.get("FAILED", 0)
left = counts.get("PENDING", 0) + counts.get("IN_PROGRESS", 0)
print(f"total={total} settled={settled} ({100 * settled / total:.2f}%) left={left} ({100 * left / total:.2f}%)")
elapsed = now - d["started_at"]
rate = d["files_done"] / max(elapsed, 1)
print(f"this_run_rate={rate:.3f} files/s eta_h={left / max(rate, 1e-9) / 3600:.1f}")
