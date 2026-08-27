#!/usr/bin/env python3
"""Batch chunk ingest: read MP3s from scratch, Demucs on CUDA, upload to R2, purge local files.

On the pod:
  mkdir -p /workspace/scripts /workspace/scratch /workspace/stems_output
  # extract a zip batch into /workspace/scratch, then:
  nohup python /workspace/scripts/ingest_full_fma.py > /workspace/ingest.log 2>&1 &
  tail -f /workspace/ingest.log
"""
from __future__ import annotations

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
from stem_qc import validate_stem_quality
from supabase_indexer import index_track_in_supabase

WORKSPACE = Path("/workspace")
ON_POD = WORKSPACE.is_dir()
SCRATCH_DIR = str(WORKSPACE / "scratch" if ON_POD else ROOT / ".ingest_vault")
OUTPUT_DIR = str(WORKSPACE / "stems_output" if ON_POD else ROOT / ".ingest_vault" / "stems_output")
EXPECTED_STEMS = ("drums.wav", "bass.wav", "vocals.wav", "other.wav")


def demucs_cmd() -> list[str]:
    if shutil.which("demucs"):
        return ["demucs"]
    return [sys.executable, "-m", "demucs"]


def check_stems_exist(track_id: str) -> bool:
    prefix = f"stems/{track_id}/"
    try:
        res = s3_client.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix=prefix)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in {"NoSuchBucket", "404", "NotFound"}:
            return False
        raise
    keys = {os.path.basename(obj["Key"]) for obj in res.get("Contents") or []}
    return all(stem in keys for stem in EXPECTED_STEMS)


def process_track(mp3_path: str) -> None:
    track_id = Path(mp3_path).stem
    if check_stems_exist(track_id):
        print(f"Skipping {track_id} (already in R2)")
        index_track_in_supabase(track_id, mp3_path)
        os.remove(mp3_path)
        return

    print(f"\n[CUDA Demucs] Separating: {track_id}")
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    subprocess.run(
        [*demucs_cmd(), "-n", "htdemucs", "-d", "cuda", "-o", OUTPUT_DIR, mp3_path],
        check=True,
    )

    model_dir = os.path.join(OUTPUT_DIR, "htdemucs", track_id)
    valid_stems: dict[str, str] = {}
    qc_by_stem: dict[str, dict] = {}
    for stem in EXPECTED_STEMS:
        stem_path = os.path.join(model_dir, stem)
        if not os.path.exists(stem_path):
            print(f"[QC Skipped] {track_id} | missing {stem}")
            continue
        stem_name = Path(stem).stem
        qc = validate_stem_quality(stem_path)
        qc_by_stem[stem_name] = qc
        if not qc["valid"]:
            print(f"[QC Rejected] {track_id} | {stem_name}: {qc['reason']}")
            continue
        valid_stems[stem_name] = stem_path
        print(
            f"[QC Passed] {track_id} | {stem_name} "
            f"(SNR: {qc['snr_db']} dB, Phase: {qc['phase_coherence']})"
        )

    has_rhythm = "drums" in valid_stems or "bass" in valid_stems
    has_lead = "vocals" in valid_stems or "other" in valid_stems
    if not (has_rhythm and has_lead):
        print(
            f"[Track Discarded] {track_id} lacks a usable rhythm+lead pair; source kept."
        )
        if os.path.isdir(model_dir):
            shutil.rmtree(model_dir)
        return

    uploaded_keys = upload_stems_parallel(valid_stems, track_id)
    uploaded = len(uploaded_keys)
    if os.path.isdir(model_dir):
        shutil.rmtree(model_dir)
    if uploaded == len(valid_stems) and os.path.exists(mp3_path):
        index_track_in_supabase(
            track_id,
            mp3_path,
            valid_stems=set(valid_stems),
            qc_by_stem=qc_by_stem,
        )
        os.remove(mp3_path)
        print(f"Purged scratch artifacts for {track_id}")
    else:
        raise RuntimeError(
            f"{track_id}: uploaded {uploaded}/{len(valid_stems)} QC-passed stems; source kept"
        )


def run() -> None:
    os.makedirs(SCRATCH_DIR, exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    audio_files = sorted(glob.glob(f"{SCRATCH_DIR}/**/*.mp3", recursive=True))
    total = len(audio_files)
    print(f"Discovered {total} tracks in {SCRATCH_DIR} ready for processing.")
    for idx, audio_file in enumerate(audio_files, 1):
        print(f"[{idx}/{total}] Processing: {audio_file}")
        try:
            process_track(audio_file)
        except Exception as exc:
            print(f"Error on {audio_file}: {exc}")


if __name__ == "__main__":
    run()
