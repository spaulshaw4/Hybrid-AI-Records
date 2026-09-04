"""Index locked DSP slices into a stratified train/val/test manifest.

Writes both an SQLite ledger (fast split/label queries) and a JSONL
sidecar for streaming consumers that prefer line-oriented IO.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import random
import sqlite3
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

DEFAULT_LOCKED_DIR = r"D:\MusicDatasets\mtg\corpus_4s_dsp_locked"
DEFAULT_MANIFEST_DB = os.path.join(REPO, "reports", "dataset_manifest.sqlite")
DEFAULT_MANIFEST_JSONL = os.path.join(REPO, "reports", "dataset_manifest.jsonl")

STEM_LABEL_MAP = {
    "acoustic": 0,
    "voice": 1,
    "electric": 2,
    "beats": 3,
    "bass": 4,
}


def extract_label_from_filename(filename: str) -> tuple[str, int]:
    for stem, label_id in STEM_LABEL_MAP.items():
        if f"_{stem}_locked" in filename:
            return stem, label_id
    return "unknown", -1


def build_manifest(
    locked_dir: str = DEFAULT_LOCKED_DIR,
    manifest_db: str = DEFAULT_MANIFEST_DB,
    manifest_jsonl: str = DEFAULT_MANIFEST_JSONL,
    val_ratio: float = 0.10,
    test_ratio: float = 0.05,
    seed: int = 42,
) -> int:
    random.seed(seed)

    os.makedirs(os.path.dirname(manifest_db) or ".", exist_ok=True)
    os.makedirs(os.path.dirname(manifest_jsonl) or ".", exist_ok=True)

    conn = sqlite3.connect(manifest_db)
    cursor = conn.cursor()
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS manifest (
            slice_path TEXT PRIMARY KEY,
            stem_class TEXT,
            label_id INTEGER,
            split_group TEXT
        )
        """
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_split ON manifest(split_group)"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_label ON manifest(label_id)"
    )

    print(f"Indexing locked files in: {locked_dir}")
    all_files = sorted(
        glob.glob(
            os.path.join(locked_dir, "**", "*_locked.wav"), recursive=True
        )
    )
    print(f"Found {len(all_files):,} locked slices.")

    # Preserve prior split assignments so continuous re-indexes do not
    # reshuffle train/val/test when the corpus grows mid-training.
    existing_splits: dict[str, str] = {}
    cursor.execute("SELECT slice_path, split_group FROM manifest")
    for path, split_group in cursor.fetchall():
        existing_splits[path] = split_group

    records: list[tuple[str, str, int, str]] = []
    jsonl_lines: list[str] = []
    new_count = 0

    for file_path in all_files:
        filename = os.path.basename(file_path)
        stem, label_id = extract_label_from_filename(filename)
        if label_id == -1:
            continue

        if file_path in existing_splits:
            split = existing_splits[file_path]
        else:
            new_count += 1
            r = random.random()
            if r < test_ratio:
                split = "test"
            elif r < test_ratio + val_ratio:
                split = "val"
            else:
                split = "train"

        records.append((file_path, stem, label_id, split))
        jsonl_lines.append(
            json.dumps(
                {
                    "path": file_path,
                    "stem": stem,
                    "label": label_id,
                    "split": split,
                }
            )
            + "\n"
        )

    if new_count:
        print(f"  newly assigned: {new_count:,}")

    cursor.executemany(
        """
        INSERT OR REPLACE INTO manifest
            (slice_path, stem_class, label_id, split_group)
        VALUES (?, ?, ?, ?)
        """,
        records,
    )
    conn.commit()

    # Split census for a quick sanity check
    cursor.execute(
        """
        SELECT split_group, COUNT(*) FROM manifest
        GROUP BY split_group ORDER BY split_group
        """
    )
    for split_name, count in cursor.fetchall():
        print(f"  {split_name}: {count:,}")

    conn.close()

    with open(manifest_jsonl, "w", encoding="utf-8") as f:
        f.writelines(jsonl_lines)

    print(f"Committed {len(records):,} records to {manifest_db}")
    print(f"JSONL sidecar: {manifest_jsonl}")
    return len(records)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build stratified train/val/test manifest from locked DSP slices."
    )
    parser.add_argument("--locked-dir", default=DEFAULT_LOCKED_DIR)
    parser.add_argument("--manifest-db", default=DEFAULT_MANIFEST_DB)
    parser.add_argument("--manifest-jsonl", default=DEFAULT_MANIFEST_JSONL)
    parser.add_argument("--val-ratio", type=float, default=0.10)
    parser.add_argument("--test-ratio", type=float, default=0.05)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if not os.path.isdir(args.locked_dir):
        print(f"Locked dir not found: {args.locked_dir}", file=sys.stderr)
        return 1

    n = build_manifest(
        locked_dir=args.locked_dir,
        manifest_db=args.manifest_db,
        manifest_jsonl=args.manifest_jsonl,
        val_ratio=args.val_ratio,
        test_ratio=args.test_ratio,
        seed=args.seed,
    )
    return 0 if n > 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
