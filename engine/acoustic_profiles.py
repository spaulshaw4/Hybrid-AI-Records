"""Isolated acoustic profiles for staging slices.

Three LibROSA-equivalent descriptors, numpy/scipy only (librosa/numba are
unreliable on this workstation). Never opens the live corpus index.

* spectral centroid — magnitude spectrogram treated as a distribution over
  frequency bins (bright vs dark)
* transient density — mean onset strength (positive spectral flux), busy
  percussion vs sustained pads
* rms energy — mean frame RMS, raw physical power
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone
from typing import Any

import numpy as np

from ml.audio_features import (
    EPS,
    HOP,
    N_FFT,
    TARGET_SR,
    _FREQS,
    _MEL_FB,
    _magnitude_spectrogram,
    resample_to_target,
    to_mono,
)

LIVE_INDEX_PATHS = (
    os.path.normcase(os.path.abspath(r"C:\live_web_outputs\db\corpus_index_live.sqlite")),
    os.path.normcase(os.path.abspath(r"D:\MusicDatasets\db\corpus_index.sqlite")),
)
DEFAULT_DB = r"C:\live_web_outputs\db\hybrid_acoustic_profiles.db"
DEFAULT_STAGING = r"C:\staging_slices"

SCHEMA = """
CREATE TABLE IF NOT EXISTS stem_features (
    rel_path TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    spectral_centroid REAL,
    transient_density REAL,
    rms_energy REAL,
    sr INTEGER,
    duration_sec REAL,
    mtime REAL,
    size INTEGER,
    updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_stem_centroid ON stem_features(spectral_centroid);
CREATE INDEX IF NOT EXISTS idx_stem_transient ON stem_features(transient_density);
CREATE INDEX IF NOT EXISTS idx_stem_rms ON stem_features(rms_energy);
"""


def _refuse_live_index(db_path: str) -> str:
    abs_path = os.path.abspath(db_path)
    if os.path.normcase(abs_path) in LIVE_INDEX_PATHS:
        raise RuntimeError(f"refusing to open live corpus index: {abs_path}")
    return abs_path


def connect_profiles(db_path: str = DEFAULT_DB) -> sqlite3.Connection:
    """Open the parallel profiles DB. WAL + busy timeout; never the live index."""
    abs_path = _refuse_live_index(db_path)
    os.makedirs(os.path.dirname(abs_path) or ".", exist_ok=True)
    conn = sqlite3.connect(abs_path, timeout=30.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    return conn


def analyze_buffer(y: np.ndarray, sr: int) -> dict[str, float]:
    """LibROSA centroid / onset-strength / RMS on a mono buffer."""
    mono = to_mono(y)
    sr_i = int(sr)
    if mono.size == 0 or sr_i <= 0:
        return {"spectral_centroid": 0.0, "transient_density": 0.0, "rms_energy": 0.0}
    mono = resample_to_target(mono, sr_i, TARGET_SR)
    mag = _magnitude_spectrogram(mono)
    power = mag**2
    frame_energy = power.sum(axis=1) + EPS
    centroid = (power @ _FREQS) / frame_energy
    # Onset strength ≈ mean positive flux of the mel spectrogram (librosa default).
    mel = mag @ _MEL_FB.T
    if mel.shape[0] > 1:
        flux = np.maximum(0.0, np.diff(mel, axis=0))
        onset_env = flux.mean(axis=1)
        transient = float(np.mean(onset_env))
    else:
        transient = 0.0
    n_frames = mag.shape[0]
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    padded = np.pad(mono, (0, max(0, int(idx.max()) + 1 - mono.size)))
    rms = np.sqrt(np.mean(padded[idx] ** 2, axis=1) + EPS)
    return {
        "spectral_centroid": float(np.mean(centroid)),
        "transient_density": transient,
        "rms_energy": float(np.mean(rms)),
    }


def analyze_file(path: str) -> dict[str, Any] | None:
    """Load a wav (soundfile) and return profile fields, or None on failure."""
    try:
        import soundfile as sf

        data, sr = sf.read(path, always_2d=True, dtype="float64")
    except Exception:
        return None
    try:
        profile = analyze_buffer(data, int(sr))
    except Exception:
        return None
    n = int(np.asarray(data).shape[0])
    profile["sr"] = int(sr)
    profile["duration_sec"] = float(n) / float(sr) if sr else 0.0
    return profile


def existing_paths(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT rel_path FROM stem_features").fetchall()
    return {str(r[0]) for r in rows}


def insert_batch(conn: sqlite3.Connection, rows: list[tuple]) -> None:
    conn.executemany(
        """
        INSERT OR REPLACE INTO stem_features
            (rel_path, file_name, spectral_centroid, transient_density, rms_energy,
             sr, duration_sec, mtime, size, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    conn.commit()


def row_for_file(staging: str, path: str, profile: dict[str, Any]) -> tuple:
    rel = os.path.relpath(path, staging).replace("\\", "/")
    st = os.stat(path)
    return (
        rel,
        os.path.basename(path),
        float(profile["spectral_centroid"]),
        float(profile["transient_density"]),
        float(profile["rms_energy"]),
        int(profile.get("sr") or 0),
        float(profile.get("duration_sec") or 0.0),
        float(st.st_mtime),
        int(st.st_size),
        datetime.now(timezone.utc).isoformat(),
    )
