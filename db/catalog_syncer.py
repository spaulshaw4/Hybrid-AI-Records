"""Upsert public_catalog from release_manifest.json files. SQLite only.

Does not touch the website Catalog tab. Stream URL is a local path or
``/api/stream/{mp3}`` string stored in the row — no frontend update is claimed.
Also upserts ``slice_index`` file_path rows when a ledger-style stems list exists.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_RELEASES = Path(os.environ.get("HYBRID_BASE_DIR", r"D:\MusicDatasets")) / "releases"
DEFAULT_DB = Path(os.environ.get("HYBRID_BASE_DIR", r"D:\MusicDatasets")) / "db" / "catalog.sqlite"

PUBLIC_CATALOG_DDL = """
CREATE TABLE IF NOT EXISTS public_catalog (
    session_id TEXT PRIMARY KEY,
    title TEXT,
    bpm REAL,
    key TEXT,
    genre TEXT,
    master_wav TEXT,
    master_mp3 TEXT,
    stream_url TEXT,
    local_path TEXT,
    manifest_path TEXT,
    sha256 TEXT,
    updated_at TEXT
);
"""

SLICE_INDEX_DDL = """
CREATE TABLE IF NOT EXISTS slice_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE,
    filename TEXT,
    stem_type TEXT,
    detected_key TEXT,
    estimated_bpm REAL,
    rms_db REAL,
    spectral_centroid REAL,
    tags TEXT,
    duration_sec REAL
);
"""


def init_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute(PUBLIC_CATALOG_DDL)
    conn.execute(SLICE_INDEX_DDL)
    conn.commit()
    return conn


def _stream_fields(manifest: dict, release_dir: Path) -> tuple[str | None, str | None]:
    mp3 = None
    wav = None
    for asset in manifest.get("assets") or []:
        name = str(asset.get("filename") or "")
        lower = name.lower()
        if lower.endswith(".mp3") and mp3 is None:
            mp3 = name
        if lower.endswith(".wav") and "master" in lower and wav is None:
            wav = name
    local = None
    if mp3 and (release_dir / mp3).is_file():
        local = str(release_dir / mp3)
    elif wav and (release_dir / wav).is_file():
        local = str(release_dir / wav)
    stream = f"/api/stream/{mp3}" if mp3 else (local or "")
    return stream, local


def sync_releases(releases: Path, db_path: Path, dry_run: bool = False) -> int:
    if not releases.is_dir():
        print(f"[CATALOG] releases dir missing ({releases}) — 0 synced")
        return 0
    manifests = sorted(releases.rglob("release_manifest.json"))
    if not manifests:
        print(f"[CATALOG] no release_manifest.json under {releases} — 0 synced")
        return 0
    if dry_run:
        for path in manifests:
            print(f"  [would-upsert] {path}")
        print(f"[DRY-RUN] {len(manifests)} manifests, 0 written")
        return 0

    conn = init_db(db_path)
    synced = 0
    upsert = """
    INSERT INTO public_catalog (
        session_id, title, bpm, key, genre, master_wav, master_mp3,
        stream_url, local_path, manifest_path, sha256, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
        title=excluded.title,
        bpm=excluded.bpm,
        key=excluded.key,
        genre=excluded.genre,
        master_wav=excluded.master_wav,
        master_mp3=excluded.master_mp3,
        stream_url=excluded.stream_url,
        local_path=excluded.local_path,
        manifest_path=excluded.manifest_path,
        sha256=excluded.sha256,
        updated_at=excluded.updated_at
    """
    for path in manifests:
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[WARN] skip {path}: {exc}")
            continue
        session_id = str(manifest.get("session_id") or path.parent.name)
        stream, local = _stream_fields(manifest, path.parent)
        assets = manifest.get("assets") or []
        wav_name = next((a.get("filename") for a in assets if str(a.get("filename", "")).endswith(".wav")), None)
        mp3_name = next((a.get("filename") for a in assets if str(a.get("filename", "")).endswith(".mp3")), None)
        sha = next((a.get("sha256") for a in assets if a.get("sha256")), "")
        conn.execute(
            upsert,
            (
                session_id,
                manifest.get("title"),
                manifest.get("bpm"),
                manifest.get("key"),
                manifest.get("genre"),
                wav_name,
                mp3_name,
                stream,
                local,
                str(path),
                sha,
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        for asset in assets:
            if asset.get("role") != "stem":
                continue
            filename = asset.get("filename")
            if not filename:
                continue
            stem_path = path.parent / "stems" / filename
            if not stem_path.is_file():
                stem_path = path.parent / filename
            if not stem_path.is_file():
                continue
            conn.execute(
                """
                INSERT INTO slice_index (file_path, filename, stem_type, tags)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(file_path) DO UPDATE SET filename=excluded.filename
                """,
                (str(stem_path), filename, str(asset.get("role") or "unknown"), session_id),
            )
        synced += 1
    conn.commit()
    conn.close()
    print(f"[CATALOG] synced {synced} rows into {db_path}")
    return synced


def main() -> int:
    parser = argparse.ArgumentParser(description="Upsert public_catalog from release manifests (SQLite only)")
    parser.add_argument("--releases", default=str(DEFAULT_RELEASES))
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    count = sync_releases(Path(args.releases), Path(args.db), dry_run=args.dry_run)
    print(json.dumps({"synced": count, "dryRun": args.dry_run}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
