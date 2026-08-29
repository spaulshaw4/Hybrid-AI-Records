# D:\MusicDatasets\scripts\enterprise_catalog_packager.py
"""
===============================================================================
HYBRID 1.0 - ENTERPRISE DISTRIBUTION CATALOG PACKAGER
===============================================================================
Assembles rendered masters into a release package: audio, a metadata CSV with
UPC/ISRC mappings, and a checksum registry.

  <album>_export/
    masters/NN_Title.wav
    metadata_manifest.csv
    release_checksums.json

Identifiers are validated rather than assumed. A malformed UPC or ISRC is
rejected at packaging time, because distributors reject the whole delivery and
the error message rarely says which field was wrong.

QC figures are pulled from the sidecar <master>_qc_report.json when present, so
the manifest carries the measured loudness and true peak that gated the upload
rather than re-deriving them.
"""

import os
import sys
import csv
import json
import wave
import shutil
import hashlib
import argparse
import re
from pathlib import Path
from datetime import datetime, timezone

SCRIPTS_DIR = Path(__file__).resolve().parent
DEFAULT_EXPORT_ROOT = Path(os.environ.get("HYBRID_BASE_DIR", r"D:\MusicDatasets")) / "distribution_exports"

# ISRC: 2-char country, 3-char registrant, 2-digit year, 5-digit designation
ISRC_PATTERN = re.compile(r"^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$")

CSV_FIELDS = [
    "UPC", "Album Title", "Track Number", "Track Title", "Primary Artist",
    "Label", "ISRC", "Genre", "Duration (s)", "Format", "Audio File Name",
    "SHA-256", "Integrated LUFS", "True Peak dBTP", "Release Date",
]


def normalise_isrc(raw: str) -> str:
    """Strip hyphens to the 12-character canonical form."""
    return raw.replace("-", "").upper()


def validate_upc(upc: str) -> tuple[bool, str]:
    """
    UPC-A is 12 digits, EAN-13 is 13, both with a mod-10 check digit.

    Distributors reject a delivery outright on a bad check digit, so it is
    cheaper to catch here than after upload.
    """
    digits = upc.strip()
    if not digits.isdigit():
        return False, "must be digits only"
    if len(digits) not in (12, 13):
        return False, f"must be 12 or 13 digits, got {len(digits)}"

    body, check = digits[:-1], int(digits[-1])

    # Weight 3 on the rightmost body digit, alternating outward
    total = 0
    for i, ch in enumerate(reversed(body)):
        total += int(ch) * (3 if i % 2 == 0 else 1)

    expected = (10 - (total % 10)) % 10
    if expected != check:
        return False, f"check digit is {check}, expected {expected}"

    return True, "ok"


def validate_isrc(isrc: str) -> tuple[bool, str]:
    if not ISRC_PATTERN.match(isrc.upper()):
        return False, "expected CCXXXYYNNNNN (country, registrant, year, designation)"
    if len(normalise_isrc(isrc)) != 12:
        return False, f"canonical form must be 12 characters, got {len(normalise_isrc(isrc))}"
    return True, "ok"


def generate_sha256(filepath: Path) -> str:
    hasher = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


def inspect_audio_metadata(filepath: Path) -> dict:
    with wave.open(str(filepath), "rb") as w:
        frames = w.getnframes()
        rate = w.getframerate()
        channels = w.getnchannels()
        sampwidth = w.getsampwidth()

    return {
        "duration_sec": round(frames / float(rate), 2) if rate else 0.0,
        "sample_rate": rate,
        "bit_depth": sampwidth * 8,
        "channels": "Stereo" if channels == 2 else ("Mono" if channels == 1 else f"{channels}ch"),
        "frames": frames,
    }


def load_qc_sidecar(master_path: Path) -> dict:
    """
    Read <master>_qc_report.json if the analyzer left one.

    Reusing the gating measurement keeps the manifest consistent with the
    decision that let the master through, instead of a second measurement that
    could differ.
    """
    sidecar = master_path.with_name(master_path.stem + "_qc_report.json")
    if not sidecar.exists():
        return {}

    try:
        with open(sidecar, "r", encoding="utf-8") as f:
            report = json.load(f)
        metrics = report.get("metrics", {})
        return {
            "lufs": metrics.get("integrated_lufs"),
            "true_peak": metrics.get("true_peak_dbtp"),
        }
    except Exception:
        return {}


