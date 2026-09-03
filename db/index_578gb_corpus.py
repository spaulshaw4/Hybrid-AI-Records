"""High-speed corpus analyzer. One ``slice_index`` row per wav (UNIQUE file_path).

Does not require librosa. Chroma/BPM come from ``dsp.pitch_key_aligner`` and
``dsp.tempo_time_stretch`` (numpy/scipy). Optional librosa only when
``HYBRID_USE_LIBROSA=1``. Refuses ``uploaded_slices``. ``--limit`` is required
unless ``--full`` is passed.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import Any

import numpy as np

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
    duration_sec REAL,
    stem_type_ml TEXT,
    stem_type_ml_confidence REAL
);
"""
INDEX_DDL = (
    "CREATE INDEX IF NOT EXISTS idx_key ON slice_index (detected_key);",
    "CREATE INDEX IF NOT EXISTS idx_stem ON slice_index (stem_type);",
    "CREATE INDEX IF NOT EXISTS idx_tags ON slice_index (tags);",
    "CREATE INDEX IF NOT EXISTS idx_stem_ml ON slice_index (stem_type_ml);",
)
# UPSERT preserves stem_type_ml / stem_type_ml_confidence. INSERT OR REPLACE
# would delete the row and NULLs those columns; the ML backfill must survive
# a re-index of the same path.
INSERT_SQL = """
INSERT INTO slice_index
    (file_path, filename, stem_type, detected_key, estimated_bpm,
     rms_db, spectral_centroid, tags, duration_sec)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(file_path) DO UPDATE SET
    filename = excluded.filename,
    stem_type = excluded.stem_type,
    detected_key = excluded.detected_key,
    estimated_bpm = excluded.estimated_bpm,
    rms_db = excluded.rms_db,
    spectral_centroid = excluded.spectral_centroid,
    tags = excluded.tags,
    duration_sec = excluded.duration_sec
"""

DEFAULT_CORPUS = r"D:\MusicDatasets\corpus_4s"
# db\ holds the real 2000-row index. database\ is the legacy 25-row harmonic-only
# file that predates the split; it stays as a fallback for machines that never
# got the newer layout, but it must never win when both exist.
DEFAULT_DB = r"D:\MusicDatasets\db\corpus_index.sqlite"
LEGACY_DB = r"D:\MusicDatasets\database\corpus_index.sqlite"
ALT_DB = LEGACY_DB
DB_PREFERENCE = (DEFAULT_DB, LEGACY_DB)
DEFAULT_WORKERS = 8
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_RHYTHM_KEYS = ("drum", "beat", "percussion", "kick", "snare", "hat", "loop_rhythm", "rhythm", "perc")
_HARMONIC_KEYS = ("bass", "pad", "synth", "chord", "guitar", "keys", "piano", "drone", "harmonic")
_LEAD_KEYS = ("lead", "solo", "riff", "pluck", "arp", "melody")
_VOCAL_KEYS = ("vox", "vocal", "phrase", "sing", "hook", "chop")

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)


def default_index_db() -> str:
    """Shared corpus index path: CORPUS_INDEX_DB, then db\\, then legacy database\\."""
    env = (os.environ.get("CORPUS_INDEX_DB") or "").strip()
    if env:
        return env
    for candidate in DB_PREFERENCE:
        if os.path.isfile(candidate):
            return candidate
    return DEFAULT_DB


def assert_safe_corpus(corpus_dir: str) -> None:
    norm = os.path.normpath(os.path.abspath(corpus_dir)).replace("/", os.sep).lower()
    parts = set(norm.split(os.sep))
    if "uploaded_slices" in parts or "uploaded_slices" in norm:
        raise ValueError(
            "Refusing to index uploaded_slices. Use --corpus D:\\MusicDatasets\\corpus_4s "
            "or another small pack."
        )


def table_columns(conn: sqlite3.Connection, table: str = "slice_index") -> set[str]:
    """Column names for ``table``, empty if it does not exist."""
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {str(row[1]) for row in rows}


def ensure_ml_columns(conn: sqlite3.Connection) -> None:
    """Add ``stem_type_ml`` + confidence if missing. Does not touch ``stem_type`` values."""
    cols = table_columns(conn)
    if "file_path" not in cols:
        return
    if "stem_type_ml" not in cols:
        conn.execute("ALTER TABLE slice_index ADD COLUMN stem_type_ml TEXT")
    if "stem_type_ml_confidence" not in cols:
        conn.execute(
            "ALTER TABLE slice_index ADD COLUMN stem_type_ml_confidence REAL"
        )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_stem_ml ON slice_index (stem_type_ml)")


