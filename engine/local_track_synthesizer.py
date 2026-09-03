"""
Local 4.0s corpus assembler with BPM + key matched staging.

Arrangement (Stephen's layering, kept):
  Intro 16s   harmonic only
  Verse 48s   rhythm + harmonic
  Drop  64s   full (rhythm + harmonic + lead)
  Outro       rhythm tail

Only blends slices that share a compatible key and sit inside a BPM window
of ±4% or ±3 BPM. Cache lives under <corpus>/.index so analysis is not
repeated every run. If librosa/numba fails (seen on this machine), a
numpy/scipy detector still produces BPM + key so assembly can run.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import random
import sqlite3
import sys
import warnings
from datetime import datetime, timezone

import numpy as np
import soundfile as sf

PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    dtype=np.float64,
)
MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
    dtype=np.float64,
)

# Same Camelot wheel as matchmaker.py — same key, relative major/minor, ±1 fifth.
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

BPM_ABS_WINDOW = 3.0
BPM_PCT_WINDOW = 0.04
MIN_POOL = 8

_LIBROSA = None
_LIBROSA_PROBED = False


def _try_librosa():
    """Import librosa lazily. Numba DLL load has failed on this machine before."""
    global _LIBROSA, _LIBROSA_PROBED
    if _LIBROSA_PROBED:
        return _LIBROSA
    _LIBROSA_PROBED = True
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            import librosa  # type: ignore

        _LIBROSA = librosa
        return _LIBROSA
    except Exception as exc:
        print(f"[WARN] librosa unavailable ({exc}); using numpy/scipy BPM+key fallback")
        _LIBROSA = None
        return None


def get_compatible_camelot(code: str) -> list[str]:
    if not code or len(code) < 2:
        return []
    try:
        num = int(code[:-1])
    except ValueError:
        return []
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


def normalize_key_label(key: str) -> str:
    raw = (key or "").strip()
    if not raw:
        return ""
    compact = raw.replace("_", " ").strip()
    parts = compact.split()
    if len(parts) == 1:
        root = parts[0]
        mode = "Major"
    else:
        root, mode = parts[0], parts[-1]
    root = root.replace("b", "B")
    aliases = {
        "DB": "C#", "EB": "D#", "GB": "F#", "AB": "G#", "BB": "A#",
        "C#": "C#", "D#": "D#", "F#": "F#", "G#": "G#", "A#": "A#",
    }
    root_u = root.upper()
    root_n = aliases.get(root_u, root_u if root_u in PITCH_CLASSES else root)
    mode_n = "Minor" if mode.lower().startswith("min") else "Major"
    return f"{root_n} {mode_n}"


def camelot_for(key: str) -> str | None:
    label = normalize_key_label(key)
    if not label:
        return None
    if label in CAMELOT_MAP:
        return CAMELOT_MAP[label]
    # enharmonic leftovers
    for alias, code in CAMELOT_MAP.items():
        if normalize_key_label(alias) == label:
            return code
    return None


def keys_compatible(a: str, b: str) -> bool:
    if not a or not b:
        return False
    if normalize_key_label(a) == normalize_key_label(b):
        return True
    ca, cb = camelot_for(a), camelot_for(b)
    if not ca or not cb:
        return False
    return cb in get_compatible_camelot(ca)


def bpm_compatible(a: float, b: float) -> bool:
    if not a or not b or a <= 0 or b <= 0:
        return False
    delta = abs(float(a) - float(b))
    window = max(BPM_ABS_WINDOW, BPM_PCT_WINDOW * max(float(a), float(b)))
    return delta <= window


def _to_mono(data: np.ndarray) -> np.ndarray:
    if data.ndim == 1:
        return np.asarray(data, dtype=np.float64)
    return np.mean(data, axis=1, dtype=np.float64)


def _to_stereo(data: np.ndarray) -> np.ndarray:
    if data.ndim == 1:
        data = data[:, np.newaxis]
    if data.shape[1] == 1:
        return np.repeat(data, 2, axis=1)
    return data[:, :2]


def _resample_linear(data: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr or data.shape[0] < 2:
        return data
    n_src = data.shape[0]
    n_dst = max(1, int(round(n_src * float(dst_sr) / float(src_sr))))
    x_src = np.linspace(0.0, 1.0, n_src, endpoint=False)
    x_dst = np.linspace(0.0, 1.0, n_dst, endpoint=False)
    out = np.empty((n_dst, data.shape[1]), dtype=data.dtype)
    for ch in range(data.shape[1]):
        out[:, ch] = np.interp(x_dst, x_src, data[:, ch])
    return out


def resample_to(data: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr:
        return data
    try:
        from math import gcd
        from scipy.signal import resample_poly  # type: ignore

        div = gcd(int(src_sr), int(dst_sr))
        return resample_poly(data, int(dst_sr) // div, int(src_sr) // div, axis=0).astype(data.dtype)
    except Exception:
        return _resample_linear(data, src_sr, dst_sr)


def estimate_bpm_numpy(mono: np.ndarray, sr: int) -> float:
    """Onset-envelope autocorrelation. No librosa / numba."""
    if mono.size < sr // 2:
        return 120.0
    hop = max(256, int(sr * 0.01))
    win = hop * 4
    n_frames = 1 + max(0, (mono.size - win) // hop)
    if n_frames < 16:
        return 120.0

    env = np.empty(n_frames, dtype=np.float64)
    for i in range(n_frames):
        frame = mono[i * hop:i * hop + win]
        env[i] = np.sqrt(np.mean(frame * frame) + 1e-12)
    flux = np.maximum(np.diff(env, prepend=env[0]), 0.0)
    flux -= np.mean(flux)
    if np.max(np.abs(flux)) < 1e-12:
        return 120.0

    corr = np.correlate(flux, flux, mode="full")
    corr = corr[corr.size // 2:]
    min_bpm, max_bpm = 70.0, 180.0
    min_lag = max(1, int(round((60.0 / max_bpm) * sr / hop)))
    max_lag = min(corr.size - 1, int(round((60.0 / min_bpm) * sr / hop)))
    if max_lag <= min_lag:
        return 120.0
    region = corr[min_lag:max_lag + 1]
    peak = min_lag + int(np.argmax(region))
    bpm = 60.0 * sr / (peak * hop)
    if not np.isfinite(bpm) or bpm <= 0:
        return 120.0
    return float(np.clip(bpm, 60.0, 200.0))


def estimate_key_numpy(mono: np.ndarray, sr: int) -> tuple[str, float]:
    """Krumhansl-Schmuckler on an FFT pitch-class profile (55–2000 Hz)."""
    if mono.size < 1024:
        return "C Major", 0.0
    windowed = mono * np.hanning(mono.size)
    spec = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(mono.size, 1.0 / sr)
    band = (freqs > 55.0) & (freqs < 2000.0)
    if not np.any(band):
        return "C Major", 0.0

    pcp = np.zeros(12, dtype=np.float64)
    midi = 69.0 + 12.0 * np.log2(np.maximum(freqs[band], 1e-9) / 440.0)
    classes = np.rint(midi).astype(int) % 12
    np.add.at(pcp, classes, spec[band])
    if pcp.max() <= 1e-12:
        return "C Major", 0.0
    pcp = pcp / (np.linalg.norm(pcp) + 1e-12)

    best_corr = -1.0
    best_key = "C Major"
    for i in range(12):
        r_maj = float(np.dot(np.roll(pcp, -i), MAJOR_PROFILE / np.linalg.norm(MAJOR_PROFILE)))
        r_min = float(np.dot(np.roll(pcp, -i), MINOR_PROFILE / np.linalg.norm(MINOR_PROFILE)))
        if r_maj > best_corr:
            best_corr = r_maj
            best_key = f"{PITCH_CLASSES[i]} Major"
        if r_min > best_corr:
            best_corr = r_min
            best_key = f"{PITCH_CLASSES[i]} Minor"
    return best_key, float(best_corr)


def detect_bpm_key_librosa(path: str) -> tuple[float, str, float, str] | None:
    librosa = _try_librosa()
    if librosa is None:
        return None
    try:
        y, sr = librosa.load(path, sr=22050, mono=True, duration=8.0)
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(tempo)[0])
        if not np.isfinite(bpm) or bpm <= 0:
            bpm = estimate_bpm_numpy(y.astype(np.float64), sr)
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        chroma_mean = np.mean(chroma, axis=1)
        best_corr = -1.0
        best_key = "C Major"
        for i in range(12):
            r_maj = np.corrcoef(np.roll(chroma_mean, -i), MAJOR_PROFILE)[0, 1]
            r_min = np.corrcoef(np.roll(chroma_mean, -i), MINOR_PROFILE)[0, 1]
            if np.isfinite(r_maj) and r_maj > best_corr:
                best_corr = float(r_maj)
                best_key = f"{PITCH_CLASSES[i]} Major"
            if np.isfinite(r_min) and r_min > best_corr:
                best_corr = float(r_min)
                best_key = f"{PITCH_CLASSES[i]} Minor"
        return bpm, best_key, float(best_corr), "librosa"
    except Exception as exc:
        print(f"  [WARN] librosa tempo/key died on {os.path.basename(path)}: {exc}")
        print("         disabling librosa for this process; remaining slices use numpy/scipy")
        globals()["_LIBROSA"] = None
        globals()["_LIBROSA_PROBED"] = True
        return None


def detect_bpm_key(path: str) -> dict:
    lib = detect_bpm_key_librosa(path)
    if lib is not None:
        bpm, key, conf, analyzer = lib
        return {"bpm": round(float(bpm), 2), "key": key, "key_confidence": round(conf, 4), "analyzer": analyzer}

    data, sr = sf.read(path, always_2d=True)
    mono = _to_mono(data)
    bpm = estimate_bpm_numpy(mono, int(sr))
    key, conf = estimate_key_numpy(mono, int(sr))
    return {
        "bpm": round(float(bpm), 2),
        "key": key,
        "key_confidence": round(float(conf), 4),
        "analyzer": "numpy",
        "sr": int(sr),
    }


def index_dir(corpus_dir: str) -> str:
    path = os.path.join(corpus_dir, ".index")
    os.makedirs(path, exist_ok=True)
    return path


def _db_path(corpus_dir: str) -> str:
    return os.path.join(index_dir(corpus_dir), "features.sqlite")


def _sidecar_path(corpus_dir: str, wav_path: str) -> str:
    rel = os.path.relpath(wav_path, corpus_dir)
    safe = rel.replace("\\", "/").replace("/", "__")
    digest = hashlib.sha1(rel.encode("utf-8", errors="replace")).hexdigest()[:10]
    return os.path.join(index_dir(corpus_dir), "sidecars", f"{safe}.{digest}.json")


def _connect(corpus_dir: str) -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path(corpus_dir))
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS slice_features (
            path TEXT PRIMARY KEY,
            mtime REAL,
            size INTEGER,
            bpm REAL,
            key TEXT,
            key_confidence REAL,
            analyzer TEXT,
            updated_at TEXT
        )
        """
    )
    return conn


