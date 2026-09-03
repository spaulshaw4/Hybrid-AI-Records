"""Assemble a session release folder: WAV/FLAC/MP3/peaks + SHA-256 manifest.

Matches the workstation layout used by ``run_production_pipeline.ps1`` and
``sync_release_distro.py``:

    D:\\MusicDatasets\\releases\\<session_id>\\
        master_output.wav
        master_output.flac
        master_output.mp3
        master_output.m4a          # encoder writes AAC as .m4a
        master_output.peaks.json
        distribution_manifest.json
        master_output_qc_report.json

The master WAV is required. Companion files are optional — missing ones are
WARN-skipped. Extra AAC / distro-manifest globs are accepted so a session-named
stem (not only ``master_output.*``) still packages.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_OUT_ROOT = Path(os.environ.get("HYBRID_BASE_DIR", r"D:\MusicDatasets")) / "releases"
CANONICAL_MASTER = "master_output.wav"
COMPANION_SUFFIXES = (".flac", ".mp3", ".m4a", ".aac")
PEAKS_NAMES = ("{stem}.peaks.json", "peaks.json", "{stem}_peaks.json")
EXTRA_NAMES = ("distribution_manifest.json", "{stem}_qc_report.json")


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def resolve_session_dir(session_id: str, session_dir: str | None) -> Path:
    if session_dir:
        return Path(session_dir)
    base = Path(os.environ.get("HYBRID_BASE_DIR", r"D:\MusicDatasets"))
    release = base / "releases" / session_id
    scratch = base / "scratch" / session_id
    if release.is_dir():
        return release
    if scratch.is_dir():
        return scratch
    return release


def find_master_wav(session_dir: Path) -> Path | None:
    canonical = session_dir / CANONICAL_MASTER
    if canonical.is_file():
        return canonical
    masters = sorted(p for p in session_dir.glob("*.wav") if p.is_file() and not p.name.startswith("."))
    preferred = [p for p in masters if "master" in p.stem.lower()]
    if preferred:
        return preferred[0]
    return masters[0] if masters else None


def collect_companions(session_dir: Path, master: Path) -> tuple[list[Path], list[str]]:
    """Return (existing files including master, warn messages for missing optionals)."""
    stem = master.stem
    wanted: list[Path] = [master]
    missing: list[str] = []

    for suffix in COMPANION_SUFFIXES:
        candidate = session_dir / f"{stem}{suffix}"
        if candidate.is_file():
            wanted.append(candidate)
        else:
            missing.append(str(candidate.name))

    for template in PEAKS_NAMES:
        candidate = session_dir / template.format(stem=stem)
        if candidate.is_file():
            wanted.append(candidate)
            break
    else:
        missing.append(f"{stem}.peaks.json")

    for template in EXTRA_NAMES:
        candidate = session_dir / template.format(stem=stem)
        if candidate.is_file():
            wanted.append(candidate)
        elif template == "distribution_manifest.json":
            missing.append(template)

    seen = {p.resolve() for p in wanted}
    for pattern in ("*.flac", "*.mp3", "*.m4a", "*.aac", "*peaks*.json", "distribution_manifest.json"):
        for extra in session_dir.glob(pattern):
            if extra.is_file() and extra.resolve() not in seen:
                wanted.append(extra)
                seen.add(extra.resolve())

    return wanted, missing


def package_release(
    session_id: str,
    session_dir: Path,
    out_root: Path,
    *,
    dry_run: bool = False,
    force: bool = False,
) -> dict:
    if not session_dir.is_dir():
        raise FileNotFoundError(f"Session directory not found: {session_dir}")

    master = find_master_wav(session_dir)
    if master is None:
        raise FileNotFoundError(
            f"Master WAV missing in {session_dir} (expected {CANONICAL_MASTER} or a *master*.wav)"
        )

    dest_dir = out_root / session_id
    dest_exists = dest_dir.is_dir() and any(dest_dir.iterdir())
    files, missing = collect_companions(session_dir, master)

    for name in missing:
        print(f"[WARN] optional companion missing, skipped: {name}")

    planned: list[dict] = []
    for src in files:
        dest = dest_dir / src.name
        exists = dest.is_file()
        action = "skip-existing"
        if src.resolve() == dest.resolve():
            action = "in-place"
        elif exists and not force:
            action = "skip-existing"
        else:
            action = "copy"
        planned.append(
            {
                "name": src.name,
                "src": str(src),
                "dest": str(dest),
                "action": action,
                "sha256": sha256_file(src) if src.is_file() else "",
            }
        )

    manifest = {
        "sessionId": session_id,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceDir": str(session_dir),
        "outputDir": str(dest_dir),
        "master": master.name,
        "dryRun": dry_run,
        "files": [
            {"name": item["name"], "sha256": item["sha256"], "action": item["action"]} for item in planned
        ],
    }

    print(f"[PACKAGE] session={session_id}  dest={dest_dir}  files={len(planned)}")
    if dest_exists and not force:
        print("[PACKAGE] dest exists — writing copies / updating manifest (no directory wipe)")

    if dry_run:
        for item in planned:
            print(f"  [{item['action']}] {item['name']}  {item['sha256'][:12]}...")
        print("[DRY-RUN] manifest not written")
        return manifest

    dest_dir.mkdir(parents=True, exist_ok=True)
    for item in planned:
        dest = Path(item["dest"])
        src = Path(item["src"])
        if item["action"] == "copy":
            dest.write_bytes(src.read_bytes())
            print(f"  [copy] {item['name']}  {item['sha256'][:12]}...")
        elif item["action"] == "in-place":
            print(f"  [in-place] {item['name']}  {item['sha256'][:12]}...")
        else:
            print(f"  [skip] {item['name']} already in dest (pass --force to replace)")

    atomic_write_json(dest_dir / "release_checksums.json", manifest)
    print(f"[SUCCESS] {dest_dir / 'release_checksums.json'}")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Package WAV/FLAC/MP3/peaks into a session release with a SHA-256 manifest"
    )
    parser.add_argument("-s", "--session-id", required=True, help="Release session id (dest folder name)")
    parser.add_argument(
        "--session-dir",
        default=None,
        help="Source folder. Defaults to D:\\MusicDatasets\\releases\\<id> then scratch\\<id>",
    )
    parser.add_argument(
        "--out-root",
        default=str(DEFAULT_OUT_ROOT),
        help=f"Destination root (default {DEFAULT_OUT_ROOT})",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing dest files of the same name. Never rmtree the session dir.",
    )
    parser.add_argument("--dry-run", action="store_true", help="List copies and checksums without writing")
    args = parser.parse_args()

    session_dir = resolve_session_dir(args.session_id, args.session_dir)
    try:
        package_release(
            args.session_id,
            session_dir,
            Path(args.out_root),
            dry_run=args.dry_run,
            force=args.force,
        )
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
