#!/usr/bin/env python3
"""Rolling GPU ingest: Demucs → R2 → delete local source so disk stays near empty.

On the Runpod volume:
  python /workspace/scripts/batch_stream_ingest.py

Locally (does not delete sources unless --purge-source):
  python scripts/batch_stream_ingest.py --limit 1
"""
from __future__ import annotations

import argparse
import glob
import os
import shutil
import subprocess
import sys
from pathlib import Path

from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from r2_uploader import R2_BUCKET_NAME, s3_client, upload_stems_parallel

WORKSPACE = Path("/workspace")
ON_POD = WORKSPACE.is_dir()
VAULT_DIR = WORKSPACE / "vault" if ON_POD else ROOT / ".ingest_vault"
OUTPUT_DIR = WORKSPACE / "stems_output" if ON_POD else VAULT_DIR / "stems_output"
EXPECTED_STEMS = ("drums.wav", "bass.wav", "vocals.wav", "other.wav")


def demucs_cmd() -> list[str]:
    if shutil.which("demucs"):
        return ["demucs"]
    return [sys.executable, "-m", "demucs"]


def pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def r2_has_stem(track_id: str, stem_name: str) -> bool:
    key = f"stems/{track_id}/{stem_name}"
    try:
        s3_client.head_object(Bucket=R2_BUCKET_NAME, Key=key)
        return True
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in {"404", "NotFound", "NoSuchKey", "NoSuchBucket"}:
            return False
        raise


def upload_stem(local_path: str, remote_key: str) -> None:
    upload_file_to_r2_fast(local_path, remote_key, content_type="audio/wav")
    print(f"  --> Uploaded: {remote_key}")


def purge_dir(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)


def process_single_track(file_path: str, device: str, purge_source: bool) -> None:
    track_id = Path(file_path).stem
    print(f"\n[Demucs GPU] Processing: {track_id}")

    missing = [stem for stem in EXPECTED_STEMS if not r2_has_stem(track_id, stem)]
    if not missing:
        print(f"  R2 already has 4/4 stems for {track_id}; skipping Demucs.")
        if purge_source and os.path.exists(file_path):
            os.remove(file_path)
            print(f"[Purged] source {track_id}")
        return

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    cmd = [
        *demucs_cmd(),
        "-n",
        "htdemucs",
        "-d",
        device,
        "-o",
        str(OUTPUT_DIR),
        file_path,
    ]
    subprocess.run(cmd, check=True)

    model_dir = OUTPUT_DIR / "htdemucs" / track_id
    stems_dict = {
        stem_name: str(model_dir / stem_name)
        for stem_name in EXPECTED_STEMS
        if (model_dir / stem_name).is_file()
    }
    uploaded_keys = upload_stems_parallel(stems_dict, track_id)
    uploaded = len(uploaded_keys)

    purge_dir(model_dir)
    if purge_source and uploaded == len(EXPECTED_STEMS) and os.path.exists(file_path):
        os.remove(file_path)
        print(f"[Purged] Cleaned local scratch disk for {track_id}")
    elif uploaded != len(EXPECTED_STEMS):
        raise RuntimeError(f"{track_id}: uploaded {uploaded}/4 stems; source kept")
    else:
        print(f"[Kept] source {track_id} (--purge-source not set)")


def run_stream_pipeline(limit: int | None, device: str, purge_source: bool) -> None:
    audio_files = sorted(glob.glob(str(VAULT_DIR / "*.mp3")) + glob.glob(str(VAULT_DIR / "*.wav")))
    if limit is not None:
        audio_files = audio_files[:limit]
    total = len(audio_files)
    print(f"Found {total} queued tracks in {VAULT_DIR} (device={device}, purge_source={purge_source}).")

    for idx, path in enumerate(audio_files, 1):
        print(f"\n--- Progress: {idx}/{total} ---")
        try:
            process_single_track(path, device=device, purge_source=purge_source)
        except Exception as exc:
            print(f"Error processing {path}: {exc}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Stream Demucs stems to R2 and free local disk")
    parser.add_argument("--limit", type=int, default=None, help="Process at most N files")
    parser.add_argument("--device", default="auto", help="cuda, cpu, or auto")
    parser.add_argument(
        "--purge-source",
        action="store_true",
        default=ON_POD,
        help="Delete each source file after a successful 4-stem upload (default on /workspace)",
    )
    parser.add_argument(
        "--keep-source",
        action="store_true",
        help="Never delete source audio (overrides --purge-source)",
    )
    args = parser.parse_args()
    purge = False if args.keep_source else args.purge_source
    run_stream_pipeline(limit=args.limit, device=pick_device(args.device), purge_source=purge)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
