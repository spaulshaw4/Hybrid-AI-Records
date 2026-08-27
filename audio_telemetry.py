#!/usr/bin/env python3
"""ITU-R BS.1770 LUFS, 4x true peak, and optional brickwall re-limit."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from pedalboard import Limiter, Pedalboard
from scipy import signal
from supabase import Client, create_client

TRUE_PEAK_CEILING_DBFS = -0.5
TARGET_LUFS = -14.0


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


def _finite_lufs(value: float) -> float | None:
    if np.isinf(value) or np.isnan(value):
        return None
    return round(float(value), 2)


def measure_telemetry(data: np.ndarray, sr: int) -> tuple[float, float]:
    meter = pyln.Meter(sr)
    integrated_lufs = float(meter.integrated_loudness(data))
    resampled = signal.resample_poly(data, up=4, down=1, axis=0)
    peak_val = np.max(np.abs(resampled))
    true_peak_dbfs = 20.0 * np.log10(peak_val) if peak_val > 0.0 else -99.9
    return integrated_lufs, float(true_peak_dbfs)


def analyze_audio_quality(audio_path: str) -> dict:
    data, sr = sf.read(audio_path, dtype="float32")
    lufs, true_peak = measure_telemetry(data, sr)
    return {
        "integrated_lufs": _finite_lufs(lufs),
        "true_peak_dbfs": round(true_peak, 2),
        "sample_rate": int(sr),
        "relimited": False,
    }


def enforce_safety_limiting(
    audio_path: str,
    max_true_peak_dbfs: float = TRUE_PEAK_CEILING_DBFS,
) -> dict:
    data, sr = sf.read(audio_path, dtype="float32")
    lufs, true_peak = measure_telemetry(data, sr)
    was_relimited = False

    if true_peak > max_true_peak_dbfs:
        print(
            f"True Peak violation: {true_peak:.2f} dBFS "
            f"(ceiling {max_true_peak_dbfs} dBFS). Re-limiting..."
        )
        channels_first = data.T if data.ndim > 1 else data[np.newaxis, :]
        board = Pedalboard(
            [Limiter(threshold_db=max_true_peak_dbfs - 0.1, release_ms=25.0)]
        )
        limited = board(channels_first, sr)
        limited_sf = limited.T if limited.ndim > 1 else limited[0]
        lufs, true_peak = measure_telemetry(limited_sf, sr)
        was_relimited = True
        sf.write(audio_path, limited_sf, sr, subtype="PCM_24")
        print(
            f"Re-limiting complete -> LUFS: {_finite_lufs(lufs)} | "
            f"True Peak: {true_peak:.2f} dBFS"
        )

    return {
        "integrated_lufs": _finite_lufs(lufs),
        "true_peak_dbfs": round(true_peak, 2),
        "sample_rate": int(sr),
        "relimited": was_relimited,
    }


def validate_and_log_master(
    job_id: str,
    local_master_wav_path: str,
    r2_key: str | None = None,
    metrics: dict | None = None,
    urls: dict | None = None,
) -> dict:
    resolved = metrics or analyze_audio_quality(local_master_wav_path)
    print(
        f"[QC Check] Job {job_id} -> LUFS: {resolved['integrated_lufs']} | "
        f"True Peak: {resolved['true_peak_dbfs']} dBFS"
        f"{' (re-limited)' if resolved.get('relimited') else ''}"
    )
    if resolved.get("true_peak_dbfs") is not None and resolved["true_peak_dbfs"] > 0.0:
        print(f"Warning: True peak still above 0 dBFS ({resolved['true_peak_dbfs']})")

    if supabase:
        try:
            row = {
                "job_id": job_id,
                "integrated_lufs": resolved["integrated_lufs"],
                "true_peak_dbfs": resolved["true_peak_dbfs"],
                "sample_rate": resolved["sample_rate"],
                "mastered_at": datetime.now(timezone.utc).isoformat(),
                "status": "completed",
                "relimited": bool(resolved.get("relimited")),
            }
            if r2_key:
                row["r2_key"] = r2_key
            if urls:
                if urls.get("wav"):
                    row["master_wav_url"] = urls["wav"]
                if urls.get("mp3"):
                    row["master_mp3_url"] = urls["mp3"]
                if urls.get("aac"):
                    row["master_aac_url"] = urls["aac"]
            supabase.table("rendered_compositions").upsert(row, on_conflict="job_id").execute()
            print(f"Quality metrics logged for job {job_id}")
        except Exception as exc:
            print(f"Failed to log metrics to Supabase: {exc}")

    return resolved
