"""Extract eligible sample-pack zips; never fma_full, never into corpus_4s.

Incoming zips go to raw_packs via pack_tracker.extract_zip_to.
Depth-0 zips under D:\\MusicDatasets and D:\\MusicDatasets\\fma extract beside
the archive (same layout as bulk_extract_datasets.ps1).

Skip:
  - fma_full.zip
  - fma_large.zip until it reaches ExpectedBytes
  - empty / tiny zips
  - dest dirs that already contain files
  - ``*.extracted`` markers
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from db.pack_tracker import (  # noqa: E402
    DEFAULT_RAW_PACKS,
    extract_zip_to,
    pack_name_from_zip,
    refused_zip_name,
)

ROOT = Path(r"D:\MusicDatasets")
INCOMING = ROOT / "incoming_zips"
FMA_DIR = ROOT / "fma"
FMA_LARGE = FMA_DIR / "fma_large.zip"
FMA_LARGE_EXPECTED = 100306112191
MIN_BYTES = 1024
FORBIDDEN_DIR_NAMES = frozenset({"corpus_4s", "uploaded_slices", "uploaded_slice", "scratch", "renders"})


def dest_has_files(dest: Path) -> bool:
    if not dest.is_dir():
        return False
    for _root, _dirs, files in os.walk(dest):
        if files:
            return True
    return False


def marker_path(dest: Path) -> Path:
    return Path(str(dest) + ".extracted")


def should_skip_name(name: str) -> str:
    lower = name.lower()
    if lower.startswith("fma_full") or refused_zip_name(name):
        return "fma_full"
    if lower == "fma_large.zip":
        size = FMA_LARGE.stat().st_size if FMA_LARGE.is_file() else 0
        if size < FMA_LARGE_EXPECTED:
            return "fma_large incomplete"
    return ""


def iter_zips() -> list[Path]:
    found: list[Path] = []
    for folder in (INCOMING, ROOT, FMA_DIR):
        if not folder.is_dir():
            continue
        for z in sorted(folder.glob("*.zip")):
            if z.is_file():
                found.append(z)
    return found


def dest_for(zip_path: Path) -> Path:
    if zip_path.parent.resolve() == INCOMING.resolve():
        return Path(DEFAULT_RAW_PACKS) / pack_name_from_zip(zip_path.name)
    return zip_path.with_suffix("")


def write_marker(dest: Path, zip_path: Path, count: int) -> None:
    marker_path(dest).write_text(
        f"source={zip_path}\nsource_bytes={zip_path.stat().st_size}\n"
        f"extracted_utc={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n"
        f"entries={count}\n",
        encoding="utf-8",
    )


def process_one(zip_path: Path, dry_run: bool) -> str:
    reason = should_skip_name(zip_path.name)
    if reason:
        return f"SKIP {reason} {zip_path.name}"
    size = zip_path.stat().st_size
    if size < MIN_BYTES:
        return f"SKIP tiny {zip_path.name} bytes={size}"
    dest = dest_for(zip_path)
    parts = {p.lower() for p in dest.parts}
    if parts & FORBIDDEN_DIR_NAMES:
        return f"SKIP forbidden dest {dest}"
    if marker_path(dest).is_file() or dest_has_files(dest):
        return f"SKIP already {zip_path.name}"
    if dry_run:
        return f"PLAN {zip_path.name} -> {dest} ({size / (1024**3):.2f} GB)"
    dest.mkdir(parents=True, exist_ok=True)
    count = extract_zip_to(str(zip_path), str(dest))
    if count <= 0:
        return f"KEEP empty extract {zip_path.name}"
    write_marker(dest, zip_path, count)
    return f"OK {zip_path.name} files={count} -> {dest}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    dry_run = not args.execute
    print(f"mode={'EXECUTE' if args.execute else 'DRY-RUN'} root={ROOT}")
    ok = skip = fail = 0
    for zip_path in iter_zips():
        try:
            line = process_one(zip_path, dry_run)
        except Exception as exc:
            line = f"FAIL {zip_path.name}: {exc}"
            fail += 1
        else:
            if line.startswith("OK"):
                ok += 1
            elif line.startswith("PLAN"):
                ok += 1
            else:
                skip += 1
        print(line, flush=True)
    print(f"done ok={ok} skip={skip} fail={fail}")
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