def init_db(db_path: str) -> sqlite3.Connection:
    parent = os.path.dirname(os.path.abspath(db_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(SLICE_INDEX_DDL)
    ensure_ml_columns(conn)
    for stmt in INDEX_DDL:
        conn.execute(stmt)
    conn.commit()
    return conn


def infer_stem_type(path_lower: str) -> str:
    blob = path_lower.replace("\\", "/").replace("_", " ").replace("-", " ")
    if any(key in blob for key in _RHYTHM_KEYS):
        return "rhythm"
    if any(key in blob for key in _VOCAL_KEYS):
        return "vocal"
    if any(key in blob for key in _LEAD_KEYS):
        return "lead"
    if any(key in blob for key in _HARMONIC_KEYS):
        return "harmonic"
    return "harmonic"


def tags_from_path(file_path: str) -> str:
    cleaned = file_path.lower().replace("\\", "/").replace("_", " ").replace("-", " ")
    tokens: set[str] = set()
    for part in cleaned.split("/"):
        part = part.replace(".wav", "")
        for token in part.split():
            token = "".join(ch for ch in token if ch.isalnum())
            if len(token) > 1:
                tokens.add(token)
    return " ".join(sorted(tokens))


def _spectral_centroid_hz(mono: np.ndarray, sr: int) -> float:
    n_fft = 2048
    hop = 1024
    window = np.hanning(n_fft)
    freqs = np.fft.rfftfreq(n_fft, 1.0 / max(1, int(sr)))
    cents: list[float] = []
    if len(mono) < 8:
        return 0.0
    last = max(1, len(mono) - n_fft + 1)
    for i in range(0, last, hop):
        frame = np.asarray(mono[i : i + n_fft], dtype=np.float64)
        if len(frame) < n_fft:
            frame = np.pad(frame, (0, n_fft - len(frame)))
        mag = np.abs(np.fft.rfft(frame * window))
        denom = float(np.sum(mag)) + 1e-12
        cents.append(float(np.sum(freqs * mag) / denom))
    return float(np.mean(cents)) if cents else 0.0


def _optional_librosa():
    flag = os.environ.get("HYBRID_USE_LIBROSA", "").strip().lower()
    if flag not in {"1", "true", "yes"}:
        return None
    try:
        import librosa

        return librosa
    except Exception:
        return None


def analyze_single_slice(file_path: str) -> dict[str, Any] | None:
    """Feature row for one wav. Returns None on read failure. No librosa required."""
    try:
        import soundfile as sf

        data, sr = sf.read(file_path, always_2d=True)
    except Exception:
        return None
    try:
        mono = np.mean(np.asarray(data, dtype=np.float64), axis=1)
        if mono.size == 0:
            return None
        sr_i = int(sr)
        duration_sec = float(len(mono) / max(1, sr_i))
        rms_val = float(np.sqrt(np.mean(np.square(mono)) + 1e-12))
        rms_db = float(20.0 * np.log10(rms_val))
        path_clean = file_path.lower().replace("\\", "/")
        detected_key = "A"
        estimated_bpm = 120.0
        centroid = _spectral_centroid_hz(mono, sr_i)
        try:
            from dsp.pitch_key_aligner import detect_slice_key

            _idx, detected_key = detect_slice_key(mono, sr=sr_i)
        except Exception:
            detected_key = "A"
        try:
            from dsp.tempo_time_stretch import estimate_slice_bpm

            estimated_bpm = float(estimate_slice_bpm(mono, sr=sr_i))
        except Exception:
            estimated_bpm = 120.0
        librosa = _optional_librosa()
        if librosa is not None:
            try:
                chroma = librosa.feature.chroma_cqt(y=mono, sr=sr_i)
                detected_key = NOTE_NAMES[int(np.argmax(np.mean(chroma, axis=1))) % 12]
            except Exception:
                pass
            try:
                centroid = float(np.mean(librosa.feature.spectral_centroid(y=mono, sr=sr_i)))
            except Exception:
                pass
            try:
                onset_env = librosa.onset.onset_strength(y=mono, sr=sr_i)
                tempo = librosa.beat.tempo(onset_envelope=onset_env, sr=sr_i, aggregate=np.median)
                if len(np.atleast_1d(tempo)):
                    estimated_bpm = float(np.atleast_1d(tempo)[0])
            except Exception:
                pass
        return {
            "file_path": file_path,
            "filename": os.path.basename(file_path),
            "stem_type": infer_stem_type(path_clean),
            "detected_key": str(detected_key),
            "estimated_bpm": round(float(estimated_bpm), 1),
            "rms_db": round(float(rms_db), 2),
            "spectral_centroid": round(float(centroid), 1),
            "tags": tags_from_path(file_path),
            "duration_sec": round(duration_sec, 2),
        }
    except Exception:
        return None


def discover_wavs(corpus_dir: str, limit: int | None = None) -> list[str]:
    assert_safe_corpus(corpus_dir)
    found: list[str] = []
    if not os.path.isdir(corpus_dir):
        return found
    for root, dirs, files in os.walk(corpus_dir):
        dirs[:] = [name for name in dirs if name.lower() != "uploaded_slices"]
        if "uploaded_slices" in root.lower().split(os.sep):
            continue
        for name in files:
            if name.lower().endswith(".wav"):
                found.append(os.path.join(root, name))
                if limit is not None and len(found) >= int(limit):
                    return found
    found.sort()
    return found


def _row_tuple(res: dict[str, Any]) -> tuple:
    return (
        res["file_path"],
        res["filename"],
        res["stem_type"],
        res["detected_key"],
        res["estimated_bpm"],
        res["rms_db"],
        res["spectral_centroid"],
        res["tags"],
        res["duration_sec"],
    )


def _flush_batch(cur: sqlite3.Cursor, conn: sqlite3.Connection, batch: list[tuple]) -> int:
    if not batch:
        return 0
    cur.executemany(INSERT_SQL, batch)
    conn.commit()
    return len(batch)


def batch_index_corpus(
    corpus_dir: str,
    db_path: str,
    max_workers: int = DEFAULT_WORKERS,
    limit: int | None = None,
    sequential: bool = False,
) -> int:
    assert_safe_corpus(corpus_dir)
    audio_files = discover_wavs(corpus_dir, limit=limit)
    total_files = len(audio_files)
    workers = max(1, int(max_workers))
    print(f"[*] Discovered {total_files} audio files. Indexing with {workers} worker(s)...")
    conn = init_db(db_path)
    cur = conn.cursor()
    batch: list[tuple] = []
    processed = 0
    use_pool = (not sequential) and workers > 1 and total_files >= 2
    try:
        if use_pool:
            with ProcessPoolExecutor(max_workers=workers) as executor:
                futures = {executor.submit(analyze_single_slice, path): path for path in audio_files}
                for future in as_completed(futures):
                    res = future.result()
                    if res:
                        batch.append(_row_tuple(res))
                    if len(batch) >= 500:
                        processed += _flush_batch(cur, conn, batch)
                        batch.clear()
                        print(f"  -> Indexed {processed}/{total_files} samples...")
        else:
            for path in audio_files:
                res = analyze_single_slice(path)
                if res:
                    batch.append(_row_tuple(res))
                if len(batch) >= 500:
                    processed += _flush_batch(cur, conn, batch)
                    batch.clear()
                    print(f"  -> Indexed {processed}/{total_files} samples...")
        processed += _flush_batch(cur, conn, batch)
    finally:
        conn.close()
    print(f"\n[COMPLETE] Successfully indexed {processed} files into: {db_path}")
    return processed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Index corpus_4s wavs into slice_index")
    parser.add_argument("--corpus", default=DEFAULT_CORPUS)
    parser.add_argument("--db", default=default_index_db())
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Max wavs to scan (required unless --full)",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Index the entire --corpus tree (overnight). Do not use casually.",
    )
    parser.add_argument("--sequential", action="store_true")
    args = parser.parse_args(argv)
    if args.limit is None and not args.full:
        print(
            "[FATAL] --limit N is required for safety. Pass --full only for an overnight full index.",
            file=sys.stderr,
        )
        return 2
    if args.limit is not None and args.limit < 1:
        print("[FATAL] --limit must be >= 1", file=sys.stderr)
        return 2
    try:
        batch_index_corpus(
            args.corpus,
            args.db,
            max_workers=args.workers,
            limit=None if args.full else args.limit,
            sequential=args.sequential or args.workers <= 1,
        )
    except ValueError as exc:
        print(f"[FATAL] {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    import multiprocessing as mp

    mp.freeze_support()
    raise SystemExit(main())
