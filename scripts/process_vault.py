#!/usr/bin/env python3
"""Sequential Demucs vault processor: QC, R2 upload, BPM/key index, then archive.

On the pod (only after MP3s exist in the vault):
  cd /workspace && nohup python scripts/process_vault.py > /workspace/vault_process.log 2>&1 &
"""
from __future__ import annotations

import glob
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from r2_uploader import upload_stems_parallel
from stem_qc import validate_stem_quality
from supabase_indexer import index_track_in_supabase

WORKSPACE = Path("/workspace")
ON_POD = WORKSPACE.is_dir()
EXPECTED_STEMS = ("drums.wav", "bass.wav", "vocals.wav", "other.wav")
SLEEP_BETWEEN_SEC = 1.0


def _vault_dir() -> Path:
    if ON_POD:
        primary = WORKSPACE / ".ingest_vault"
        scratch = WORKSPACE / "scratch"
        if _list_audio(primary):
            return primary
        if _list_audio(scratch):
            return scratch
        return primary
    return ROOT / ".ingest_vault"


def _archive_dir() -> Path:
    if ON_POD:
        return WORKSPACE / ".ingest_complete"
    return ROOT / ".ingest_complete"


def _stems_out() -> Path:
    if ON_POD:
        return WORKSPACE / "scratch" / "stems_temp"
    return ROOT / ".ingest_vault" / "stems_temp"


def _list_audio(folder: Path) -> list[str]:
    if not folder.is_dir():
        return []
    files: list[str] = []
    for pattern in ("**/*.mp3", "**/*.wav"):
        files.extend(glob.glob(str(folder / pattern), recursive=True))
    return sorted(files)


def demucs_cmd() -> list[str]:
    if shutil.which("demucs"):
        return ["demucs"]
    return [sys.executable, "-m", "demucs"]


def _run_demucs(mp3_path: str, stems_out: Path) -> None:
    stems_out.mkdir(parents=True, exist_ok=True)
    cmd = [*demucs_cmd(), "-n", "htdemucs", "-d", "cuda", "-o", str(stems_out), mp3_path]
    print(f"[Demucs] {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-4000:]
        raise RuntimeError(f"Demucs failed ({result.returncode}): {tail}")


def process_track(mp3_path: str, stems_out: Path, archive_dir: Path) -> None:
    track_id = Path(mp3_path).stem
    print(f"\n[Vault] {track_id}")
    _run_demucs(mp3_path, stems_out)
    model_dir = stems_out / "htdemucs" / track_id

    valid_stems: dict[str, str] = {}
    qc_by_stem: dict[str, dict] = {}
    for stem in EXPECTED_STEMS:
        stem_path = model_dir / stem
        if not stem_path.is_file():
            print(f"[QC Skipped] {track_id} | missing {stem}")
            continue
        stem_name = Path(stem).stem
        qc = validate_stem_quality(str(stem_path))
        qc_by_stem[stem_name] = qc
        if not qc["valid"]:
            print(f"[QC Rejected] {track_id} | {stem_name}: {qc['reason']}")
            continue
        valid_stems[stem_name] = str(stem_path)
        print(
            f"[QC Passed] {track_id} | {stem_name} "
            f"(SNR: {qc['snr_db']} dB, Phase: {qc['phase_coherence']})"
        )

    has_rhythm = "drums" in valid_stems or "bass" in valid_stems
    has_lead = "vocals" in valid_stems or "other" in valid_stems
    if not (has_rhythm and has_lead):
        print(f"[Track Discarded] {track_id} lacks rhythm+lead; source kept.")
        if model_dir.is_dir():
            shutil.rmtree(model_dir, ignore_errors=True)
        return

    uploaded = upload_stems_parallel(valid_stems, track_id)
    if model_dir.is_dir():
        shutil.rmtree(model_dir, ignore_errors=True)
    if len(uploaded) != len(valid_stems):
        raise RuntimeError(
            f"{track_id}: uploaded {len(uploaded)}/{len(valid_stems)} stems; source kept"
        )

    index_track_in_supabase(
        track_id,
        mp3_path,
        valid_stems=set(valid_stems),
        qc_by_stem=qc_by_stem,
    )
    archive_dir.mkdir(parents=True, exist_ok=True)
    dest = archive_dir / Path(mp3_path).name
    if dest.exists():
        dest = archive_dir / f"{track_id}_{int(time.time())}{Path(mp3_path).suffix}"
    shutil.move(mp3_path, dest)
    print(f"[Archived] {dest}")


def run() -> None:
    vault = _vault_dir()
    archive = _archive_dir()
    stems_out = _stems_out()
    vault.mkdir(parents=True, exist_ok=True)
    archive.mkdir(parents=True, exist_ok=True)
    stems_out.mkdir(parents=True, exist_ok=True)
    files = _list_audio(vault)
    print(f"Vault {vault}: {len(files)} audio files. Archive -> {archive}")
    for idx, audio_file in enumerate(files, 1):
        print(f"[{idx}/{len(files)}] {audio_file}")
        try:
            process_track(audio_file, stems_out, archive)
        except Exception as exc:
            print(f"Error on {audio_file}: {exc}")
        time.sleep(SLEEP_BETWEEN_SEC)


if __name__ == "__main__":
    run()
