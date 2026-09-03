"""Zip an album folder for distribution. Optional FLAC from WAV.

Does not invent masters. Missing album dir exits 1 with a message.
"""
from __future__ import annotations

import argparse
import os
import sys
import zipfile
from pathlib import Path

SKIP_NAMES = {".ds_store", "thumbs.db", "desktop.ini"}
SKIP_SUFFIXES = {".tmp", ".temp", ".log", ".pyc"}
MAX_UNEXPECTED_BYTES = 80 * 1024 * 1024
AUDIO_OK = {".wav", ".flac", ".mp3", ".m4a", ".aac", ".json", ".txt", ".cue", ".pdf", ".jpg", ".png"}

_HERE = os.path.dirname(os.path.abspath(__file__))
_PARENT = os.path.abspath(os.path.join(_HERE, ".."))
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)


def wav_to_flac(wav_path: Path, flac_path: Path) -> bool:
    try:
        import soundfile as sf
    except ImportError:
        return False
    try:
        audio, sr = sf.read(str(wav_path), always_2d=True)
        sf.write(str(flac_path), audio, int(sr), format="FLAC")
        return True
    except Exception:
        return False


def _should_skip(path: Path, album: Path) -> bool:
    name = path.name.lower()
    if name in SKIP_NAMES or path.suffix.lower() in SKIP_SUFFIXES:
        return True
    if path.is_file() and path.suffix.lower() not in AUDIO_OK:
        try:
            if path.stat().st_size > MAX_UNEXPECTED_BYTES:
                print(f"[SKIP] unexpected large file: {path.relative_to(album)}")
                return True
        except OSError:
            return True
    return False


def ensure_flac_companions(album: Path, dry_run: bool) -> list[str]:
    notes: list[str] = []
    for wav in sorted(album.rglob("*.wav")):
        if _should_skip(wav, album):
            continue
        flac = wav.with_suffix(".flac")
        if flac.is_file():
            notes.append(f"flac-exists {flac.name}")
            continue
        if dry_run:
            notes.append(f"would-flac {wav.name} -> {flac.name}")
            continue
        if wav_to_flac(wav, flac):
            notes.append(f"flac {flac.name}")
        else:
            notes.append(f"flac-skip {wav.name} (soundfile encode failed; not fatal)")
    return notes


def zip_album(album: Path, out_zip: Path, dry_run: bool) -> int:
    planned: list[Path] = []
    for path in sorted(album.rglob("*")):
        if not path.is_file():
            continue
        if _should_skip(path, album):
            continue
        planned.append(path)
    print(f"[DISTRO] album={album} files={len(planned)} zip={out_zip}")
    if dry_run:
        for path in planned:
            print(f"  [would-zip] {path.relative_to(album)}")
        print("[DRY-RUN] zip not written")
        return 0
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in planned:
            zf.write(path, arcname=str(path.relative_to(album)))
    print(f"[SUCCESS] {out_zip}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="FLAC companions + zip an album directory")
    parser.add_argument("--album", required=True, help="Existing album folder")
    parser.add_argument("--out-zip", required=True, help="Destination zip path")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-flac", action="store_true", help="Zip only; do not encode missing FLAC")
    args = parser.parse_args()
    album = Path(args.album)
    if not album.is_dir():
        print(f"[ERROR] album directory missing: {album}", file=sys.stderr)
        return 1
    if not args.skip_flac:
        for note in ensure_flac_companions(album, args.dry_run):
            print(f"  [{note}]")
    return zip_album(album, Path(args.out_zip), args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
