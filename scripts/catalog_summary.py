#!/usr/bin/env python3
"""Print fma_tracks key/BPM distribution after ingest."""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from supabase_indexer import SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, supabase


def main() -> int:
    if not supabase:
        print("Supabase client is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).")
        print(f"url_set={bool(SUPABASE_URL)} key_set={bool(SUPABASE_SERVICE_ROLE_KEY)}")
        return 1

    res = supabase.table("fma_tracks").select("bpm, key_signature").execute()
    rows = res.data or []
    print(f"Total Stems Indexed: {len(rows)}")

    keys = Counter(r["key_signature"] for r in rows if r.get("key_signature"))
    print("\nTop 5 Harmonic Keys:")
    for key, count in keys.most_common(5):
        print(f"  - {key}: {count} tracks")

    bpms = [r["bpm"] for r in rows if r.get("bpm") is not None]
    if bpms:
        print(f"\nBPM Range: {min(bpms)} - {max(bpms)} (Avg: {sum(bpms) / len(bpms):.1f})")
    else:
        print("\nNo BPM values indexed yet.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
