"""Print SQLite journal_mode for the catalog path in argv[1]."""
from __future__ import annotations

import sqlite3
import sys

if len(sys.argv) < 2:
    print("missing", file=sys.stderr)
    sys.exit(2)
conn = sqlite3.connect(sys.argv[1], timeout=5)
try:
    print(conn.execute("PRAGMA journal_mode").fetchone()[0])
finally:
    conn.close()
