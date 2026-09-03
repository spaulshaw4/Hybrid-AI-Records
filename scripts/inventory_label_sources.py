"""Report real per-class counts of label sources under D:\\MusicDatasets.

Read-only. Walks the candidate dataset roots and counts wavs by the label token
that can be recovered from the filename prefix (corpus_4s) or from the stem
filename (musdb18/dsd100 style ``<track>/<stem>.wav``). Prints counts only; it
never opens or moves audio.
"""
from __future__ import annotations

import argparse
import os
import re
from collections import Counter, defaultdict

ROOT = r"D:\MusicDatasets"
CANDIDATES = (
    "corpus_4s",
    "musdb18",
    "dsd100",
    "slakh",
    "medley",
    "openmic",
    "fsd50k",
)
# corpus_4s convention: ``<label>_s4_<track>_<nnn>.wav``
SLICE_RE = re.compile(r"^([a-z]+)_s4_", re.IGNORECASE)


def scan(root: str, max_files: int | None = None) -> tuple[Counter, Counter, int]:
    """Return (label_counts, extension_counts, total_files)."""
    labels: Counter = Counter()
    exts: Counter = Counter()
    total = 0
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            total += 1
            exts[os.path.splitext(name)[1].lower()] += 1
            match = SLICE_RE.match(name)
            if match:
                labels[match.group(1).lower()] += 1
            elif name.lower().endswith((".wav", ".flac", ".mp3", ".ogg")):
                labels[os.path.splitext(name)[0].lower()] += 1
            if max_files is not None and total >= max_files:
                return labels, exts, total
    return labels, exts, total


def source_tracks(root: str) -> dict[str, int]:
    """corpus_4s only: distinct source track ids per label, for split planning."""
    per_label: dict[str, set[str]] = defaultdict(set)
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            match = SLICE_RE.match(name)
            if not match:
                continue
            stem = os.path.splitext(name)[0]
            tail = stem.split("_s4_", 1)[1] if "_s4_" in stem else stem
            track = re.sub(r"_\d+$", "", tail)
            per_label[match.group(1).lower()].add(track)
    return {k: len(v) for k, v in sorted(per_label.items())}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=ROOT)
    parser.add_argument("--max-files", type=int, default=400000)
    args = parser.parse_args(argv)

    for name in CANDIDATES:
        path = os.path.join(args.root, name)
        print(f"\n=== {name} -> {path}")
        if not os.path.isdir(path):
            print("  MISSING")
            continue
        labels, exts, total = scan(path, max_files=args.max_files)
        print(f"  total files: {total}")
        print(f"  extensions: {dict(exts.most_common(8))}")
        print(f"  top label tokens: {dict(labels.most_common(15))}")
        if name == "corpus_4s":
            print(f"  distinct source tracks per label: {source_tracks(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