def cached_features(conn: sqlite3.Connection, wav_path: str) -> dict | None:
    try:
        st = os.stat(wav_path)
    except OSError:
        return None
    row = conn.execute(
        "SELECT mtime, size, bpm, key, key_confidence, analyzer FROM slice_features WHERE path = ?",
        (wav_path,),
    ).fetchone()
    if not row:
        return None
    mtime, size, bpm, key, conf, analyzer = row
    if abs(float(mtime) - st.st_mtime) > 0.5 or int(size) != int(st.st_size):
        return None
    return {
        "path": wav_path,
        "bpm": float(bpm),
        "key": key,
        "key_confidence": float(conf or 0.0),
        "analyzer": analyzer,
    }


def store_features(conn: sqlite3.Connection, corpus_dir: str, wav_path: str, feat: dict) -> None:
    st = os.stat(wav_path)
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        INSERT OR REPLACE INTO slice_features
            (path, mtime, size, bpm, key, key_confidence, analyzer, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            wav_path,
            st.st_mtime,
            st.st_size,
            feat["bpm"],
            feat["key"],
            feat.get("key_confidence", 0.0),
            feat.get("analyzer", "unknown"),
            now,
        ),
    )
    sidecar = _sidecar_path(corpus_dir, wav_path)
    os.makedirs(os.path.dirname(sidecar), exist_ok=True)
    payload = {
        "path": wav_path,
        "bpm": feat["bpm"],
        "key": feat["key"],
        "key_confidence": feat.get("key_confidence", 0.0),
        "analyzer": feat.get("analyzer", "unknown"),
        "mtime": st.st_mtime,
        "size": st.st_size,
        "updated_at": now,
    }
    with open(sidecar, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def list_corpus_wavs(corpus_dir: str, max_slices: int = 0) -> list[str]:
    files = glob.glob(os.path.join(corpus_dir, "**", "*.wav"), recursive=True)
    out = []
    for path in files:
        parts = os.path.normpath(path).split(os.sep)
        if ".index" in parts:
            continue
        out.append(path)
    out.sort()
    if max_slices and max_slices > 0:
        # Prefer older files so an in-flight slicer does not hand us half-written wavs.
        out.sort(key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0.0)
        out = out[:max_slices]
    return out


def analyze_corpus(corpus_dir: str, max_slices: int = 0) -> list[dict]:
    wavs = list_corpus_wavs(corpus_dir, max_slices=max_slices)
    conn = _connect(corpus_dir)
    records: list[dict] = []
    analyzed = 0
    cached = 0
    try:
        for path in wavs:
            try:
                feat = cached_features(conn, path)
                if feat is None:
                    detected = detect_bpm_key(path)
                    feat = {
                        "path": path,
                        "bpm": detected["bpm"],
                        "key": detected["key"],
                        "key_confidence": detected.get("key_confidence", 0.0),
                        "analyzer": detected.get("analyzer", "unknown"),
                    }
                    store_features(conn, corpus_dir, path, feat)
                    analyzed += 1
                else:
                    cached += 1
                records.append(feat)
            except Exception as exc:
                print(f"  [SKIP] analysis failed for {os.path.basename(path)}: {exc}")
        conn.commit()
    finally:
        conn.close()
    print(f"[*] Feature cache: {cached} hit(s), {analyzed} analyzed -> {index_dir(corpus_dir)}")
    return records


def pick_target(records: list[dict], bpm: float | None, key: str | None) -> tuple[float, str]:
    if bpm and key:
        return float(bpm), normalize_key_label(key)

    bpms = [r["bpm"] for r in records if r.get("bpm") and r["bpm"] > 0]
    keys = [r["key"] for r in records if r.get("key")]
    target_bpm = float(bpm) if bpm else (float(np.median(bpms)) if bpms else 120.0)

    if key:
        return target_bpm, normalize_key_label(key)

    counts: dict[str, int] = {}
    for label in keys:
        norm = normalize_key_label(label)
        counts[norm] = counts.get(norm, 0) + 1
    target_key = max(counts, key=counts.get) if counts else "C Major"
    return target_bpm, target_key


def filter_records(
    records: list[dict],
    target_bpm: float,
    target_key: str,
) -> tuple[list[dict], str]:
    both = [
        r for r in records
        if bpm_compatible(r.get("bpm") or 0.0, target_bpm) and keys_compatible(r.get("key") or "", target_key)
    ]
    if len(both) >= MIN_POOL:
        return both, "bpm+key"

    key_only = [r for r in records if keys_compatible(r.get("key") or "", target_key)]
    if len(key_only) >= MIN_POOL:
        print(
            f"[WARN] Only {len(both)} BPM+key matches; falling back to key-compatible "
            f"({len(key_only)} slices)."
        )
        return key_only, "key"

    bpm_only = [r for r in records if bpm_compatible(r.get("bpm") or 0.0, target_bpm)]
    if len(bpm_only) >= MIN_POOL:
        print(
            f"[WARN] Key bank too thin ({len(key_only)}); falling back to BPM window "
            f"({len(bpm_only)} slices)."
        )
        return bpm_only, "bpm"

    print(
        f"[WARN] Matched banks too small (bpm+key={len(both)}, key={len(key_only)}, "
        f"bpm={len(bpm_only)}); falling back to full pool ({len(records)})."
    )
    return records, "full"


def load_slice(path: str, target_samples: int, sr: int = 44100) -> np.ndarray:
    data, file_sr = sf.read(path, always_2d=True)
    data = _to_stereo(np.asarray(data, dtype=np.float64))
    # Forward buffer only. Never reverse the time axis (data[::-1]).
    if int(file_sr) != int(sr):
        data = resample_to(data, int(file_sr), int(sr))
    if data.shape[0] < target_samples:
        pad = np.zeros((target_samples - data.shape[0], data.shape[1]))
        return np.vstack([data, pad])
    return data[:target_samples, :]


def _sample_bank(pool: list[str], k: int) -> list[str]:
    if not pool:
        return []
    if len(pool) >= k:
        return random.sample(pool, k)
    return [random.choice(pool) for _ in range(k)]


SECTION_PRIORITY = {
    "intro": 10,
    "verse": 20,
    "verse_1": 21,
    "verse_2": 22,
    "pre_chorus": 30,
    "build": 35,
    "chorus": 40,
    "drop_chorus": 45,
    "drop": 45,
    "bridge": 50,
    "solo": 60,
    "outro": 90,
    "ending": 95,
}


def section_sort_key(section: dict) -> int:
    name = str(section.get("name") or "").lower().strip().replace(" ", "_").replace("-", "_")
    for key, priority in SECTION_PRIORITY.items():
        if name.startswith(key):
            return priority
    return 99


def chronological_sections(sections: list[dict] | None) -> list[dict] | None:
    if not sections:
        return sections
    ordered = sorted(sections, key=section_sort_key)
    names = [s.get("name") for s in ordered]
    print(f"[*] Chronological section order: {names}")
    return ordered


def load_arrangement(path: str | None) -> list[dict] | None:
    if not path or not os.path.isfile(path):
        return None
    payload = json.loads(open(path, encoding="utf-8").read())
    sections = payload.get("sections")
    return chronological_sections(sections) if sections else None


def assemble_local_track(
    corpus_dir: str,
    output_wav: str,
    target_length_sec: float = 180.0,
    sr: int = 44100,
    target_bpm: float | None = None,
    target_key: str | None = None,
    seed: int | None = None,
    max_slices: int = 0,
    arrangement_path: str | None = None,
) -> str:
    """
    Constructs a full arrangement using local 4.0s corpus blocks:
    Intro (16s) -> Main Verse (48s) -> Build/Drop (64s) -> Outro (32s)
    """
    if seed is not None:
        random.seed(seed)
        np.random.seed(seed)

    slice_pool = list_corpus_wavs(corpus_dir, max_slices=max_slices)
    if len(slice_pool) < MIN_POOL:
        raise ValueError(
            f"Corpus needs at least {MIN_POOL} slices to assemble. "
            f"Found {len(slice_pool)} in {corpus_dir}"
        )

    records = analyze_corpus(corpus_dir, max_slices=max_slices)
    bpm, key = pick_target(records, target_bpm, target_key)
    matched, rule = filter_records(records, bpm, key)
    matched_paths = [r["path"] for r in matched]
    print(
        f"[*] Harmonic staging: target {bpm:.1f} BPM / {key}  "
        f"rule={rule}  pool={len(matched_paths)}/{len(records)}"
    )

    if len(matched_paths) < 3:
        print("[WARN] Matched pool < 3; using full corpus so assembly does not crash.")
        matched_paths = slice_pool

    slice_samples = int(4.0 * sr)
    sections = load_arrangement(arrangement_path)
    if sections:
        total_slices = sum(int(s.get("slice_count") or (float(s.get("duration_sec") or 0) / 4.0)) for s in sections)
        print(f"[*] Using Gemini arrangement ({len(sections)} sections, {total_slices} slices)")
    else:
        total_slices = int(target_length_sec / 4.0)
        sections = None

    # Select distinct musical layers from the (already filtered) corpus pool
    rhythm_bank = _sample_bank(matched_paths, min(4, len(matched_paths)))
    harmonic_bank = _sample_bank(matched_paths, min(4, len(matched_paths)))
    lead_bank = _sample_bank(matched_paths, min(4, len(matched_paths)))
    track_blocks = []
    print(f"[*] Assembling {target_length_sec}s track ({total_slices} 4.0s sections) from local corpus...")

    def _mix_block(r_w: float, h_w: float, l_w: float) -> np.ndarray:
        block = np.zeros((slice_samples, 2), dtype=np.float64)
        if r_w:
            block += load_slice(random.choice(rhythm_bank), slice_samples, sr) * r_w
        if h_w:
            block += load_slice(random.choice(harmonic_bank), slice_samples, sr) * h_w
        if l_w:
            block += load_slice(random.choice(lead_bank), slice_samples, sr) * l_w
        return block

    if sections:
        for section in sections:
            layers = section.get("layers") or {}
            count = int(section.get("slice_count") or (float(section.get("duration_sec") or 4) / 4.0))
            print(f"  -> {section.get('name', 'Section')}: {count} slices layers={layers}")
            for _ in range(max(1, count)):
                block = _mix_block(
                    float(layers.get("rhythm") or 0.0),
                    float(layers.get("harmonic") or 0.0),
                    float(layers.get("lead") or 0.0),
                )
                fade_len = int(0.005 * sr)
                fade_in = np.linspace(0.0, 1.0, fade_len)[:, np.newaxis]
                fade_out = np.linspace(1.0, 0.0, fade_len)[:, np.newaxis]
                block[:fade_len] *= fade_in
                block[-fade_len:] *= fade_out
                track_blocks.append(block)
    else:
        for i in range(total_slices):
            if i < 4:
                block = _mix_block(0.0, 0.70, 0.0)
            elif i < 16:
                block = _mix_block(0.80, 0.60, 0.0)
            elif i < 32:
                block = _mix_block(0.85, 0.70, 0.50)
            else:
                block = _mix_block(0.60, 0.40, 0.0)
            fade_len = int(0.005 * sr)
            fade_in = np.linspace(0.0, 1.0, fade_len)[:, np.newaxis]
            fade_out = np.linspace(1.0, 0.0, fade_len)[:, np.newaxis]
            block[:fade_len] *= fade_in
            block[-fade_len:] *= fade_out
            track_blocks.append(block)

    full_audio = np.vstack(track_blocks)
    # Normalize composite sum to -3.0 dBFS before entering the master bus
    peak = np.max(np.abs(full_audio))
    if peak > 0:
        target_peak = 10.0 ** (-3.0 / 20.0)
        full_audio = full_audio * (target_peak / peak)
    os.makedirs(os.path.dirname(output_wav) or ".", exist_ok=True)
    sf.write(output_wav, full_audio, sr, subtype="PCM_24")
    print(f"[READY] Assembled unmastered mix: {output_wav} ({full_audio.shape[0] / sr:.1f}s)")
    return output_wav


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Assemble a local track from BPM/key-matched 4.0s slices."
    )
    parser.add_argument("--corpus", default=r"D:\MusicDatasets\corpus_4s")
    parser.add_argument("--out", default=r"D:\MusicDatasets\scratch\assembled_test_mix.wav")
    parser.add_argument("--duration", type=float, default=180.0)
    parser.add_argument("--bpm", type=float, default=None, help="Optional target BPM")
    parser.add_argument("--key", default=None, help="Optional target key, e.g. 'A Minor'")
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument(
        "--max-slices",
        type=int,
        default=0,
        help="Analyze at most N oldest wavs (0 = all). Useful while corpus_4s is still filling.",
    )
    parser.add_argument("--arrangement", default=None, help="Gemini arrangement JSON from arrange_from_prompt.py")
    return parser


if __name__ == "__main__":
    args = build_parser().parse_args()
    assemble_local_track(
        args.corpus,
        args.out,
        args.duration,
        target_bpm=args.bpm,
        target_key=args.key,
        seed=args.seed,
        max_slices=args.max_slices,
        arrangement_path=args.arrangement,
    )