def safe_filename(title: str) -> str:
    """Strip characters that break on Windows or in a CSV path column."""
    cleaned = re.sub(r'[<>:"/\\|?*]', "", title)
    return re.sub(r"\s+", "_", cleaned).strip("_")


class EnterpriseCatalogPackager:
    def __init__(self, record_label="Hybrid AI Records LLC", export_root=None):
        self.record_label = record_label
        self.export_root = Path(export_root) if export_root else DEFAULT_EXPORT_ROOT
        self.export_root.mkdir(parents=True, exist_ok=True)

    def package_album_release(self, album_title, upc_code, release_date,
                              primary_genre, master_files, artist=None,
                              strict=True):
        upc_ok, upc_msg = validate_upc(upc_code)
        if not upc_ok:
            msg = f"UPC '{upc_code}' invalid: {upc_msg}"
            if strict:
                raise ValueError(msg)
            print(f"  [WARN] {msg}")

        try:
            datetime.strptime(release_date, "%Y-%m-%d")
        except ValueError:
            raise ValueError(f"release_date '{release_date}' must be YYYY-MM-DD")

        if not master_files:
            raise ValueError("No master files supplied.")

        album_slug = safe_filename(album_title).lower()
        release_folder = self.export_root / f"{album_slug}_export"
        masters_folder = release_folder / "masters"
        masters_folder.mkdir(parents=True, exist_ok=True)

        print(f"\n[PACKAGER] {album_title}  UPC {upc_code}  ({upc_msg})")
        print(f"[PACKAGER] Export root: {release_folder}")

        csv_rows = []
        checksums = {}
        missing = []
        seen_isrc = set()

        for item in sorted(master_files, key=lambda x: x["track_number"]):
            track_num = int(item["track_number"])
            track_title = item["track_title"]
            src = Path(item["source_path"])

            if not src.exists():
                missing.append(f"track {track_num:02d} '{track_title}': {src}")
                continue

            isrc = item.get("isrc") or f"QZHYB26{track_num:05d}"
            isrc_ok, isrc_msg = validate_isrc(isrc)
            if not isrc_ok:
                msg = f"ISRC '{isrc}' on track {track_num}: {isrc_msg}"
                if strict:
                    raise ValueError(msg)
                print(f"  [WARN] {msg}")

            canonical_isrc = normalise_isrc(isrc)
            if canonical_isrc in seen_isrc:
                raise ValueError(f"Duplicate ISRC {canonical_isrc} on track {track_num}. "
                                 f"Every recording needs a unique code.")
            seen_isrc.add(canonical_isrc)

            dest_name = f"{track_num:02d}_{safe_filename(track_title)}.wav"
            dest = masters_folder / dest_name

            shutil.copy2(src, dest)

            meta = inspect_audio_metadata(dest)
            qc = load_qc_sidecar(src)
            sha = generate_sha256(dest)
            checksums[dest_name] = sha

            csv_rows.append({
                "UPC": upc_code,
                "Album Title": album_title,
                "Track Number": track_num,
                "Track Title": track_title,
                "Primary Artist": item.get("artist") or artist or self.record_label,
                "Label": self.record_label,
                "ISRC": canonical_isrc,
                "Genre": item.get("genre") or primary_genre,
                "Duration (s)": meta["duration_sec"],
                "Format": f"{meta['bit_depth']}-bit/{meta['sample_rate']}Hz {meta['channels']}",
                "Audio File Name": dest_name,
                "SHA-256": sha,
                "Integrated LUFS": qc.get("lufs", ""),
                "True Peak dBTP": qc.get("true_peak", ""),
                "Release Date": release_date,
            })

            qc_note = (f"  LUFS {qc['lufs']}  TP {qc['true_peak']}"
                       if qc.get("lufs") is not None else "  (no QC sidecar)")
            print(f"  {track_num:02d}  {track_title[:34]:<34} {meta['duration_sec']:>7.2f}s"
                  f"  {sha[:12]}...{qc_note}")

        if missing:
            print(f"\n  [ERROR] {len(missing)} master(s) not found:")
            for m in missing:
                print(f"    {m}")
            if strict:
                raise FileNotFoundError(f"{len(missing)} master(s) missing; nothing was packaged.")

        if not csv_rows:
            raise ValueError("No tracks were packaged.")

        manifest_path = release_folder / "metadata_manifest.csv"
        with open(manifest_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
            writer.writeheader()
            writer.writerows(csv_rows)

        checksums_path = release_folder / "release_checksums.json"
        with open(checksums_path, "w", encoding="utf-8") as f:
            json.dump({
                "album_title": album_title,
                "upc": upc_code,
                "packaged_at": datetime.now(timezone.utc).isoformat(),
                "track_count": len(csv_rows),
                "checksums": checksums,
            }, f, indent=2)

        total_mb = sum((masters_folder / r["Audio File Name"]).stat().st_size
                       for r in csv_rows) / (1024 * 1024)
        total_sec = sum(r["Duration (s)"] for r in csv_rows)

        print(f"\n[SUCCESS] {len(csv_rows)} track(s) packaged")
        print(f"  runtime  : {int(total_sec // 60)}:{int(total_sec % 60):02d}")
        print(f"  audio    : {total_mb:.1f} MB")
        print(f"  manifest : {manifest_path}")
        print(f"  checksums: {checksums_path}")

        return release_folder

    def verify_package(self, release_folder):
        """Re-hash every file and compare against the recorded registry."""
        release_folder = Path(release_folder)
        checksums_path = release_folder / "release_checksums.json"

        if not checksums_path.exists():
            print(f"[VERIFY] No checksum registry at {checksums_path}")
            return False

        with open(checksums_path, "r", encoding="utf-8") as f:
            registry = json.load(f)

        recorded = registry.get("checksums", {})
        masters = release_folder / "masters"

        print(f"[VERIFY] {registry.get('album_title')} - {len(recorded)} file(s)")

        ok = True
        for name, expected in recorded.items():
            path = masters / name
            if not path.exists():
                print(f"  MISSING  {name}")
                ok = False
                continue
            actual = generate_sha256(path)
            if actual == expected:
                print(f"  OK       {name}")
            else:
                print(f"  MISMATCH {name}")
                print(f"           expected {expected}")
                print(f"           actual   {actual}")
                ok = False

        print(f"[VERIFY] {'all files intact' if ok else 'INTEGRITY FAILURE'}")
        return ok


def main():
    parser = argparse.ArgumentParser(description="Hybrid 1.0 distribution catalog packager")
    sub = parser.add_subparsers(dest="command")

    pack = sub.add_parser("package", help="Package an album from a track list JSON")
    pack.add_argument("tracklist", help="JSON with album fields and a tracks array")
    pack.add_argument("--export-root", default=None)
    pack.add_argument("--label", default="Hybrid AI Records LLC")
    pack.add_argument("--lenient", action="store_true",
                      help="Warn on invalid identifiers instead of refusing")

    verify = sub.add_parser("verify", help="Re-hash a package against its registry")
    verify.add_argument("release_folder")

    check = sub.add_parser("check-ids", help="Validate a UPC and optional ISRCs")
    check.add_argument("upc")
    check.add_argument("isrcs", nargs="*")

    args = parser.parse_args()

    if args.command == "check-ids":
        ok, msg = validate_upc(args.upc)
        print(f"UPC  {args.upc:<16} {'valid' if ok else 'INVALID'}  ({msg})")
        for isrc in args.isrcs:
            iok, imsg = validate_isrc(isrc)
            print(f"ISRC {isrc:<16} {'valid' if iok else 'INVALID'}  ({imsg})")
        return 0

    if args.command == "verify":
        packager = EnterpriseCatalogPackager()
        return 0 if packager.verify_package(args.release_folder) else 1

    if args.command == "package":
        with open(args.tracklist, "r", encoding="utf-8") as f:
            spec = json.load(f)

        packager = EnterpriseCatalogPackager(record_label=args.label,
                                            export_root=args.export_root)
        packager.package_album_release(
            album_title=spec["album_title"],
            upc_code=spec["upc"],
            release_date=spec["release_date"],
            primary_genre=spec.get("genre", "Alternative Rock"),
            master_files=spec["tracks"],
            artist=spec.get("artist"),
            strict=not args.lenient,
        )
        return 0

    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
