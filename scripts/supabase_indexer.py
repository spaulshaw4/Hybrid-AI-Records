#!/usr/bin/env python3
"""Extract BPM/key and upsert harvested stems into public.fma_tracks (not studio tracks)."""
from __future__ import annotations

import os
from pathlib import Path

import librosa
import numpy as np
from supabase import Client, create_client

PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _load_env() -> None:
    root = Path(__file__).resolve().parents[1]
    for name in (".env.local", ".env"):
        path = root / name
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


_load_env()

SUPABASE_URL = (
    os.environ.get("SUPABASE_URL")
    or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    or os.environ.get("VITE_SUPABASE_URL")
    or ""
).strip()
SUPABASE_SERVICE_ROLE_KEY = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
R2_PUBLIC_DOMAIN = (
    os.environ.get("R2_PUBLIC_DOMAIN")
    or os.environ.get("R2_CUSTOM_DOMAIN")
    or ""
).strip().rstrip("/")

supabase: Client | None = (
    create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
    else None
)


def extract_bpm_and_key(audio_path: str) -> tuple[float, str]:
    y, sr = librosa.load(audio_path, duration=45.0)

    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = round(float(np.atleast_1d(tempo)[0]), 1)

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = np.mean(chroma, axis=1)

    best_corr = -1.0
    best_key = "C Major"
    for i in range(12):
        r_maj = np.corrcoef(np.roll(chroma_mean, -i), MAJOR_PROFILE)[0, 1]
        r_min = np.corrcoef(np.roll(chroma_mean, -i), MINOR_PROFILE)[0, 1]
        if r_maj > best_corr:
            best_corr = r_maj
            best_key = f"{PITCH_CLASSES[i]} Major"
        if r_min > best_corr:
            best_corr = r_min
            best_key = f"{PITCH_CLASSES[i]} Minor"

    return bpm, best_key


def index_track_in_supabase(
    track_id: str,
    audio_path: str,
    valid_stems: set[str] | None = None,
    qc_by_stem: dict | None = None,
) -> None:
    if not supabase:
        print("[Supabase] Credentials not found. Skipping DB indexing.")
        return
    if not R2_PUBLIC_DOMAIN:
        print("[Supabase] R2_PUBLIC_DOMAIN / R2_CUSTOM_DOMAIN not set. Skipping DB indexing.")
        return

    allowed = valid_stems or {"drums", "bass", "vocals", "other"}
    try:
        bpm, key_sig = extract_bpm_and_key(audio_path)
        record = {
            "track_id": track_id,
            "bpm": bpm,
            "key_signature": key_sig,
            "status": "ready",
            "stem_drums_url": (
                f"{R2_PUBLIC_DOMAIN}/stems/{track_id}/drums.wav" if "drums" in allowed else None
            ),
            "stem_bass_url": (
                f"{R2_PUBLIC_DOMAIN}/stems/{track_id}/bass.wav" if "bass" in allowed else None
            ),
            "stem_vocals_url": (
                f"{R2_PUBLIC_DOMAIN}/stems/{track_id}/vocals.wav" if "vocals" in allowed else None
            ),
            "stem_other_url": (
                f"{R2_PUBLIC_DOMAIN}/stems/{track_id}/other.wav" if "other" in allowed else None
            ),
        }
        if qc_by_stem:
            for stem_name in ("drums", "bass", "vocals", "other"):
                qc = qc_by_stem.get(stem_name) or {}
                if qc.get("valid"):
                    record[f"{stem_name}_snr"] = qc.get("snr_db")
        supabase.table("fma_tracks").upsert(record, on_conflict="track_id").execute()
        print(
            f"Indexed {track_id} in fma_tracks: {bpm} BPM | {key_sig} | "
            f"{len(allowed)} clean stems"
        )
    except Exception as exc:
        print(f"Failed to index {track_id} in Supabase: {exc}")
