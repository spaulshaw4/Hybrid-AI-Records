#!/usr/bin/env python3
"""Validate vault tracks against R2 stem prefixes and write catalog_manifest.json."""
from __future__ import annotations

import glob
import json
import os
import shutil
import sys
from pathlib import Path

from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from stitch_engine import R2_BUCKET_NAME, s3_client

WORKSPACE = Path("/workspace")
ON_POD = WORKSPACE.is_dir()
if ON_POD:
    VAULT_DIR = WORKSPACE / "vault"
    STEMS_DIR = WORKSPACE / "stems_output"
    MANIFEST_FILE = WORKSPACE / "catalog_manifest.json"
else:
    VAULT_DIR = ROOT / ".ingest_vault"
    STEMS_DIR = VAULT_DIR / "stems_output"
    MANIFEST_FILE = VAULT_DIR / "catalog_manifest.json"

EXPECTED_STEMS = ["drums.wav", "bass.wav", "vocals.wav", "other.wav"]


def list_r2_keys_for_track(track_id: str) -> set[str]:
    prefix = f"stems/{track_id}/"
    try:
        response = s3_client.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix=prefix)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in {"NoSuchBucket", "404", "NotFound"}:
            return set()
        raise
    if "Contents" not in response:
        return set()
    return {os.path.basename(obj["Key"]) for obj in response["Contents"]}


def run_validation_and_cleanup() -> None:
    vault_files = sorted(glob.glob(str(VAULT_DIR / "*.mp3")) + glob.glob(str(VAULT_DIR / "*.wav")))
    catalog: dict[str, dict] = {}
    incomplete_tracks: list[tuple[str, list[str]]] = []

    print(f"Validating {len(vault_files)} tracks against Cloudflare R2 ({R2_BUCKET_NAME})...")
    for file_path in vault_files:
        track_id = os.path.splitext(os.path.basename(file_path))[0]
        uploaded_stems = list_r2_keys_for_track(track_id)
        missing = [stem for stem in EXPECTED_STEMS if stem not in uploaded_stems]

        if missing:
            print(f"Track {track_id} missing stems: {missing}")
            incomplete_tracks.append((track_id, missing))
        else:
            print(f"Track {track_id} fully verified (4/4 stems in R2)")

        catalog[track_id] = {
            "status": "complete" if not missing else "partial",
            "available_stems": list(uploaded_stems),
            "missing_stems": missing,
            "r2_prefix": f"stems/{track_id}/",
        }

    MANIFEST_FILE.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_FILE.write_text(json.dumps(catalog, indent=2), encoding="utf-8")
    print(f"\nManifest saved to {MANIFEST_FILE}")

    if ON_POD and STEMS_DIR.is_dir():
        print("Cleaning up intermediate raw WAV stems from local disk...")
        for child in STEMS_DIR.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
        print("Local disk space reclaimed.")

    complete = len(vault_files) - len(incomplete_tracks)
    print(f"\nSummary: {complete}/{len(vault_files)} tracks complete.")


if __name__ == "__main__":
    run_validation_and_cleanup()
