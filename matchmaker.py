#!/usr/bin/env python3
"""Camelot-wheel stem matching against public.fma_tracks."""
from __future__ import annotations

import os
import random
from pathlib import Path
from typing import Dict, List

from rubberband_engine import calculate_semitone_shift, normalize_key_label
from supabase import Client, create_client

CAMELOT_MAP = {
    "B Major": "1B",
    "G# Minor": "1A",
    "Ab Minor": "1A",
    "F# Major": "2B",
    "Gb Major": "2B",
    "D# Minor": "2A",
    "Eb Minor": "2A",
    "Db Major": "3B",
    "C# Major": "3B",
    "Bb Minor": "3A",
    "A# Minor": "3A",
    "Ab Major": "4B",
    "G# Major": "4B",
    "F Minor": "4A",
    "Eb Major": "5B",
    "D# Major": "5B",
    "C Minor": "5A",
    "Bb Major": "6B",
    "A# Major": "6B",
    "G Minor": "6A",
    "F Major": "7B",
    "D Minor": "7A",
    "C Major": "8B",
    "A Minor": "8A",
    "G Major": "9B",
    "E Minor": "9A",
    "D Major": "10B",
    "B Minor": "10A",
    "A Major": "11B",
    "F# Minor": "11A",
    "Gb Minor": "11A",
    "E Major": "12B",
    "C# Minor": "12A",
    "Db Minor": "12A",
}


def _load_env() -> None:
    root = Path(__file__).resolve().parent
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

supabase: Client | None = (
    create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
    else None
)


def get_compatible_camelot(code: str) -> List[str]:
    if not code or len(code) < 2:
        return []
    num = int(code[:-1])
    letter = code[-1]
    other_letter = "A" if letter == "B" else "B"
    prev_num = 12 if num == 1 else num - 1
    next_num = 1 if num == 12 else num + 1
    return [
        code,
        f"{num}{other_letter}",
        f"{prev_num}{letter}",
        f"{next_num}{letter}",
    ]


def find_compatible_stems(
    target_bpm: float,
    target_key: str,
    bpm_tolerance: float = 8.0,
) -> List[Dict]:
    if not supabase:
        raise RuntimeError("Supabase client is not configured.")

    min_bpm = target_bpm - bpm_tolerance
    max_bpm = target_bpm + bpm_tolerance
    res = (
        supabase.table("fma_tracks")
        .select("track_id, bpm, key_signature")
        .gte("bpm", min_bpm)
        .lte("bpm", max_bpm)
        .eq("status", "ready")
        .limit(100)
        .execute()
    )
    candidates = res.data or []
    if not candidates:
        return []

    target_camelot = CAMELOT_MAP.get(target_key) or CAMELOT_MAP.get(normalize_key_label(target_key))
    if not target_camelot:
        compact = (target_key or "").strip().upper().replace(" ", "")
        if compact[-1:] in {"A", "B"} and compact[:-1].isdigit():
            target_camelot = f"{int(compact[:-1])}{compact[-1]}"
    if not target_camelot:
        return candidates

    valid_codes = set(get_compatible_camelot(target_camelot))
    matched = [
        track
        for track in candidates
        if CAMELOT_MAP.get(track.get("key_signature") or "") in valid_codes
    ]
    return matched if matched else candidates


def _pick_layers(pool: List[Dict]) -> tuple[Dict, Dict, Dict, Dict]:
    if len(pool) >= 4:
        picks = random.sample(pool, 4)
        return picks[0], picks[1], picks[2], picks[3]
    return (
        random.choice(pool),
        random.choice(pool),
        random.choice(pool),
        random.choice(pool),
    )


def generate_headless_recipe(target_bpm: float, target_key: str) -> Dict:
    pool = find_compatible_stems(target_bpm, target_key)
    if len(pool) < 2:
        raise ValueError(f"Insufficient indexed tracks matching {target_bpm} BPM / {target_key}")

    drum_track, bass_track, other_track, vocal_track = _pick_layers(pool)
    resolved_target = normalize_key_label(target_key) or target_key

    def layer_payload(track: dict, stem: str, gain_db: float) -> dict:
        source_key = track.get("key_signature") or resolved_target
        shift = 0 if stem == "drums" else calculate_semitone_shift(source_key, resolved_target)
        return {
            "track_id": track["track_id"],
            "stem": stem,
            "src_bpm": track["bpm"],
            "source_key": source_key,
            "pitch_shift": shift,
            "gain_db": gain_db,
        }

    return {
        "target_bpm": target_bpm,
        "target_key": resolved_target,
        "layers": [
            layer_payload(drum_track, "drums", 0.0),
            layer_payload(bass_track, "bass", -1.5),
            layer_payload(other_track, "other", -2.0),
            layer_payload(vocal_track, "vocals", -1.0),
        ],
    }
