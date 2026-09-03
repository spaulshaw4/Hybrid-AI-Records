"""Blueprint assembler with cooldown rotation and bar-locked stem loops.

Section lengths are whole musical bars in 4/4 time:

    seconds = bars * (60 / BPM) * 4
    samples_per_bar = int(sr * 240 / bpm)

Default phrase is 8 bars; short blueprint sections may use 4 bars.
Rhythm (drums) and bass pick **one** loop for the entire track and tile it —
they do not rotate per section or every 4 s. Harmonic and vocal sit on the
same timeline (parallel buses), not sequenced packs. Loop joins use a 20 ms
equal-power overlap (``dsp.micro_crossfader``). Vocals are cut only on
zero-crossings (±15 ms) or silence (~−50 dBFS).
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import random
import sqlite3
import sys
from collections import deque

import numpy as np
import soundfile as sf

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from dsp.micro_crossfader import (  # noqa: E402
    apply_equal_power_crossfade,
    crossfade_sequence,
)
from dsp.smart_transient_slicer import (  # noqa: E402
    SEARCH_WINDOW_MS,
    SILENCE_FLOOR_DBFS,
    ZC_NEAR_TROUGH_MS,
    find_nearest_zero_crossing,
    find_phrase_zero_crossing,
    moving_rms,
    to_mono,
)
from engine.stem_role_router import (  # noqa: E402
    fade_samples,
    infer_role_from_path,
    infer_role_from_section,
    is_grid_role,
    is_phrase_role,
    load_slice_for_role,
    pad_or_trim,
    role_for_weight_key,
    split_on_silence,
    split_pool_by_layer,
)

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

BANK_REFRESH_BARS = 4
SESSION_STEMS = ("rhythm", "harmonic", "lead", "vocal")
SILENCE_WEIGHT = 0.01
# −3.0 dBFS ≈ 0.70794578. Peak-norm only when the mix exceeds this.
HEADROOM_PEAK = 10.0 ** (-3.0 / 20.0)
HEADROOM_DBFS = -3.0
BUS_SILENCE_DBFS = -50.0
SIDECHAIN_DUCK_DB = 3.5
SIDECHAIN_RELEASE_MS = 60.0
SIDECHAIN_ATTACK_MS = 8.0
# Extra per-bus gain so four parallel stems do not clip before the mix peak-norm.
BUS_STAGE_GAIN = {
    "rhythm": 0.62,
    "bass": 0.55,
    "harmonic": 0.48,
    "vocal": 0.42,
}
BUS_PEAK_CAP = 0.89
# Legacy micro-fade helper (5 ms). Loop *joins* always use 20 ms equal-power.
EQUAL_POWER_FADE_MS = 5.0
EQUAL_POWER_SAMPLES_44K1 = 2048
LOOP_BOUNDARY_FADE_MS = 20.0
BEATS_PER_BAR = 4  # documented 4/4
DEFAULT_BPM = 120.0
DEFAULT_PHRASE_BARS = 8
SHORT_PHRASE_BARS = 4
MAIN_PHRASE_BARS = 16
DEFAULT_SCRATCH = r"D:\MusicDatasets\scratch"
DEFAULT_CHANNELS = 2
PREFERRED_INDEX_DB = r"D:\MusicDatasets\db\corpus_index.sqlite"
FALLBACK_INDEX_DB = r"D:\MusicDatasets\database\corpus_index.sqlite"
SESSION_DIR_MARKERS = frozenset({"session_slices", "session_cache", "staged_slices", "headless_cache"})
LOCKED_LAYERS = ("rhythm", "harmonic", "lead", "vocal")


def default_cooldown(pool_len: int) -> int:
    """Recently-used exclusion: ``min(8, len(pool)//3)``, always leaving one free."""
    n = int(pool_len)
    if n <= 1:
        return 0
    return min(8, max(1, n // 3), n - 1)


class DynamicSliceRotator:
    """Per-layer bank picker with a recent-history cooldown deque."""

    def __init__(
        self,
        slice_pool: list[str],
        cooldown_size: int | None = None,
        rng: random.Random | None = None,
        seed: int | None = None,
    ):
        self.slice_pool = list(slice_pool)
        n = len(self.slice_pool)
        requested = default_cooldown(n) if cooldown_size is None else max(0, int(cooldown_size))
        if n <= 1:
            self.cooldown_size = 0
        else:
            # Leave at least two pool members eligible when the bank is large enough.
            self.cooldown_size = min(requested, max(1, n - 2))
        self.recent_history: deque[str] = deque(maxlen=max(1, self.cooldown_size))
        if seed is not None:
            self.rng = random.Random(seed)
        else:
            self.rng = rng if rng is not None else random.Random()

    def get_section_bank(self, bank_size: int = 6) -> list[str]:
        if not self.slice_pool:
            return []
        available = [s for s in self.slice_pool if s not in self.recent_history]
        if not available:
            available = list(self.slice_pool)
        k = min(int(bank_size), len(available))
        if k <= 0:
            return []
        return self.rng.sample(available, k)

    def choose_slice(self, bank: list[str] | None = None) -> str:
        if not self.slice_pool:
            raise ValueError("slice pool is empty")
        active = list(bank) if bank else list(self.slice_pool)
        candidates = [s for s in active if s not in self.recent_history]
        if not candidates:
            candidates = [s for s in self.slice_pool if s not in self.recent_history]
        if not candidates:
            candidates = list(self.slice_pool)
        if not candidates:
            raise ValueError("no slices available")
        chosen = self.rng.choice(candidates)
        if self.cooldown_size > 0:
            self.recent_history.append(chosen)
        return chosen


def get_section_order(section: dict, original_idx: int) -> int:
    """Chronological priority so song structure flows forward regardless of JSON key order."""
    name = section.get("name", "").lower().strip()
    cleaned_name = name.replace(" ", "_").replace("-", "_")
    best_key: str | None = None
    best_len = -1
    for key in SECTION_PRIORITY:
        if cleaned_name.startswith(key) and len(key) > best_len:
            best_key = key
            best_len = len(key)
    if best_key is not None:
        return SECTION_PRIORITY[best_key]
    return 100 + original_idx


def load_forward_slice(path: str, target_samples: int) -> np.ndarray:
    """Rigid forward window (t=0 → t=T). Kept for grid roles and older callers."""
    data, sr = sf.read(path, always_2d=True)
    return pad_or_trim(data, target_samples, sr=int(sr))


def load_phrase_slice(path: str, target_samples: int, fade_ms: float = 5.0) -> np.ndarray:
    """Pad short phrases or 5 ms fade-trim a long tail to ``target_samples``."""
    data, sr = sf.read(path, always_2d=True)
    return pad_or_trim(data, target_samples, sr=int(sr), fade_ms=fade_ms)


def collect_corpus_wavs(corpus_dir: str) -> list[str]:
    files = glob.glob(os.path.join(corpus_dir, "*.wav"))
    if len(files) < 6:
        files = glob.glob(os.path.join(corpus_dir, "**", "*.wav"), recursive=True)
    files = [p for p in files if os.sep + ".index" + os.sep not in p and not p.endswith(os.sep + ".index")]
    files.sort()
    return files


def equal_power_fade_samples(sr: int, target: int | None = None) -> int:
    """Default equal-power overlap: 5 ms (221 samples at 44.1 kHz).

    Use ``EQUAL_POWER_SAMPLES_44K1`` (2048) for the classic ~46.4 ms window
    at 44.1 kHz. Loop-boundary joins use ``loop_join_fade_samples`` (20 ms).
    """
    return fade_samples(sr, fade_ms=EQUAL_POWER_FADE_MS, target=target)


def loop_join_fade_samples(sr: int, target: int | None = None) -> int:
    """20 ms equal-power overlap at loop boundaries (882 samples at 44.1 kHz)."""
    return fade_samples(sr, fade_ms=LOOP_BOUNDARY_FADE_MS, target=target)


def bars_to_seconds(bars: float, bpm: float, beats_per_bar: int = BEATS_PER_BAR) -> float:
    """Duration of whole bars in 4/4: ``bars * (60 / BPM) * 4``."""
    tempo = max(1e-6, float(bpm))
    return float(bars) * (60.0 / tempo) * float(beats_per_bar)


def seconds_to_bars(seconds: float, bpm: float, beats_per_bar: int = BEATS_PER_BAR) -> int:
    """Nearest whole bar at ``bpm`` in 4/4. Minimum 1."""
    one = bars_to_seconds(1.0, bpm, beats_per_bar)
    if one <= 0:
        return 1
    return max(1, int(round(float(seconds) / one)))


def samples_per_bar(sr: int, bpm: float) -> int:
    """Integer 4/4 bar length: ``int(sr * 240 / bpm)`` — not a 4.0 s grid."""
    tempo = max(1e-6, float(bpm))
    return max(1, int(float(sr) * 240.0 / tempo))


def samples_for_bars(bars: int, bpm: float, sr: int) -> int:
    return max(1, int(bars) * samples_per_bar(sr, bpm))


def preferred_phrase_bars(section: dict) -> int:
    """4-bar intro/outro, 16-bar chorus/drop when the role fits, else 8."""
    name = str(section.get("name") or "").lower().strip()
    cleaned = name.replace(" ", "_").replace("-", "_")
    if cleaned.startswith(("intro", "outro", "ending")):
        return SHORT_PHRASE_BARS
    if cleaned.startswith(("chorus", "drop", "solo")):
        return MAIN_PHRASE_BARS
    return DEFAULT_PHRASE_BARS


def section_bar_count(section: dict, bpm: float) -> int:
    """Whole bars for a section. Default phrase 8; short sections may be 4.

    ``slice_count`` is treated as a bar count (no 4.0 s grid). ``duration_sec``
    is rounded to the nearest whole bar. Missing length uses the section role
    (4-bar intro, 16-bar chorus/drop, else 8).
    """
    if section.get("bars") is not None:
        return max(1, int(section["bars"]))
    if section.get("duration_sec") is not None:
        return seconds_to_bars(float(section["duration_sec"]), bpm)
    if section.get("slice_count") is not None:
        return max(1, int(section["slice_count"]))
    return preferred_phrase_bars(section)


def looks_like_session_corpus(corpus_dir: str) -> bool:
    """Headless cache: ``session_slices`` / scratch, or ``{stem}_*.wav`` names."""
    if not corpus_dir:
        return False
    parts = {p.lower() for p in os.path.normpath(corpus_dir).split(os.sep) if p}
    if parts & SESSION_DIR_MARKERS:
        return True
    return any(collect_session_stem_wavs(corpus_dir, stem) for stem in SESSION_STEMS)


def collect_session_stem_wavs(corpus_dir: str, stem: str) -> list[str]:
    """Additional ``{stem}_*.wav`` lookup used by the headless session cache."""
    if not corpus_dir or not os.path.isdir(corpus_dir):
        return []
    seen: set[str] = set()
    found: list[str] = []
    for pattern in (
        os.path.join(corpus_dir, f"{stem}_*.wav"),
        os.path.join(corpus_dir, "*", f"{stem}_*.wav"),
    ):
        for path in glob.glob(pattern):
            if os.sep + ".index" + os.sep in path:
                continue
            key = os.path.normcase(os.path.abspath(path))
            if key in seen:
                continue
            seen.add(key)
            found.append(path)
    found.sort()
    return found


def merge_session_stem_pools(corpus_dir: str, layers: dict[str, list[str]]) -> dict[str, list[str]]:
    """Prepend ``{stem}_*.wav`` hits. Empty stem glob → no candidates (silence)."""
    extras = {stem: collect_session_stem_wavs(corpus_dir, stem) for stem in SESSION_STEMS}
    if not any(extras.values()):
        return layers
    merged = dict(layers)
    for stem, paths in extras.items():
        if paths:
            seen = set(paths)
            merged[stem] = list(paths) + [p for p in layers.get(stem, []) if p not in seen]
        else:
            merged[stem] = []
    return merged


def scratch_unmastered_path(session_id: str, scratch_root: str | None = None) -> str:
    """Pipeline contract: ``scratch\\$SessionId\\unmastered_mix.wav``."""
    root = scratch_root or os.environ.get("HYBRID_SCRATCH") or DEFAULT_SCRATCH
    return os.path.join(root, session_id, "unmastered_mix.wav")


def _as_channels(audio: np.ndarray, channels: int) -> np.ndarray:
    arr = np.asarray(audio, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr[:, np.newaxis]
    ch = int(channels)
    if arr.shape[1] == ch:
        return arr
    if arr.shape[1] == 1 and ch > 1:
        return np.repeat(arr, ch, axis=1)
    if arr.shape[1] > ch:
        return arr[:, :ch]
    pad = np.zeros((arr.shape[0], ch - arr.shape[1]), dtype=np.float64)
    return np.concatenate((arr, pad), axis=1)


def _silence_block(target_samples: int, channels: int) -> np.ndarray:
    return np.zeros((int(target_samples), int(channels)), dtype=np.float64)


def _infer_channels(paths: list[str], default: int = DEFAULT_CHANNELS) -> int:
    for path in paths:
        if not os.path.isfile(path):
            continue
        try:
            info = sf.info(path)
            if info.channels:
                return int(info.channels)
        except Exception:
            continue
    return int(default)


def _write_pcm24(path: str, audio: np.ndarray, sr: int) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    sf.write(path, audio, sr, subtype="PCM_24")


def _is_bass_path(path: str) -> bool:
    role = infer_role_from_path(path)
    name = os.path.basename(path).lower()
    return role == "bass" or "bass" in name


def _prefer_name(paths: list[str], needle: str) -> list[str]:
    hit = [p for p in paths if needle in os.path.basename(p).lower()]
    return hit or list(paths)


def _exclude_names(paths: list[str], *needles: str) -> list[str]:
    lowered = tuple(n.lower() for n in needles if n)
    if not lowered:
        return list(paths)
    return [p for p in paths if all(n not in os.path.basename(p).lower() for n in lowered)]


def _partition_bass(paths: list[str]) -> tuple[list[str], list[str]]:
    bass: list[str] = []
    rest: list[str] = []
    for path in paths:
        (bass if _is_bass_path(path) else rest).append(path)
    return bass, rest


def junction_zero_crossing(audio: np.ndarray, target_sample: int, sr: int) -> int:
    """Snap a loop junction to a nearby ZC. Audio is ``(n_samples, n_channels)``.

    Search is ±15 ms only — a 250 ms trough walk would eat kick transients.
    """
    arr = np.asarray(audio, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr[:, np.newaxis]
    n = int(arr.shape[0])
    if n <= 1:
        return 0
    target = int(np.clip(int(target_sample), 0, n - 1))
    zc_radius = max(1, int(round(float(sr) * float(ZC_NEAR_TROUGH_MS) / 1000.0)))
    zc = find_nearest_zero_crossing(arr, target, zc_radius)
    return int(zc) if zc is not None else target


def _trim_loop_junctions(loop: np.ndarray, sr: int) -> np.ndarray:
    """ZC-trim start/end of a ``(n, ch)`` loop so OLA joins are not mid-cycle."""
    arr = np.asarray(loop, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr[:, np.newaxis]
    n = int(arr.shape[0])
    if n <= 2:
        return arr
    start = junction_zero_crossing(arr, 0, sr)
    end = junction_zero_crossing(arr, n - 1, sr)
    if end <= start:
        return arr
    return arr[start : end + 1]


def tile_loop_equal_power(
    loop: np.ndarray,
    target_samples: int,
    sr: int,
    fade_ms: float = LOOP_BOUNDARY_FADE_MS,
) -> np.ndarray:
    """Repeat ``loop`` to ``target_samples`` with 20 ms equal-power OLA at each join.

    Loop endpoints are snapped to a zero-crossing (``(n, ch)`` layout) before
    the cosine/sine overlap from ``dsp.micro_crossfader``.
    """
    arr = np.asarray(loop, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr[:, np.newaxis]
    arr = _trim_loop_junctions(arr, int(sr))
    target = int(target_samples)
    channels = int(arr.shape[1]) if arr.ndim == 2 else 1
    if target <= 0:
        return np.zeros((0, channels), dtype=np.float64)
    n = int(arr.shape[0])
    if n <= 0:
        return np.zeros((target, channels), dtype=np.float64)
    if n >= target:
        cut = junction_zero_crossing(arr, target - 1, int(sr)) + 1
        cut = min(max(1, cut), n)
        if cut > target:
            cut = target
        piece = arr[:cut]
        if piece.shape[0] < target:
            pad = np.zeros((target - piece.shape[0], channels), dtype=np.float64)
            return np.concatenate((piece, pad), axis=0)
        return piece[:target].copy()

    fade = fade_samples(int(sr), fade_ms=float(fade_ms), target=n)
    step = n - fade
    if step < 1:
        reps = int(np.ceil(target / float(n)))
        tiled = np.tile(arr, (reps, 1))
        return tiled[:target]

    n_tiles = max(2, int(np.ceil((target - fade) / float(step))))
    out = crossfade_sequence([arr] * n_tiles, fade)
    while out.shape[0] < target:
        out = apply_equal_power_crossfade(out, arr, fade)
    return out[:target]


def snap_cut_to_zc_or_silence(
    audio: np.ndarray,
    target_sample: int,
    sr: int,
    *,
    zc_window_ms: float = ZC_NEAR_TROUGH_MS,
    silence_dbfs: float = SILENCE_FLOOR_DBFS,
    search_window_ms: float = SEARCH_WINDOW_MS,
) -> int:
    """Snap a proposed cut to a silence trough (~−50 dBFS) or a ZC within ±15 ms."""
    mono = to_mono(audio)
    n = int(mono.shape[0])
    if n <= 1:
        return 0
    target = int(np.clip(int(target_sample), 0, n - 1))
    radius = max(1, int(round(float(sr) * float(search_window_ms) / 1000.0)))
    lo = max(0, target - radius)
    hi = min(n, target + radius + 1)
    rms_win = max(1, int(round(float(sr) * 0.010)))
    local_rms = moving_rms(mono[lo:hi], rms_win)
    silence_amp = 10.0 ** (float(silence_dbfs) / 20.0)
    silent = local_rms < silence_amp
    if np.any(silent):
        idxs = np.flatnonzero(silent)
        pick = int(lo + idxs[np.argmin(np.abs((lo + idxs) - target))])
        return pick

    zc_radius = max(1, int(round(float(sr) * float(zc_window_ms) / 1000.0)))
    zc = find_nearest_zero_crossing(audio, target, zc_radius)
    if zc is not None:
        return int(zc)
    return int(find_phrase_zero_crossing(mono, target, int(sr), search_window_ms))


def extract_vocal_loop(data: np.ndarray, sr: int) -> np.ndarray:
    """Vocal phrase bounded by silence (−50 dBFS) or zero-crossings — never a hard index."""
    arr = np.asarray(data, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr[:, np.newaxis]
    n = int(arr.shape[0])
    if n <= 1:
        return arr
    regions = split_on_silence(arr, int(sr), gate_dbfs=SILENCE_FLOOR_DBFS, min_phrase_sec=0.08)
    if regions:
        start, end = max(regions, key=lambda pair: pair[1] - pair[0])
    else:
        start, end = 0, n
    start = snap_cut_to_zc_or_silence(arr, start, int(sr))
    end = snap_cut_to_zc_or_silence(arr, max(start + 1, end - 1 if end > 0 else 0), int(sr))
    if end <= start:
        end = n
    return arr[start:end]


def _load_role_loop(path: str, role: str) -> np.ndarray:
    data, sr = sf.read(path, always_2d=True)
    arr = np.asarray(data, dtype=np.float64)
    if role in {"vocal", "vocals", "vox"} or is_phrase_role(role) and role in {"vocal", "vocals"}:
        return extract_vocal_loop(arr, int(sr))
    if is_phrase_role(role) and role in {"vocal"}:
        return extract_vocal_loop(arr, int(sr))
    return arr


def section_weights(section: dict) -> dict[str, float]:
    weights = section.get("volume_weights") or section.get("layers") or {}
    return {
        "rhythm": float(weights.get("rhythm", 0.0)),
        "harmonic": float(weights.get("harmonic", 0.0)),
        "lead": float(weights.get("lead", 0.0)),
        "vocal": float(weights.get("vocal", 0.0)),
        "bass": float(weights.get("bass", 0.0)),
    }


def default_index_db() -> str:
    env = (os.environ.get("CORPUS_INDEX_DB") or "").strip()
    if env:
        return env
    for candidate in (PREFERRED_INDEX_DB, FALLBACK_INDEX_DB):
        if os.path.isfile(candidate):
            return candidate
    return PREFERRED_INDEX_DB


def _open_slice_index(index_db: str | None) -> sqlite3.Connection | None:
    path = index_db or default_index_db()
    if not path or not os.path.isfile(path):
        return None
    try:
        conn = sqlite3.connect(path)
        row = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='slice_index'"
        ).fetchone()
        if not row or int(row[0]) < 1:
            conn.close()
            return None
        count = conn.execute("SELECT COUNT(*) FROM slice_index").fetchone()
        if not count or int(count[0]) < 1:
            conn.close()
            return None
        return conn
    except sqlite3.Error:
        return None


def _tagged_pool(
    section: dict,
    layer: str,
    fallback: list[str],
    conn: sqlite3.Connection | None,
    target_key: str | None,
) -> list[str]:
    """If ``query_tags[layer]`` is set, rotate from the indexer; else glob pool."""
    tags_map = section.get("query_tags")
    if not tags_map or conn is None:
        return fallback
    tags = tags_map.get(layer) or []
    if not tags:
        return fallback
    hits: list[str] = []
    try:
        from engine.slice_rotator import SliceIndexMissingError, query_rotated_slices

        try:
            hits = query_rotated_slices(
                conn,
                list(tags),
                str(target_key or ""),
                limit=12,
                stem_type=layer,
            )
        except SliceIndexMissingError:
            hits = []
    except Exception:
        hits = []
    if len(hits) < 2:
        try:
            from db.sample_indexer import query_corpus_slices

            hits = query_corpus_slices(
                conn,
                list(tags),
                str(target_key or ""),
                limit=12,
                stem_type=layer,
            )
        except Exception:
            return fallback
    existing = [path for path in hits if os.path.isfile(path)]
    if len(existing) < 2:
        return fallback
    return existing


def _layer_role(section: dict, weight_key: str) -> str:
    """Rhythm stays grid unless tagged; vocal/lead/harmonic keys use phrase gating."""
    section_role = infer_role_from_section(section)
    if section_role:
        if weight_key == "rhythm" and is_grid_role(section_role):
            return section_role
        if weight_key in {"harmonic", "lead", "vocal"} and is_phrase_role(section_role):
            return section_role
    return role_for_weight_key(weight_key)


def _maybe_align_lock(
    audio: np.ndarray,
    sr: int,
    target_samples: int,
    target_key: str | None,
    target_bpm: float | None,
) -> np.ndarray:
    """Optional key/tempo lock. Default assemble leaves audio untouched."""
    if target_key:
        from dsp.pitch_key_aligner import align_slice_to_target_key

        audio = align_slice_to_target_key(audio, target_key, sr=sr)
    if target_bpm:
        from dsp.tempo_time_stretch import lock_slice_to_tempo

        audio = lock_slice_to_tempo(
            audio, target_bpm=float(target_bpm), sr=sr, target_samples=target_samples
        )
    return audio


def _peak_dbfs(audio: np.ndarray) -> float:
    peak = float(np.max(np.abs(audio))) if np.asarray(audio).size else 0.0
    if peak < 1e-12:
        return -120.0
    return float(20.0 * np.log10(peak))


def _bus_rms_dbfs(audio: np.ndarray) -> float:
    arr = np.asarray(audio, dtype=np.float64)
    if arr.size == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(np.square(arr))))
    if rms < 1e-12:
        return -120.0
    return float(20.0 * np.log10(rms))


def apply_r128_normalize(
    audio: np.ndarray,
    sr: int,
    target_lufs: float = -14.0,
    ceiling_dbtp: float = -0.5,
) -> tuple[np.ndarray, float, float]:
    """Opt-in EBU R128 gain + 4x-oversampled true-peak ceiling. Not the default unmastered path."""
    from dsp.loudness_meter import measure_loudness
    from dsp.true_peak_limiter import apply_true_peak_limiter, measure_true_peak_dbtp

    report = measure_loudness(audio, int(sr), target_lufs=float(target_lufs))
    gap = float(target_lufs) - float(report.integrated_lufs)
    gained = np.asarray(audio, dtype=np.float64) * (10.0 ** (gap / 20.0))
    limited = apply_true_peak_limiter(gained, sr=int(sr), ceiling_dbtp=float(ceiling_dbtp))
    final = measure_loudness(limited, int(sr), target_lufs=float(target_lufs))
    dbtp = measure_true_peak_dbtp(limited)
    print(
        f"[R128] integrated={final.integrated_lufs:.2f} LUFS "
        f"(target {float(target_lufs):.1f}) true-peak={dbtp:.2f} dBTP "
        f"(ceiling {float(ceiling_dbtp):.1f})"
    )
    return limited, float(final.integrated_lufs), float(dbtp)


def _stage_bus(name: str, audio: np.ndarray, gain: float) -> tuple[np.ndarray, float]:
    """Apply bus gain and cap per-bus peak so the 4-way sum can hit −3 dBFS."""
    staged = np.asarray(audio, dtype=np.float64) * float(gain)
    peak = float(np.max(np.abs(staged))) if staged.size else 0.0
    if peak > BUS_PEAK_CAP:
        staged = staged * (BUS_PEAK_CAP / peak)
        peak = BUS_PEAK_CAP
    dbfs = _peak_dbfs(staged)
    print(f"[BUS] {name} stage={gain:.2f} peak={dbfs:.1f} dBFS")
    return staged, dbfs


def _pick_rotator_path(rotator: DynamicSliceRotator) -> str | None:
    if not rotator.slice_pool:
        return None
    bank = rotator.get_section_bank(bank_size=6)
    try:
        return rotator.choose_slice(bank)
    except ValueError:
        return None


def _write_section(bus: np.ndarray, start: int, audio: np.ndarray, fade: int) -> None:
    """Place a section on a pre-allocated bus. 20 ms EP at the bar-line join."""
    n = min(int(audio.shape[0]), int(bus.shape[0]) - int(start))
    if n <= 0:
        return
    start = int(start)
    bus[start : start + n] = audio[:n]
    fade = min(int(fade), start, n)
    if fade < 1:
        return
    theta = np.linspace(0.0, 0.5 * np.pi, fade, dtype=np.float64)[:, np.newaxis]
    old = bus[start - fade : start]
    new_head = audio[:fade]
    if old.shape[0] == fade and new_head.shape[0] == fade:
        bus[start - fade : start] = old * np.cos(theta) + new_head * np.sin(theta)


def _choose_locked_loop(
    rotator: DynamicSliceRotator,
    weight: float,
    role: str,
    target_samples: int,
    sr: int,
    target_key: str | None,
    target_bpm: float | None,
    channels: int,
    vocal: bool = False,
    path: str | None = None,
) -> tuple[np.ndarray, str | None]:
    if weight <= SILENCE_WEIGHT or (path is None and not rotator.slice_pool):
        return _silence_block(target_samples, channels), None
    if path is None:
        bank = rotator.get_section_bank(bank_size=6)
        try:
            path = rotator.choose_slice(bank)
        except ValueError:
            return _silence_block(target_samples, channels), None
    if not path or not os.path.isfile(path):
        return _silence_block(target_samples, channels), None
    if vocal or role in {"vocal", "vocals", "vox"}:
        data, file_sr = sf.read(path, always_2d=True)
        loop = extract_vocal_loop(np.asarray(data, dtype=np.float64), int(file_sr))
    else:
        data, _file_sr = sf.read(path, always_2d=True)
        loop = np.asarray(data, dtype=np.float64)
    loop = _maybe_align_lock(loop, sr, int(loop.shape[0]), target_key, target_bpm)
    loop = _as_channels(loop, channels) * float(weight)
    tiled = tile_loop_equal_power(loop, target_samples, sr)
    return tiled, path


ARRANGE_BUSES = ("rhythm", "bass", "harmonic", "vocal")
ACTIVATION_FLOOR = 0.02
ACTIVATION_RAMP_MS = 20.0
# The legacy path caps every bus at 0.89 so a 4-way sum cannot clip. In the
# arranged path the whole mix is peak-normalised to -3 dBFS afterwards anyway,
# and a per-bus cap would silently undo the genre's level balance (a percussive
# bus with a 15 dB crest factor hits the cap long before a pad does). This is a
# runaway guard only; float summing does not clip.
ARRANGED_BUS_PEAK_CAP = 8.0
# Fallback per-bus RMS targets when the blueprint carries no genre profile.
DEFAULT_BUS_TARGET_RMS = {
    "rhythm": -14.0,
    "bass": -15.5,
    "harmonic": -17.5,
    "vocal": -15.5,
}


def section_bus_activation(section: dict) -> dict[str, float] | None:
    """Per-bus gain for a section, or ``None`` when this is a legacy blueprint.

    Falls back to ``volume_weights`` (with ``lead`` folded into ``harmonic``)
    when an explicit ``bus_activation`` map is absent but a bass weight is set.
    """
    raw = section.get("bus_activation")
    if isinstance(raw, dict) and raw:
        return {
            bus: float(np.clip(float(raw.get(bus, 0.0)), 0.0, 1.0))
            for bus in ARRANGE_BUSES
        }
    return None


def _activation_envelope(
    plan: list[tuple[dict, int, int]],
    bus: str,
    total_samples: int,
    sr: int,
) -> np.ndarray:
    """Section gain envelope with 20 ms raised-cosine ramps at every junction.

    Ramping instead of hard-switching is what lets a bus drop fully out for a
    section (bass in the intro, everything but vocal in a pre-drop) without a
    click, while the underlying loop keeps running in phase.
    """
    env = np.zeros((int(total_samples), 1), dtype=np.float64)
    ramp = max(1, int(round(float(sr) * ACTIVATION_RAMP_MS / 1000.0)))
    cursor = 0
    previous = 0.0
    for section, _bars, n in plan:
        activation = section_bus_activation(section) or {}
        gain = float(activation.get(bus, 0.0))
        end = min(int(total_samples), cursor + n)
        if end <= cursor:
            continue
        env[cursor:end, 0] = gain
        span = min(ramp, end - cursor)
        if span > 0 and abs(gain - previous) > 1e-9:
            t = np.linspace(0.0, 1.0, span, endpoint=False, dtype=np.float64)
            env[cursor : cursor + span, 0] = previous + (gain - previous) * (
                0.5 - 0.5 * np.cos(np.pi * t)
            )
        previous = gain
        cursor = end
    if cursor > 0 and previous > 0.0:
        span = min(ramp, cursor)
        t = np.linspace(0.0, 1.0, span, endpoint=False, dtype=np.float64)
        env[cursor - span : cursor, 0] *= 0.5 + 0.5 * np.cos(np.pi * t)
    return env


def _pick_variant_paths(rotator: DynamicSliceRotator, count: int) -> list[str]:
    """Distinct loop variants for one bus, drawn through the cooldown rotator."""
    picks: list[str] = []
    attempts = 0
    while len(picks) < int(count) and attempts < int(count) * 4:
        attempts += 1
        path = _pick_rotator_path(rotator)
        if path is None:
            break
        if path not in picks:
            picks.append(path)
    return picks


def _load_bus_loop(path: str, bus: str) -> np.ndarray:
    data, file_sr = sf.read(path, always_2d=True)
    arr = np.asarray(data, dtype=np.float64)
    if bus == "vocal":
        return extract_vocal_loop(arr, int(file_sr))
    return arr


def _section_segments(
    section: dict,
    bars: int,
    bar_samples: int,
    section_samples: int,
    variant_index: int,
    variant_count: int,
    allow_fills: bool,
) -> list[tuple[int, int, int]]:
    """Split a section into ``(offset, length, variant)`` runs.

    A section is one steady loop by default -- that is what makes it groove.
    Drum fills swap a single bar to the next variant at the end of a phrase.
    """
    fills = set()
    if allow_fills and variant_count > 1:
        fills = {int(b) for b in (section.get("fill_bars") or []) if 0 <= int(b) < bars}
    if not fills:
        return [(0, section_samples, variant_index)]

    fill_variant = (variant_index + 1) % variant_count
    segments: list[tuple[int, int, int]] = []
    run_start = 0
    run_variant = fill_variant if 0 in fills else variant_index
    for bar in range(1, bars + 1):
        current = fill_variant if bar in fills else variant_index
        if bar == bars or current != run_variant:
            start = run_start * bar_samples
            end = min(section_samples, bar * bar_samples)
            if end > start:
                segments.append((start, end - start, run_variant))
            run_start = bar
            run_variant = current
    if run_start < bars:
        start = run_start * bar_samples
        if section_samples > start:
            segments.append((start, section_samples - start, run_variant))
    return segments or [(0, section_samples, variant_index)]


def _render_arranged_bus(
    bus: str,
    variant_paths: list[str],
    plan: list[tuple[dict, int, int]],
    total_samples: int,
    sr: int,
    bpm: float,
    channels: int,
    target_key: str | None,
    target_bpm: float | None,
    fade: int,
) -> tuple[np.ndarray, dict[str, str]]:
    """Tile one loop per section (steady within the phrase), vary across sections."""
    out = np.zeros((int(total_samples), int(channels)), dtype=np.float64)
    used: dict[str, str] = {}
    if not variant_paths:
        return out, used
    cache: dict[str, np.ndarray] = {}
    bar_samples = samples_per_bar(sr, bpm)
    allow_fills = bus == "rhythm"
    cursor = 0
    for section, bars, n in plan:
        variants = section.get("bus_variant") or {}
        index = int(variants.get(bus, 0)) % len(variant_paths)
        segments = _section_segments(
            section, int(bars), bar_samples, int(n), index, len(variant_paths), allow_fills
        )
        for offset, length, variant in segments:
            path = variant_paths[variant % len(variant_paths)]
            loop = cache.get(path)
            if loop is None:
                if not os.path.isfile(path):
                    continue
                loop = _load_bus_loop(path, bus)
                loop = _maybe_align_lock(loop, sr, int(loop.shape[0]), target_key, target_bpm)
                loop = _as_channels(loop, channels)
                cache[path] = loop
            tiled = tile_loop_equal_power(loop, int(length), sr)
            _write_section(out, cursor + offset, tiled, fade)
            used[os.path.basename(path)] = path
        cursor += int(n)
    return out, used


def _stage_bus_to_target(
    name: str,
    audio: np.ndarray,
    envelope: np.ndarray,
    target_dbfs: float,
    peak_cap: float = ARRANGED_BUS_PEAK_CAP,
) -> tuple[np.ndarray, float, float]:
    """Scale a bus so its RMS *over the bars where it is active* hits the target.

    Measuring across the whole timeline would under-read any bus that sits out
    for part of the song, which is exactly what made the vocal bus read -47
    dBFS. Returns ``(staged, measured_dbfs, applied_gain_db)``.
    """
    arr = np.asarray(audio, dtype=np.float64)
    if arr.size == 0:
        return arr, -120.0, 0.0
    active = np.asarray(envelope, dtype=np.float64)[:, 0] > ACTIVATION_FLOOR
    region = arr[active] if bool(np.any(active)) else arr
    measured = _bus_rms_dbfs(region)
    if measured <= -119.0:
        print(f"[BUS] {name} silent source; no gain staging applied")
        return arr, measured, 0.0
    gain_db = float(target_dbfs) - measured
    staged = arr * (10.0 ** (gain_db / 20.0))
    peak = float(np.max(np.abs(staged))) if staged.size else 0.0
    if peak > float(peak_cap):
        trim = float(peak_cap) / peak
        staged = staged * trim
        gain_db += 20.0 * np.log10(trim)
        print(f"[BUS] {name} peak-capped {20.0 * np.log10(trim):+.1f} dB at {peak_cap:.2f}")
    print(
        f"[BUS] {name} source_rms={measured:.1f} dBFS -> target {float(target_dbfs):.1f} "
        f"dBFS (gain {gain_db:+.1f} dB)"
    )
    return staged, measured, gain_db


def _active_rms_dbfs(audio: np.ndarray, envelope: np.ndarray) -> float:
    arr = np.asarray(audio, dtype=np.float64)
    if arr.size == 0:
        return -120.0
    active = np.asarray(envelope, dtype=np.float64)[:, 0] > ACTIVATION_FLOOR
    region = arr[active] if bool(np.any(active)) else arr
    return _bus_rms_dbfs(region)


def _finalize_mix(
    full_mix: np.ndarray,
    sr: int,
    output_wav: str,
    session_id: str | None,
    scratch_root: str | None,
    normalize_lufs: float | None,
    ceiling_dbtp: float,
    source_trace: dict | None,
) -> str:
    """Shared write tail: -3 dBFS headroom, session contract copy, opt-in R128."""
    peak = float(np.max(np.abs(full_mix))) if full_mix.size else 0.0
    if peak > HEADROOM_PEAK:
        full_mix = full_mix * (HEADROOM_PEAK / peak)
    print(
        f"[MIX] unmastered peak={_peak_dbfs(full_mix):.2f} dBFS "
        f"(target {HEADROOM_DBFS:.1f} dBFS sample-peak, not true-peak)"
    )
    _write_pcm24(output_wav, full_mix, sr)
    if session_id:
        contract = scratch_unmastered_path(session_id, scratch_root)
        if os.path.abspath(contract) != os.path.abspath(output_wav):
            _write_pcm24(contract, full_mix, sr)
            print(f"[SESSION] Wrote pipeline mix: {contract}")
    if normalize_lufs is not None:
        full_mix, lufs_val, dbtp_val = apply_r128_normalize(
            full_mix, sr, target_lufs=float(normalize_lufs), ceiling_dbtp=float(ceiling_dbtp)
        )
        _write_pcm24(output_wav, full_mix, sr)
        if source_trace is not None:
            source_trace["_r128"] = {"lufs": lufs_val, "dbtp": dbtp_val}
    duration_sec = full_mix.shape[0] / sr
    print(f"[SUCCESS] Mix assembled vertical 4-bus 4/4: {output_wav} ({duration_sec:.1f}s)")
    return output_wav


def _arranged_bus_pools(
    rotators: dict[str, DynamicSliceRotator],
    plan: list[tuple[dict, int, int]],
) -> dict[str, list[str]]:
    """Draw as many distinct loop variants per bus as the section map references."""
    needed = {bus: 1 for bus in ARRANGE_BUSES}
    for section, _bars, _n in plan:
        for bus, index in (section.get("bus_variant") or {}).items():
            if bus in needed:
                needed[bus] = max(needed[bus], int(index) + 1)
    # A drum fill borrows the next variant, so rhythm always wants a spare.
    if any(section.get("fill_bars") for section, _b, _n in plan):
        needed["rhythm"] = max(needed["rhythm"], 2)

    pools: dict[str, list[str]] = {}
    for bus in ARRANGE_BUSES:
        source = rotators.get(bus)
        picks = _pick_variant_paths(source, needed[bus]) if source else []
        if not picks and bus == "harmonic":
            lead = rotators.get("lead")
            picks = _pick_variant_paths(lead, needed[bus]) if lead else []
        pools[bus] = picks
    return pools


def assemble_arranged_buses(
    plan: list[tuple[dict, int, int]],
    rotators: dict[str, DynamicSliceRotator],
    total_samples: int,
    sr: int,
    bpm: float,
    channels: int,
    target_key: str | None,
    target_bpm: float | None,
    fade: int,
    bus_targets: dict[str, float] | None = None,
    source_trace: dict | None = None,
) -> dict[str, np.ndarray]:
    """Render the four buses from a per-section activation map.

    Loops stay steady inside a section (one loop per bus per phrase — the
    8-bar lock), vary across sections via ``bus_variant``, and are gated by a
    ramped activation envelope so a bus can drop right out for a section.
    The map is produced by ``engine.local_song_conductor``. Gain staging
    targets a per-bus RMS from the genre profile instead of a fixed multiplier.
    """
    targets = dict(DEFAULT_BUS_TARGET_RMS)
    targets.update({k: float(v) for k, v in (bus_targets or {}).items() if k in targets})

    pools = _arranged_bus_pools(rotators, plan)
    envelopes: dict[str, np.ndarray] = {}
    raw: dict[str, np.ndarray] = {}
    sources: dict[str, dict[str, str]] = {}
    for bus in ARRANGE_BUSES:
        audio, used = _render_arranged_bus(
            bus, pools[bus], plan, total_samples, sr, bpm, channels,
            target_key, target_bpm, fade,
        )
        env = _activation_envelope(plan, bus, total_samples, sr)
        envelopes[bus] = env
        raw[bus] = audio * env
        sources[bus] = used
        print(
            f"[ARRANGE] {bus} variants={len(pools[bus])} "
            f"({', '.join(os.path.basename(p) for p in pools[bus]) or '-'})"
        )

    if raw["bass"].size and raw["rhythm"].size and pools["bass"] and pools["rhythm"]:
        from dsp.stem_sidechain_glue import apply_sidechain_glue

        duck_floor = 10.0 ** (-SIDECHAIN_DUCK_DB / 20.0)
        raw["bass"] = apply_sidechain_glue(
            raw["bass"],
            raw["rhythm"],
            sr=int(sr),
            ducking_ratio=duck_floor,
            attack_ms=SIDECHAIN_ATTACK_MS,
            release_ms=SIDECHAIN_RELEASE_MS,
            cutoff_hz=100.0,
        )
        print(
            f"[SIDECHAIN] bass ducked {SIDECHAIN_DUCK_DB:.1f} dB on kick "
            f"(Butterworth LPF, release={SIDECHAIN_RELEASE_MS:.0f} ms)"
        )

    staged: dict[str, np.ndarray] = {}
    for bus in ARRANGE_BUSES:
        staged[bus], measured, gain_db = _stage_bus_to_target(
            bus, raw[bus], envelopes[bus], targets[bus]
        )
        if source_trace is not None:
            source_trace.setdefault("_buses", {})[bus] = {
                "target_rms_dbfs": targets[bus],
                "source_rms_dbfs": round(measured, 2),
                "gain_db": round(gain_db, 2),
                "variants": list(sources[bus].values()),
            }
    staged["_envelopes"] = envelopes  # type: ignore[assignment]
    return staged


def assemble_from_blueprint(
    blueprint_path: str,
    corpus_dir: str,
    output_wav: str,
    sr: int = 44100,
    seed: int | None = None,
    target_key: str | None = None,
    target_bpm: float | None = None,
    index_db: str | None = None,
    use_index: bool = True,
    session_id: str | None = None,
    scratch_root: str | None = None,
    crossfade_samples: int | None = None,
    source_trace: dict | None = None,
    normalize_lufs: float | None = None,
    ceiling_dbtp: float = -0.5,
) -> str:
    if not os.path.exists(blueprint_path):
        raise FileNotFoundError(f"Blueprint file not found: {blueprint_path}")

    with open(blueprint_path, "r", encoding="utf-8") as f:
        blueprint = json.load(f)

    slice_pool = collect_corpus_wavs(corpus_dir)
    if len(slice_pool) < 6:
        raise ValueError(f"Corpus needs at least 6 slices. Found {len(slice_pool)} in {corpus_dir}")

    layers = split_pool_by_layer(slice_pool)
    if looks_like_session_corpus(corpus_dir):
        layers = merge_session_stem_pools(corpus_dir, layers)

    bass_from_r, drums_only = _partition_bass(layers.get("rhythm") or [])
    bass_from_h, harm_rest = _partition_bass(layers.get("harmonic") or [])
    bass_session = collect_session_stem_wavs(corpus_dir, "bass")
    bass_pool: list[str] = []
    for path in bass_from_r + bass_from_h + bass_session:
        if path not in bass_pool:
            bass_pool.append(path)
    rhythm_pool = drums_only if drums_only else (layers.get("rhythm") or [])
    harmonic_pool = harm_rest if harm_rest else (layers.get("harmonic") or [])
    if not drums_only:
        bass_pool = [p for p in bass_pool if p not in rhythm_pool]
    # MUSDB-style packs: never layer the stereo mixture; prefer drums / other / bass.
    rhythm_pool = _prefer_name(_exclude_names(rhythm_pool, "mixture", "bass"), "drum")
    harmonic_pool = _prefer_name(_exclude_names(harmonic_pool, "mixture", "bass"), "other")
    bass_pool = _prefer_name(_exclude_names(bass_pool, "mixture"), "bass")

    rng = random.Random(seed)
    fallback_rotators = {
        "rhythm": DynamicSliceRotator(rhythm_pool, rng=rng),
        "harmonic": DynamicSliceRotator(harmonic_pool, rng=rng),
        "lead": DynamicSliceRotator(layers.get("lead") or [], rng=rng),
        "vocal": DynamicSliceRotator(layers.get("vocal") or [], rng=rng),
        "bass": DynamicSliceRotator(bass_pool, rng=rng),
    }
    channels = _infer_channels(slice_pool)

    meta = blueprint.get("track_metadata") or {}
    bpm = float(target_bpm or meta.get("bpm") or DEFAULT_BPM)
    index_conn = _open_slice_index(index_db) if use_index else None
    index_key = str(target_key or meta.get("root_key") or "")

    xfade_len = (
        int(crossfade_samples)
        if crossfade_samples is not None
        else loop_join_fade_samples(sr)
    )

    raw_sections = blueprint.get("sections", [])
    if not raw_sections:
        raise ValueError("Blueprint contains no sections to assemble.")

    # A local_song_conductor section map is already chronological (and contains
    # names like ``pre_drop`` that SECTION_PRIORITY would shove to the end), so
    # only legacy blueprints get re-sorted into song order.
    if all(section_bus_activation(section) is not None for section in raw_sections):
        sorted_sections = list(enumerate(raw_sections))
    else:
        sorted_sections = sorted(
            enumerate(raw_sections),
            key=lambda item: get_section_order(item[1], item[0]),
        )

    bar_sec = bars_to_seconds(1, bpm)
    bar_n = samples_per_bar(sr, bpm)
    section_plan: list[tuple[int, dict, int, int, float]] = []
    total_samples = 0
    max_w = {"rhythm": 0.0, "harmonic": 0.0, "lead": 0.0, "vocal": 0.0, "bass": 0.0}
    for orig_idx, section in sorted_sections:
        bars = section_bar_count(section, bpm)
        n = samples_for_bars(bars, bpm, sr)
        weights = section_weights(section)
        for key in max_w:
            max_w[key] = max(max_w[key], float(weights.get(key, 0.0)))
        section_plan.append((orig_idx, section, bars, n, bars_to_seconds(bars, bpm)))
        total_samples += n
    if total_samples < 1:
        raise ValueError("Blueprint sections produced zero samples.")

    print(
        f"[*] Assembling VERTICAL 4-bus mix @ {bpm:.1f} BPM "
        f"(samples_per_bar={bar_n}, 1 bar = {bar_sec:.3f}s, "
        f"loop join = {LOOP_BOUNDARY_FADE_MS:.0f} ms EP / {loop_join_fade_samples(sr)} samples, "
        f"{len(section_plan)} sections, {total_samples / sr:.1f}s)..."
    )

    plan_sections = [(section, bars, n) for _i, section, bars, n, _d in section_plan]
    use_arrangement = bool(plan_sections) and all(
        section_bus_activation(section) is not None for section, _b, _n in plan_sections
    )

    if use_arrangement:
        arrange_meta = blueprint.get("arrangement") or {}
        bus_targets = arrange_meta.get("bus_target_rms_dbfs") or {}
        print(
            f"[ARRANGE] section map active: {len(plan_sections)} sections, "
            f"genre={arrange_meta.get('genre', '?')} family={arrange_meta.get('family', '?')} "
            f"seed={arrange_meta.get('seed', seed)}"
        )
        try:
            staged = assemble_arranged_buses(
                plan_sections,
                fallback_rotators,
                total_samples,
                sr,
                bpm,
                channels,
                target_key,
                target_bpm,
                xfade_len,
                bus_targets=bus_targets,
                source_trace=source_trace,
            )
        finally:
            if index_conn is not None:
                index_conn.close()

        envelopes = staged.pop("_envelopes")
        for _idx, section, bars, _n, sec_dur in section_plan:
            activation = section_bus_activation(section) or {}
            variants = section.get("bus_variant") or {}
            print(
                f"  -> [{section.get('name', 'section')}]: {bars} bars "
                f"({sec_dur:.3f}s) "
                + " ".join(
                    f"{bus[0].upper()}:{activation.get(bus, 0.0):.2f}"
                    f"/v{int(variants.get(bus, 0))}"
                    for bus in ARRANGE_BUSES
                )
                + (f" fills={section.get('fill_bars')}" if section.get("fill_bars") else "")
            )
            if source_trace is not None:
                source_trace[str(section.get("name", "section"))] = {
                    "bars": bars,
                    "duration_sec": sec_dur,
                    "bus_activation": dict(activation),
                    "bus_variant": {b: int(variants.get(b, 0)) for b in ARRANGE_BUSES},
                    "fill_bars": list(section.get("fill_bars") or []),
                }

        full_mix = sum(staged[bus] for bus in ARRANGE_BUSES)
        mix_peak = float(np.max(np.abs(full_mix))) if full_mix.size else 0.0
        headroom_trim = (HEADROOM_PEAK / mix_peak) if mix_peak > HEADROOM_PEAK else 1.0
        for bus in ARRANGE_BUSES:
            final_rms = _active_rms_dbfs(staged[bus] * headroom_trim, envelopes[bus])
            silent = final_rms < BUS_SILENCE_DBFS
            print(
                f"[BUS] {bus} {'SILENT' if silent else 'ok'} "
                f"final_active_rms={final_rms:.1f} dBFS"
            )
            if silent:
                print(f"[WARN] {bus} bus is silent — not a vertical 4-layer mix on this stem.")
            if source_trace is not None:
                source_trace.setdefault("_buses", {}).setdefault(bus, {})[
                    "final_active_rms_dbfs"
                ] = round(final_rms, 2)
        if source_trace is not None:
            source_trace["_track"] = {"samples": total_samples, "arranged": True}
        return _finalize_mix(
            full_mix, sr, output_wav, session_id, scratch_root,
            normalize_lufs, ceiling_dbtp, source_trace,
        )

    track_r_path = _pick_rotator_path(fallback_rotators["rhythm"])
    track_b_path = _pick_rotator_path(fallback_rotators["bass"])
    track_h_path = _pick_rotator_path(fallback_rotators["harmonic"])
    if track_h_path is None:
        track_h_path = _pick_rotator_path(fallback_rotators["lead"])
    track_v_path = _pick_rotator_path(fallback_rotators["vocal"])
    print(
        "[LOCK] track-wide "
        f"drum={os.path.basename(track_r_path) if track_r_path else '-'} "
        f"bass={os.path.basename(track_b_path) if track_b_path else '-'} "
        f"harmonic={os.path.basename(track_h_path) if track_h_path else '-'} "
        f"vocal={os.path.basename(track_v_path) if track_v_path else '-'}"
    )

    w_r = max_w["rhythm"] if max_w["rhythm"] > SILENCE_WEIGHT else 0.80
    w_h = max(max_w["harmonic"], max_w["lead"])
    if w_h <= SILENCE_WEIGHT:
        w_h = 0.55 if track_h_path else 0.0
    w_v = max_w["vocal"]
    if track_v_path and w_v <= SILENCE_WEIGHT:
        w_v = 0.40
    w_b = max_w["bass"]
    if track_b_path and w_b <= SILENCE_WEIGHT:
        w_b = 0.65

    layer_args = (total_samples, sr, target_key, target_bpm, channels)
    try:
        r_bus, r_path = _choose_locked_loop(
            fallback_rotators["rhythm"], w_r, "rhythm", *layer_args, path=track_r_path
        )
        b_bus, b_path = _choose_locked_loop(
            fallback_rotators["bass"], w_b, "bass", *layer_args, path=track_b_path
        )
        h_bus, h_path = _choose_locked_loop(
            fallback_rotators["harmonic"], w_h, "harmonic", *layer_args, path=track_h_path
        )
        v_bus, v_path = _choose_locked_loop(
            fallback_rotators["vocal"], w_v, "vocal", *layer_args, vocal=True, path=track_v_path
        )

        if r_path and b_path and b_bus.size:
            from dsp.stem_sidechain_glue import apply_sidechain_glue

            duck_floor = 10.0 ** (-SIDECHAIN_DUCK_DB / 20.0)
            b_bus = apply_sidechain_glue(
                b_bus,
                r_bus,
                sr=int(sr),
                ducking_ratio=duck_floor,
                attack_ms=SIDECHAIN_ATTACK_MS,
                release_ms=SIDECHAIN_RELEASE_MS,
                cutoff_hz=100.0,
            )
            print(
                f"[SIDECHAIN] bass ducked {SIDECHAIN_DUCK_DB:.1f} dB on kick "
                f"(Butterworth LPF, release={SIDECHAIN_RELEASE_MS:.0f} ms)"
            )

        r_bus, _ = _stage_bus("rhythm", r_bus, BUS_STAGE_GAIN["rhythm"])
        b_bus, _ = _stage_bus("bass", b_bus, BUS_STAGE_GAIN["bass"])
        h_bus, _ = _stage_bus("harmonic", h_bus, BUS_STAGE_GAIN["harmonic"])
        v_bus, _ = _stage_bus("vocal", v_bus, BUS_STAGE_GAIN["vocal"])

        buses = {
            "rhythm": (r_bus, r_path),
            "bass": (b_bus, b_path),
            "harmonic": (h_bus, h_path),
            "vocal": (v_bus, v_path),
        }
        for name, (bus, path) in buses.items():
            rms_db = _bus_rms_dbfs(bus)
            silent = rms_db < BUS_SILENCE_DBFS
            flag = "SILENT" if silent else "ok"
            print(
                f"[BUS] {name} {flag} rms={rms_db:.1f} dBFS "
                f"src={os.path.basename(path) if path else '-'}"
            )
            if silent:
                print(f"[WARN] {name} bus is silent — not a vertical 4-layer mix on this stem.")

        for orig_idx, section, bars, _n, sec_dur in section_plan:
            sec_name = section.get("name", f"Section_{orig_idx}")
            print(
                f"  -> [{sec_name}]: {bars} bars ({sec_dur:.3f}s) parallel "
                f"R:{os.path.basename(r_path) if r_path else '-'} "
                f"B:{os.path.basename(b_path) if b_path else '-'} "
                f"H:{os.path.basename(h_path) if h_path else '-'} "
                f"V:{os.path.basename(v_path) if v_path else '-'}"
            )
            if source_trace is not None:
                source_trace[sec_name] = {
                    "bars": bars,
                    "duration_sec": sec_dur,
                    "rhythm": r_path,
                    "bass": b_path,
                    "harmonic": h_path,
                    "lead": h_path,
                    "vocal": v_path,
                }
        if source_trace is not None:
            source_trace["_track"] = {
                "rhythm": r_path,
                "bass": b_path,
                "harmonic": h_path,
                "vocal": v_path,
                "samples": total_samples,
            }
    finally:
        if index_conn is not None:
            index_conn.close()

    full_mix = r_bus + b_bus + h_bus + v_bus
    return _finalize_mix(
        full_mix, sr, output_wav, session_id, scratch_root,
        normalize_lufs, ceiling_dbtp, source_trace,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--blueprint", required=True)
    parser.add_argument("--corpus", default=r"D:\MusicDatasets\corpus_4s")
    parser.add_argument("--out", required=True)
    parser.add_argument("--sr", type=int, default=44100)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--target-key", default=None, help="Optional root to pitch-align slices")
    parser.add_argument("--bpm", dest="target_bpm", type=float, default=None, help="Optional tempo lock")
    parser.add_argument("--index-db", default=None, help="Optional slice_index sqlite (query_tags)")
    parser.add_argument("--no-index", action="store_true", help="Ignore query_tags / slice_index")
    parser.add_argument(
        "--session",
        default=None,
        help="Also write scratch\\<id>\\unmastered_mix.wav (run_master_pipeline.ps1 input)",
    )
    parser.add_argument("--scratch", default=DEFAULT_SCRATCH, help="Scratch root for --session")
    parser.add_argument(
        "--crossfade-samples",
        type=int,
        default=None,
        help=(
            "Equal-power overlap between *sections* in samples "
            f"(loop joins are always {LOOP_BOUNDARY_FADE_MS:.0f} ms / "
            "882 @ 44.1 kHz)"
        ),
    )
    parser.add_argument(
        "--normalize-lufs",
        type=float,
        default=None,
        help="Opt-in EBU R128 integrated LUFS for standalone renders (default: unmastered -3 dBFS)",
    )
    parser.add_argument(
        "--ceiling-dbtp",
        type=float,
        default=-0.5,
        help="True-peak ceiling in dBTP when --normalize-lufs is set (4x oversampled)",
    )
    args = parser.parse_args()
    try:
        assemble_from_blueprint(
            args.blueprint,
            args.corpus,
            args.out,
            sr=args.sr,
            seed=args.seed,
            target_key=args.target_key,
            target_bpm=args.target_bpm,
            index_db=args.index_db,
            use_index=not args.no_index,
            session_id=args.session,
            scratch_root=args.scratch,
            crossfade_samples=args.crossfade_samples,
            normalize_lufs=args.normalize_lufs,
            ceiling_dbtp=args.ceiling_dbtp,
        )
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
