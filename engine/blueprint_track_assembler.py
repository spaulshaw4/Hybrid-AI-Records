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
import re
import sqlite3
import sys
from collections import deque
from dataclasses import asdict

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


def _order_preferring_name(paths: list[str], needle: str) -> list[str]:
    """Move names containing ``needle`` to the front. Never drops a candidate.

    This used to return the matching subset and fall back to the whole pool
    only when nothing matched, which made it a hard filter: a single staged
    file happening to carry "other" in its name discarded every other variant
    and collapsed the bus to one loop for the whole song. Role separation is
    already done upstream -- by ``stem_type`` in the index query and by
    ``split_pool_by_layer`` here -- and every survivor has been scored on key,
    tempo, centroid and chroma, so the filename is only a tiebreak hint. A hint
    must not be allowed to empty a pool the section map needs variants from.
    """
    lowered = needle.lower()
    hit = [p for p in paths if lowered in os.path.basename(p).lower()]
    rest = [p for p in paths if lowered not in os.path.basename(p).lower()]
    return hit + rest


def _exclude_names(paths: list[str], *needles: str) -> list[str]:
    lowered = tuple(n.lower() for n in needles if n)
    if not lowered:
        return list(paths)
    return [p for p in paths if all(n not in os.path.basename(p).lower() for n in lowered)]


# A staged session copy carries its destination bus as a leading token
# (``harmonic_`` + the original slice name, see
# ``generate_track_headless.stage_scored_session_cache``), so the artifact's own
# role token is the second one.
_STAGED_BUS_PREFIXES = tuple(f"{stem}_" for stem in ("rhythm", "harmonic", "lead", "vocal", "bass"))


def _is_full_mixture(path: str) -> bool:
    """True only for the unseparated full mix of a source-separation pack.

    Never layer a full stereo mixture over isolated drum and bass stems: the
    mixture already contains them, so summing it back in comb-filters and
    phase-cancels against the very stems it was separated from. That is what
    this guard is for and it is still right.

    What it must not catch is a phrase loop *cut from* a mixture. Those are a
    few bars of chords and motifs -- the richest harmonic material in the
    corpus -- and the scorer has already judged their key, tempo, centroid and
    chroma. The two cases are told apart by which token leads the name, the
    same prefix-anchored convention the index query and
    ``stem_selector.role_from_filename`` use:

      ``mixture.wav``, ``mixture_s4_00000.wav``          -> the pack's full mix
      ``020_james_may_dont_let_go__mixture_phrase_0048`` -> a phrase cut from one

    Substring-matching "mixture" conflated them and starved the harmonic bus to
    zero or one variant on every live-corpus render.
    """
    name = os.path.splitext(os.path.basename(path))[0].lower()
    for prefix in _STAGED_BUS_PREFIXES:
        if name.startswith(prefix):
            name = name[len(prefix) :]
            break
    return name == "mixture" or name.startswith("mixture_") or name.startswith("mixture-")


def _exclude_full_mixtures(paths: list[str]) -> list[str]:
    return [p for p in paths if not _is_full_mixture(p)]


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
        tiled = np.tile(apply_slice_crossfade(arr, fade_ms=2.0, sr=int(sr)), (reps, 1))
        return tiled[:target]

    n_tiles = max(2, int(np.ceil((target - fade) / float(step))))
    out = crossfade_sequence([arr] * n_tiles, fade)
    while out.shape[0] < target:
        out = apply_equal_power_crossfade(out, arr, fade)
    return out[:target]


SLICE_EDGE_FADE_MS = 20.0


def apply_slice_crossfade(
    slice_audio: np.ndarray,
    fade_ms: float = SLICE_EDGE_FADE_MS,
    sr: int = 44100,
    *,
    fade_in: bool = True,
    fade_out: bool = True,
) -> np.ndarray:
    """Equal-power (sin/cos) fade-in and release on a slice's buffer edges."""
    audio = np.array(slice_audio, dtype=np.float64, copy=True)
    n = int(audio.shape[0]) if audio.ndim else 0
    fade = int(round(float(fade_ms) / 1000.0 * float(sr)))
    if fade < 1 or n < fade * 2:
        return audio
    t = np.linspace(0.0, np.pi / 2.0, fade, dtype=np.float64)
    gain_in = np.sin(t)
    gain_out = np.cos(t)
    if audio.ndim == 2:
        gain_in = gain_in[:, np.newaxis]
        gain_out = gain_out[:, np.newaxis]
    if fade_in:
        audio[:fade] *= gain_in
    if fade_out:
        audio[-fade:] *= gain_out
    return audio


def loop_period_samples(loop_samples: int, sr: int, bpm: float) -> int:
    """Whole-bar period (>= 1 bar) nearest to the loop's natural length."""
    bar = samples_per_bar(int(sr), float(bpm))
    if bar < 1:
        return max(1, int(loop_samples))
    return max(1, int(round(float(loop_samples) / float(bar)))) * bar


def make_grid_loop(
    loop: np.ndarray,
    period: int,
    sr: int,
    fade_ms: float = LOOP_BOUNDARY_FADE_MS,
) -> np.ndarray:
    """Exactly ``period`` samples that repeat seamlessly on the bar grid.

    When the source runs past ``period``, the overhang is equal-power blended
    into the head, so the wrap point continues the audio instead of cutting it.
    A short source is released with an edge fade and padded with silence.
    """
    arr = np.asarray(loop, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr[:, np.newaxis]
    period = max(1, int(period))
    channels = int(arr.shape[1])
    fade = min(fade_samples(int(sr), fade_ms=float(fade_ms), target=period), period // 2)
    if arr.shape[0] >= period + fade and fade > 0:
        out = arr[:period].copy()
        theta = np.linspace(0.0, 0.5 * np.pi, fade, dtype=np.float64)[:, np.newaxis]
        out[:fade] = arr[period : period + fade] * np.cos(theta) + out[:fade] * np.sin(theta)
        return out
    body = arr[: min(arr.shape[0], period)]
    body = apply_slice_crossfade(body, fade_ms=float(fade_ms), sr=int(sr), fade_in=False)
    if body.shape[0] < period:
        body = np.concatenate(
            (body, np.zeros((period - body.shape[0], channels), dtype=np.float64)), axis=0
        )
    return body


def tile_loop_on_grid(
    loop: np.ndarray,
    target_samples: int,
    sr: int,
    bpm: float,
    fade_ms: float = LOOP_BOUNDARY_FADE_MS,
) -> np.ndarray:
    """Repeat a loop with a whole-bar period so every repeat lands on a barline."""
    arr = np.asarray(loop, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr[:, np.newaxis]
    target = max(0, int(target_samples))
    if target == 0 or arr.shape[0] == 0:
        return np.zeros((target, int(arr.shape[1]) if arr.ndim == 2 else 1), dtype=np.float64)
    period = loop_period_samples(int(arr.shape[0]), int(sr), float(bpm))
    unit = make_grid_loop(arr, period, int(sr), fade_ms=fade_ms)
    reps = int(np.ceil(target / float(period)))
    return np.tile(unit, (reps, 1))[:target]


# Filename hints for background ad-lib / chant chops ("oh-oh", "yeah", shouts).
ADLIB_NAME_TOKENS = (
    "adlib", "ad_lib", "ad-lib", "chant", "shout", "yeah", "hey", "ooh", "ohh",
    "_oh_", "chop", "vox_fx", "vocal_fx", "scream",
)
# A vocal phrase shorter than this is treated as an ad-lib, not a topline.
# corpus_4s vocal slices are 4.0 s (~1.8 bars at 110 BPM) and must stay looped.
ADLIB_MAX_BARS = 1.0
ADLIB_SPACING_BARS = 4
# Where ad-libs may sit. With lyrics expected they are restricted to
# transitions and chorus drops; without lyrics they may also dress verses.
ADLIB_SECTIONS_LEAD = frozenset({"chorus", "drop", "pre_drop", "build", "pre_chorus"})
ADLIB_SECTIONS_OPEN = ADLIB_SECTIONS_LEAD | frozenset({"verse", "bridge", "breakdown"})
VOCAL_MODES = frozenset({"lead", "adlib", "none"})


def is_adlib_vocal(path: str, phrase_samples: int, sr: int, bpm: float) -> bool:
    """Short or ad-lib-named vocal phrases are background chops, not a lead line."""
    name = os.path.basename(str(path or "")).lower()
    if any(token in name for token in ADLIB_NAME_TOKENS):
        return True
    bar = samples_per_bar(int(sr), float(bpm))
    return bar > 0 and float(phrase_samples) < ADLIB_MAX_BARS * float(bar)


# Buses that follow the harmonic roadmap (loops are staged in the song key).
CHORD_FOLLOW_BUSES = frozenset({"harmonic", "bass"})
_PITCH_CLASS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def chord_root_pc(symbol: str | None) -> int | None:
    """Pitch class of a chord symbol's root (``"F#m7"`` -> 6), or ``None``."""
    text = str(symbol or "").strip()
    if not text or text[0].upper() not in _PITCH_CLASS:
        return None
    pc = _PITCH_CLASS[text[0].upper()]
    if len(text) > 1 and text[1] in "#b":
        pc += 1 if text[1] == "#" else -1
    return pc % 12


def section_chord_offsets(
    chords: list[str] | None,
    bars: int,
    bars_per_chord: int,
    key: str | None,
    scale: str | None = None,
) -> list[int] | None:
    """Per-bar semitone shift from the song key to each bar's chord root.

    Shortest wrap onto [-6, +5] so no loop is shifted more than a tritone.
    A root that is not a degree of ``scale`` stays on the tonic: the song
    does not leave its key. ``None`` when the section has no chords or the
    key cannot be parsed.
    """
    key_pc = chord_root_pc(key)
    if key_pc is None or not chords:
        return None
    roots = [chord_root_pc(c) for c in chords]
    if any(r is None for r in roots):
        return None
    allowed = _scale_pitch_classes(key, scale) if scale else None
    per = max(1, int(bars_per_chord))
    out: list[int] = []
    for bar in range(max(0, int(bars))):
        root = int(roots[(bar // per) % len(roots)])
        if allowed is not None and root not in allowed:
            out.append(0)
            continue
        out.append((root - key_pc + 6) % 12 - 6)
    return out


def _scale_pitch_classes(key: str | None, scale: str | None) -> set[int] | None:
    """Pitch classes that belong to the song. Empty when the key will not parse."""
    from engine.song_plan import NOTE_NAMES, _scale_pc_offsets

    key_pc = chord_root_pc(key)
    if key_pc is None:
        return None
    root_name = NOTE_NAMES[key_pc]
    offsets = _scale_pc_offsets(str(scale or "minor"))
    return {(NOTE_NAMES.index(root_name) + step) % 12 for step in offsets}


def _chord_spans(bar_shifts: list[int], first_bar: int, length: int, bar: int) -> list[tuple[int, int, int]]:
    """``(start, end, semitones)`` runs inside a segment starting at ``first_bar``."""
    spans: list[tuple[int, int, int]] = []
    start = 0
    while start < length:
        index = min(len(bar_shifts) - 1, first_bar + start // bar)
        shift = int(bar_shifts[index])
        end = min(length, (start // bar + 1) * bar)
        if spans and spans[-1][2] == shift and spans[-1][1] == start:
            spans[-1] = (spans[-1][0], end, shift)
        else:
            spans.append((start, end, shift))
        start = end
    return spans


def _section_role(section: dict) -> str:
    role = str(section.get("role") or "").strip().lower()
    if role:
        return role
    name = str(section.get("name") or "").strip().lower()
    for known in ("pre_drop", "pre_chorus", "chorus", "drop", "build", "verse",
                  "bridge", "breakdown", "intro", "outro"):
        if name.startswith(known):
            return known
    return name


def place_adlib_phrases(
    phrase: np.ndarray,
    length: int,
    sr: int,
    bpm: float,
    spacing_bars: int = ADLIB_SPACING_BARS,
) -> np.ndarray:
    """One-shot ad-lib at the last bar of each ``spacing_bars`` phrase (no looping)."""
    arr = np.asarray(phrase, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr[:, np.newaxis]
    out = np.zeros((max(0, int(length)), int(arr.shape[1])), dtype=np.float64)
    bar = samples_per_bar(int(sr), float(bpm))
    if bar < 1 or out.shape[0] == 0 or arr.shape[0] == 0:
        return out
    hit = apply_slice_crossfade(arr, fade_ms=SLICE_EDGE_FADE_MS, sr=int(sr))
    spacing = max(1, int(spacing_bars))
    start = (spacing - 1) * bar
    if start >= out.shape[0]:
        start = 0
    while start < out.shape[0]:
        end = min(out.shape[0], start + hit.shape[0])
        piece = hit[: end - start]
        if end - start < hit.shape[0]:
            piece = apply_slice_crossfade(piece, sr=int(sr), fade_in=False)
        out[start:end] += piece
        start += spacing * bar
    return out


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
        from engine.live_index import get_db_connection, is_source_index

        if is_source_index(path):
            return None
        conn = get_db_connection(path)
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
    except (sqlite3.Error, FileNotFoundError, OSError):
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


# Vocal and phrase-lead slices. Drums and bass may loop a section; these may not.
_PHRASE_DUTY_BUSES = frozenset({"vocal"})
_MAX_IDENTICAL_PHRASES = 2


def _phrase_duty_segments(
    bars: int,
    bar_samples: int,
    section_samples: int,
    variant_index: int,
    variant_count: int,
    phrase_bars: int | None = None,
    rest_bars: int | None = None,
    max_repeats: int = _MAX_IDENTICAL_PHRASES,
) -> list[tuple[int, int, int]]:
    """Phrase, then a rest, then the next variant.

    ``rest_bars`` of 0 keeps the line continuous (ambient / drone). Otherwise
    the bars with no segment stay silent so rhythm and bass carry the groove.
    The same variant may not repeat more than ``max_repeats`` times.
    """
    phrase = int(phrase_bars) if phrase_bars else (4 if int(bars) >= 8 else 2)
    rest = phrase if rest_bars is None else int(rest_bars)
    if rest <= 0:
        return [(0, int(section_samples), int(variant_index) % max(1, int(variant_count)))]
    count = max(1, int(variant_count))
    variant = int(variant_index) % count
    repeats = 0
    playing = True
    bar = 0
    cap = max(1, int(max_repeats))
    segments: list[tuple[int, int, int]] = []
    while bar < int(bars):
        if playing and repeats >= cap:
            if count > 1:
                variant = (variant + 1) % count
                repeats = 0
            else:
                playing = False
        span = min(phrase if playing else rest, int(bars) - bar)
        if span <= 0:
            break
        if playing:
            start = bar * int(bar_samples)
            end = min(int(section_samples), (bar + span) * int(bar_samples))
            if end > start:
                segments.append((start, end - start, variant))
            repeats += 1
            playing = False
        else:
            playing = True
            if count > 1:
                variant = (variant + 1) % count
                repeats = 0
        bar += span
    return segments


def _fill_window_bars(bars: int, phrase_bars: int, rest_bars: int) -> list[int]:
    """Last 1–2 bars of each 8-bar block, and only while the vocal is resting."""
    if rest_bars <= 0 or bars <= 0:
        return []
    resting: set[int] = set()
    bar = 0
    playing = True
    while bar < int(bars):
        span = min(phrase_bars if playing else rest_bars, int(bars) - bar)
        if not playing:
            resting.update(range(bar, bar + span))
        playing = not playing
        bar += span
    fills: list[int] = []
    for block in range(0, int(bars), 8):
        tail = range(max(block, block + 8 - 2), min(int(bars), block + 8))
        fills.extend(b for b in tail if b in resting)
    return fills


def _apply_step_gate(
    audio: np.ndarray,
    sr: int,
    bpm: float,
    open_steps: set[int] | None,
) -> np.ndarray:
    """Keep only the 16th-note steps a pocket is allowed to sound on.

    ``None`` leaves the bus sustaining. An empty set silences it.
    """
    if open_steps is None or audio.size == 0:
        return audio
    bar = max(1, samples_per_bar(sr, bpm))
    step = max(1, bar // 16)
    gain = np.zeros(bar, dtype=np.float64)
    fade = max(1, int(float(sr) * 0.003))
    for index in open_steps:
        start = int(index) * step
        end = min(bar, start + step)
        if end <= start:
            continue
        gain[start:end] = 1.0
        ramp = min(fade, max(1, (end - start) // 4))
        edge = np.linspace(0.0, 1.0, ramp, endpoint=False)
        gain[start : start + ramp] *= edge
        gain[end - ramp : end] *= edge[::-1]
    tiled = np.resize(gain, audio.shape[0])
    if audio.ndim == 1:
        return audio * tiled
    return audio * tiled[:, None]


def _carry_foundation_variant(plan: list[tuple[dict, int, int]]) -> None:
    """Keep the drum groove across a verse-to-chorus boundary."""
    previous: dict | None = None
    for section, _bars, _n in plan:
        role = _section_role(section)
        if (
            previous is not None
            and role in {"chorus", "drop"}
            and _section_role(previous) in {"verse", "pre_chorus", "build", "pre_drop"}
        ):
            source = previous.get("bus_variant") or {}
            if "rhythm" in source:
                section.setdefault("bus_variant", {})["rhythm"] = source["rhythm"]
        previous = section


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
    vocal_mode: str | None = None,
    chord_shifts: list[list[int] | None] | None = None,
    duty_cycle: tuple[int, int, int] | None = None,
) -> tuple[np.ndarray, dict[str, str]]:
    """Tile one loop per section (steady within the phrase), vary across sections.

    Loops repeat on a whole-bar period (``tile_loop_on_grid``) so the buses
    never drift off the grid. Each segment renders ``fade`` samples past its
    end; the next segment's head is equal-power blended against that overhang
    at the barline, so seams neither hard-cut nor replay the head.

    With a ``vocal_mode`` set, short ad-lib vocal phrases are placed as
    one-shots (never looped) and only in sections the mode allows.

    ``chord_shifts`` (one per-bar semitone list per plan section) makes the
    harmonic and bass buses follow the chord roadmap: the loop is pitch-shifted
    per chord span, loop phase stays continuous, and chord changes crossfade.
    """
    out = np.zeros((int(total_samples), int(channels)), dtype=np.float64)
    used: dict[str, str] = {}
    if not variant_paths:
        return out, used
    cache: dict[str, np.ndarray] = {}
    adlib: dict[str, bool] = {}
    bar_samples = samples_per_bar(sr, bpm)
    allow_fills = bus == "rhythm"
    mode = (vocal_mode or "").strip().lower() if bus == "vocal" else ""
    allowed_adlib = ADLIB_SECTIONS_LEAD if mode == "lead" else ADLIB_SECTIONS_OPEN
    fade_n = max(0, int(fade))
    pending: np.ndarray | None = None
    pending_at = -1
    cursor = 0
    follow_chords = bus in CHORD_FOLLOW_BUSES and bool(chord_shifts)
    shifted_cache: dict[tuple[str, int], np.ndarray] = {}
    for section_index, (section, bars, n) in enumerate(plan):
        bar_shifts = (
            chord_shifts[section_index]
            if follow_chords and chord_shifts is not None and section_index < len(chord_shifts)
            else None
        )
        variants = section.get("bus_variant") or {}
        index = int(variants.get(bus, 0)) % len(variant_paths)
        phrase_bed = bus in _PHRASE_DUTY_BUSES or (
            bus == "harmonic"
            and any("phrase" in os.path.basename(path).lower() for path in variant_paths)
        )
        if phrase_bed:
            phrase_bars, rest_bars, max_repeats = duty_cycle or (None, None, _MAX_IDENTICAL_PHRASES)
            segments = _phrase_duty_segments(
                int(bars), bar_samples, int(n), index, len(variant_paths),
                phrase_bars=phrase_bars,
                rest_bars=rest_bars,
                max_repeats=max_repeats if duty_cycle else _MAX_IDENTICAL_PHRASES,
            )
        else:
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
                if mode:
                    adlib[path] = is_adlib_vocal(path, int(loop.shape[0]), sr, bpm)
                    if adlib[path]:
                        print(
                            f"[VOCAL] ad-lib one-shot {os.path.basename(path)} "
                            f"({loop.shape[0] / float(sr):.2f}s) sections="
                            f"{'transitions/chorus' if mode == 'lead' else 'open'}"
                        )
            start = cursor + int(offset)
            if start >= out.shape[0]:
                continue
            if mode and adlib.get(path):
                pending = None
                if _section_role(section) not in allowed_adlib:
                    continue
                body = place_adlib_phrases(loop, int(length), sr, bpm)
                end = min(out.shape[0], start + body.shape[0])
                out[start:end] += body[: end - start]
                used[os.path.basename(path)] = path
                continue
            if bar_shifts and any(bar_shifts) and bar_samples > 0:
                tiled = _render_chord_spans(
                    loop, path, int(length), start - cursor, bar_shifts, bar_samples,
                    sr, bpm, fade_n, shifted_cache,
                )
            else:
                tiled = tile_loop_on_grid(loop, int(length) + fade_n, sr, bpm)
            body = tiled[: int(length)].copy()
            if pending is not None and pending_at == start and fade_n > 0:
                k = min(fade_n, body.shape[0], pending.shape[0])
                theta = np.linspace(0.0, 0.5 * np.pi, k, dtype=np.float64)[:, np.newaxis]
                body[:k] = pending[:k] * np.cos(theta) + body[:k] * np.sin(theta)
            end = min(out.shape[0], start + body.shape[0])
            out[start:end] = body[: end - start]
            pending = tiled[int(length) : int(length) + fade_n]
            pending_at = start + int(length)
            used[os.path.basename(path)] = path
        cursor += int(n)
    return out, used


def _render_chord_spans(
    loop: np.ndarray,
    path: str,
    length: int,
    section_offset: int,
    bar_shifts: list[int],
    bar_samples: int,
    sr: int,
    bpm: float,
    fade: int,
    shifted_cache: dict[tuple[str, int], np.ndarray],
) -> np.ndarray:
    """``length + fade`` samples: the loop pitch-shifted onto each chord span.

    Every shifted version is tiled on the same grid, so switching between them
    keeps loop phase; each chord change is a ``fade``-sample equal-power blend.
    """
    from dsp.pitch_key_aligner import pitch_shift_slice

    spans = _chord_spans(bar_shifts, int(section_offset) // int(bar_samples), int(length), int(bar_samples))
    total = int(length) + int(fade)
    full: dict[int, np.ndarray] = {}
    for _a, _e, semis in spans:
        if semis in full:
            continue
        key = (path, int(semis))
        shifted = shifted_cache.get(key)
        if shifted is None:
            shifted = loop if semis == 0 else pitch_shift_slice(loop, float(semis), sr=int(sr))
            shifted_cache[key] = shifted
        full[semis] = tile_loop_on_grid(shifted, total, sr, bpm)
    out = np.zeros_like(full[spans[0][2]])
    previous: int | None = None
    for a, e, semis in spans:
        out[a:e] = full[semis][a:e]
        if previous is not None and previous != semis and fade > 0:
            k = min(int(fade), e - a)
            theta = np.linspace(0.0, 0.5 * np.pi, k, dtype=np.float64)[:, np.newaxis]
            out[a : a + k] = full[previous][a : a + k] * np.cos(theta) + full[semis][a : a + k] * np.sin(theta)
        previous = semis
    out[int(length):] = full[spans[-1][2]][int(length):]
    return out


def _stage_bus_to_target(
    name: str,
    audio: np.ndarray,
    envelope: np.ndarray,
    target_dbfs: float,
    peak_cap: float = ARRANGED_BUS_PEAK_CAP,
    ignore_silence: bool = False,
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
    if ignore_silence:
        frames = arr if arr.ndim == 2 else arr[:, np.newaxis]
        active = active & (np.max(np.abs(frames), axis=1) > 1e-5)
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


BUS_STEMS_DIRNAME = "bus_stems"


def _write_bus_stems(
    bus_dir: str,
    bus_stems: dict[str, np.ndarray],
    gain: np.ndarray | float,
    headroom_gain: float,
    n_samples: int,
    sr: int,
    source_trace: dict | None,
) -> None:
    """Float WAVs that sum to the unmastered mix (no PCM clipping on buses).

    ``gain`` carries everything the mix bus applied after the sum, including
    the crest-control curve, so the stems ride with the mix instead of
    drifting out of sum with it. ``headroom_gain`` is the static part of it,
    which is what the trace records.
    """
    os.makedirs(bus_dir, exist_ok=True)
    written: dict[str, str] = {}
    scalar = np.ndim(gain) == 0
    for bus in ARRANGE_BUSES:
        audio = bus_stems.get(bus)
        if audio is None:
            continue
        arr = np.asarray(audio, dtype=np.float64)
        if arr.shape[0] < n_samples:
            pad = ((0, n_samples - arr.shape[0]),) + ((0, 0),) * (arr.ndim - 1)
            arr = np.pad(arr, pad)
        arr = arr[:n_samples]
        if scalar:
            arr = arr * float(gain)
        else:
            curve = np.asarray(gain).reshape(-1)[:n_samples]
            arr = arr * curve.reshape((n_samples,) + (1,) * (arr.ndim - 1))
        path = os.path.join(bus_dir, f"{bus}.wav")
        sf.write(path, arr, int(sr), subtype="FLOAT")
        written[bus] = path
    print(f"[SESSION] Wrote bus stems ({', '.join(written) or 'none'}): {bus_dir}")
    if source_trace is not None:
        source_trace["_bus_stems"] = {
            "dir": bus_dir,
            "files": written,
            "gain": float(headroom_gain),
        }


def _finalize_mix(
    full_mix: np.ndarray,
    sr: int,
    output_wav: str,
    session_id: str | None,
    scratch_root: str | None,
    normalize_lufs: float | None,
    ceiling_dbtp: float,
    source_trace: dict | None,
    bus_stems: dict[str, np.ndarray] | None = None,
) -> str:
    """Shared write tail: crest control, -3 dBFS headroom, session contract copy, opt-in R128.

    With a ``session_id``, ``bus_stems`` are written next to the session mix
    as ``bus_stems/{rhythm,bass,harmonic,vocal}.wav`` (32-bit float, same
    headroom gain as the mix) so Module 5 packages the real buses.
    """
    # Mono fold-down safety before anything downstream measures it. Section
    # widths of 1.3 accumulate across a long render and the delivery QC gate
    # rejects a master below 0.25 correlation.
    try:
        from engine.conductor_matrix import enforce_mono_compatibility

        full_mix, corr_before, corr_after = enforce_mono_compatibility(full_mix)
        if corr_after > corr_before:
            print(
                f"[MONO] stereo correlation {corr_before:.3f} -> {corr_after:.3f} "
                "(side pulled back for mono compatibility)"
            )
            if source_trace is not None:
                source_trace["_mono_guard"] = {
                    "before": round(corr_before, 4),
                    "after": round(corr_after, 4),
                }
        else:
            print(f"[MONO] stereo correlation {corr_before:.3f} (within limits)")
    except Exception as exc:
        print(f"[MONO] compatibility guard skipped ({exc})")

    # Crest control before the headroom trim. A couple of fill bars sitting 15
    # dB above the body of the song give the mix a ~25 dB PLR, and no
    # downstream limiter can recover that: its push is bounded by true-peak
    # headroom, so the delivery master lands 6+ dB under the -14 LUFS target.
    stem_gain: np.ndarray | float = 1.0
    try:
        from dsp.crest_control import control_crest

        full_mix, stem_gain, crest = control_crest(full_mix, sr)
        if crest.engaged:
            print(
                f"[CREST] PLR {crest.plr_before_db:.2f} -> {crest.plr_after_db:.2f} dB "
                f"(ride {crest.level_reduction_db:.2f} dB, clip {crest.clip_reduction_db:.2f} dB)"
            )
        else:
            print(f"[CREST] PLR {crest.plr_before_db:.2f} dB already deliverable; bypassed")
        if source_trace is not None:
            source_trace["_crest"] = asdict(crest)
    except Exception as exc:
        print(f"[CREST] crest control skipped ({exc})")

    peak = float(np.max(np.abs(full_mix))) if full_mix.size else 0.0
    headroom_gain = (HEADROOM_PEAK / peak) if peak > HEADROOM_PEAK else 1.0
    full_mix = full_mix * headroom_gain
    stem_gain = stem_gain * headroom_gain
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
        if bus_stems:
            _write_bus_stems(
                os.path.join(os.path.dirname(contract), BUS_STEMS_DIRNAME),
                bus_stems,
                stem_gain,
                headroom_gain,
                full_mix.shape[0],
                sr,
                source_trace,
            )
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
        # A short pool is silent degradation: the section map still references
        # variant indices that do not exist, so they wrap onto the loops that
        # do and the rotation the conductor planned quietly stops happening.
        # Say so in the transcript rather than leaving only an informational
        # "[ARRANGE] <bus> variants=1" to be read as normal.
        if len(picks) < needed[bus]:
            print(
                f"[ARRANGE][WARN] {bus} pool short: section map needs "
                f"{needed[bus]} variants, delivered {len(picks)} "
                f"(pool={len(source.slice_pool) if source else 0}) -- "
                "sections will reuse loops",
                flush=True,
            )
    return pools


# Drums carry no pitch, so harmony never reassigns the rhythm bus.
HARMONIC_VARIANT_BUSES = ("bass", "harmonic", "vocal")

# A variant qualifies when it retains at least this fraction of the best fit
# measured for the section: ``fit >= (1 - VARIANT_QUALIFY_FIT_SLACK) * best``.
#
# This replaced a fixed 0.04 margin, which was on the wrong scale. ``harmonic_fit``
# has no fixed unit -- it is chord-energy overlap normalised by the best tone
# weight -- and measured variant spreads on live renders run 0.038 to 0.177,
# sitting around 0.05. A fixed margin therefore meant two different things: at a
# 0.038 spread it admitted every candidate (no qualification at all) and at 0.177
# only near-ties (qualification degenerating into the argmax this is meant to
# replace). A fraction of the best fit is scale-free: multiply every fit by the
# same factor and the qualified set does not move.
#
# Chosen over a fraction of the *spread*, which looks equally scale-free but
# always discards the lower part of the field however small the spread is -- four
# loops at 0.72/0.71/0.70/0.69 differ by noise, and halving that range would drop
# two usable loops for no harmonic reason. Chosen over a rank-based top-K for the
# mirror of the same fault: top-K admits exactly K whether or not the Kth
# genuinely clashes. At a typical best fit near 0.7 this band is ~0.10 wide, so a
# 0.05 spread qualifies the whole pool and the conductor's rotation passes
# through untouched, while a clash an order of magnitude below the best fit is
# excluded at any spread.
VARIANT_QUALIFY_FIT_SLACK = 0.15


def _variant_chroma(paths: list[str]) -> list[np.ndarray]:
    """Measure chroma on the staged copies themselves.

    The staged file is already key- and tempo-aligned, so its chroma reflects
    what will actually play — more accurate than the catalogue row for the
    original slice, and only a handful of files per render.
    """
    from engine.musical_features import chroma_vector

    out: list[np.ndarray] = []
    for path in paths:
        try:
            data, sr = sf.read(path, always_2d=True, dtype="float64")
            out.append(chroma_vector(data, int(sr)))
        except Exception:
            out.append(np.zeros(12, dtype=np.float64))
    return out


def qualified_variants(fits: list[float]) -> list[int]:
    """The subset of variants harmonically compatible with one section.

    Qualification, not selection: this narrows the field and leaves the choice
    to the rotation. The band is relative to the best fit this section achieved
    (``VARIANT_QUALIFY_FIT_SLACK``), not an absolute margin, so it means the
    same thing whether the candidates are tightly clustered or far apart.

    Never empty -- the best fit always clears its own floor, and the explicit
    fallback keeps that true if the slack is ever retuned past 1.0.
    """
    if not fits:
        return []
    best = max(fits)
    floor = best - VARIANT_QUALIFY_FIT_SLACK * abs(best)
    qualified = [i for i, fit in enumerate(fits) if fit >= floor]
    return qualified or [max(range(len(fits)), key=lambda i: fits[i])]


def _sibling_keys(section: dict, chords: list[str]) -> tuple[tuple[str, str], ...]:
    """Groups within which two sections must not land on the same loop.

    Two kinds of sibling. Sections the conductor deliberately differentiated --
    ``verse`` and ``verse_2`` share a base name, and
    ``local_song_conductor.apply_song_shape`` sets verse 2 one variant past
    verse 1 precisely so it is not a copy. And sections on an identical
    progression, which score identical pitch weights and therefore identical
    fits: nothing in the measurement can tell them apart, so without this they
    would all follow the same loop by construction.
    """
    name = str(section.get("name") or "").lower().strip()
    base = re.sub(r"[_\s-]*\d+$", "", name.replace(" ", "_").replace("-", "_"))
    keys: list[tuple[str, str]] = [("role", base or name)]
    if chords:
        keys.append(("chords", "-".join(chords).lower()))
    return tuple(keys)


def _rotate_within_qualified(
    preferred: int, qualified: list[int], count: int, blocked: set[int]
) -> int:
    """The conductor's rotation choosing from inside the qualified subset.

    Its preference wins whenever it is both qualified and not already taken by
    a sibling section. Otherwise the walk steps upward modulo the pool, which
    is the conductor's own variety step (verse 2 is verse 1 plus one), so the
    replacement still reads as its rotation rather than an argmax.
    """
    free = [i for i in qualified if i not in blocked]
    if preferred in free:
        return preferred
    for step in range(1, count + 1):
        candidate = (preferred + step) % count
        if candidate in free:
            return candidate
    if preferred in qualified:
        return preferred  # nothing free left; its own pick still fits
    for step in range(1, count + 1):
        candidate = (preferred + step) % count
        if candidate in qualified:
            return candidate
    return preferred


def assign_harmonic_variants(
    plan: list[tuple[dict, int, int]],
    pools: dict[str, list[str]],
    song_plan_sections: list[dict] | None,
) -> dict[str, int]:
    """Qualify the staged loops per section, then let the rotation choose.

    Stems are staged once per track, but the section map already chooses a
    variant per section — that index came from the conductor's rotation, blind
    to harmony. Two steps make the per-section chord fit real without taking
    the arrangement decision away from the conductor:

    1. Score every staged variant against this section's own
       ``chord_progression`` and keep the harmonically compatible subset
       (``qualified_variants``).
    2. Let the conductor's ``bus_variant`` pick from inside that subset, with
       its anti-repetition intent intact (``_rotate_within_qualified``).

    Inverting it this way is what keeps the rotation alive. Picking the
    best-fitting variant outright collapses it: sections sharing a progression
    produce identical pitch weights and so identical fits, and no tolerance can
    separate them because the measurement genuinely cannot. Qualification
    sidesteps that — identical chords yield the same qualified *set*, and the
    rotation is free to take different members of it.

    Returns a per-bus count of sections whose variant changed, for logging.
    """
    if not song_plan_sections or len(song_plan_sections) != len(plan):
        return {}

    from engine.musical_features import harmonic_fit, plan_pitch_weights

    moved: dict[str, int] = {}
    for bus in HARMONIC_VARIANT_BUSES:
        paths = pools.get(bus) or []
        if len(paths) < 2:
            continue  # nothing to choose between
        chromas = _variant_chroma(paths)
        if not any(float(c.sum()) > 0.0 for c in chromas):
            continue  # unmeasurable (silent staging) — leave the rotation alone
        taken: dict[tuple[str, str], set[int]] = {}
        for sp_section, (section, _bars, _n) in zip(song_plan_sections, plan):
            chords = [str(c) for c in (sp_section.get("chord_progression") or []) if c]
            variants = section.setdefault("bus_variant", {})
            current = int(variants.get(bus, 0)) % len(paths)
            keys = _sibling_keys(sp_section, chords)
            weights = plan_pitch_weights(chords) if chords else None
            if weights is None or float(weights.sum()) <= 0.0:
                # No roadmap for this section: the rotation stands, but the
                # loop it holds still counts as spoken for by its siblings.
                for key in keys:
                    taken.setdefault(key, set()).add(current)
                continue
            fits = [harmonic_fit(chroma, weights) for chroma in chromas]
            chosen = _rotate_within_qualified(
                current,
                qualified_variants(fits),
                len(paths),
                {index for key in keys for index in taken.get(key, set())},
            )
            for key in keys:
                taken.setdefault(key, set()).add(chosen)
            if chosen != current:
                variants[bus] = chosen
                moved[bus] = moved.get(bus, 0) + 1
    return moved


def describe_section_variants(
    bus: str,
    plan: list[tuple[dict, int, int]],
    song_plan_sections: list[dict] | None,
) -> str:
    """One-line per-section variant dump, after qualification has run."""
    picks = [int((section.get("bus_variant") or {}).get(bus, 0)) for section, _b, _n in plan]
    names = [
        str((song_plan_sections[i] if song_plan_sections and i < len(song_plan_sections) else {}).get("name")
            or (section.get("name") or f"s{i}"))
        for i, (section, _b, _n) in enumerate(plan)
    ]
    body = " ".join(f"{name}={index}" for name, index in zip(names, picks))
    return f"[HARMONY] {bus} section variants: {body} ({len(set(picks))} distinct)"


def _delay_ms(audio: np.ndarray, sr: int, delay_ms: float) -> np.ndarray:
    """Slide a lane later than the kick so the pocket is not glued to the clock."""
    samples = int(round(abs(float(delay_ms)) * int(sr) / 1000.0))
    if samples <= 0 or audio.size == 0:
        return audio
    shifted = np.zeros_like(audio)
    if samples >= audio.shape[0]:
        return shifted
    shifted[samples:] = audio[:-samples]
    return shifted


def _section_sample_mask(
    plan: list[tuple[dict, int, int]],
    total_samples: int,
    sr: int,
    bpm: float,
    wanted,
) -> np.ndarray:
    """1.0 on the bars ``wanted(section, local_bar, song_bar)`` accepts."""
    mask = np.zeros(int(total_samples), dtype=np.float64)
    bar_n = max(1, samples_per_bar(sr, bpm))
    cursor = 0
    song_bar = 0
    for section, bars, n in plan:
        for local in range(int(bars)):
            song_bar += 1
            if wanted(section, local + 1, song_bar):
                start = cursor + local * bar_n
                end = min(int(total_samples), start + bar_n)
                if end > start:
                    mask[start:end] = 1.0
        cursor += int(n)
    return mask


def _apply_mask(audio: np.ndarray, mask: np.ndarray) -> np.ndarray:
    if audio.ndim == 1:
        return audio * mask[: audio.shape[0]]
    return audio * mask[: audio.shape[0], None]


def _bounce_console_lanes(
    pools: dict[str, list[str]],
    lead_paths: list[str],
    plan: list[tuple[dict, int, int]],
    total_samples: int,
    sr: int,
    bpm: float,
    channels: int,
    target_key: str | None,
    target_bpm: float | None,
    fade: int,
    chord_shifts: list[list[int] | None] | None,
    grammar,
    swing_offset_ms: float,
) -> dict[str, np.ndarray]:
    """One buffer per console lane, rendered from that lane's own files."""
    from engine.genre_arrangement_profiles import bass_open_steps, comping_open_steps
    from engine.stem_lanes import (
        COMP_DUCK_GAIN,
        LANE_IDS,
        LEAD_OVERLAP_GAIN,
        assign_lanes,
        boundary_bars,
        cadence_bars,
        duty_mask,
        fill_window,
    )

    paths: list[str] = []
    for pool in pools.values():
        paths.extend(pool or [])
    paths.extend(lead_paths or [])
    assigned = assign_lanes(paths)
    bus_for = {
        "01_kick": "rhythm",
        "02_snare": "rhythm",
        "03_tops": "rhythm",
        "04_aux_perc": "rhythm",
        "05_sub_bass": "bass",
        "06_mid_bass": "bass",
        "07_primary_comp": "harmonic",
        "08_harmonic_bed": "harmonic",
        "09_secondary_comp": "harmonic",
        "10_lead_inst": "harmonic",
        "11_lead_vocal": "vocal",
        "12_vocal_backing": "vocal",
        "13_transitions_fx": "rhythm",
    }
    phrase = None
    if grammar is not None:
        phrase = (
            int(grammar.vocal_phrase_bars),
            int(grammar.vocal_rest_bars),
            int(grammar.max_consecutive_repeats),
        )
    rendered: dict[str, np.ndarray] = {}
    for lane in LANE_IDS:
        audio, _used = _render_arranged_bus(
            bus_for[lane],
            list(assigned.get(lane) or []),
            plan,
            total_samples,
            sr,
            bpm,
            channels,
            target_key,
            target_bpm,
            fade,
            chord_shifts=chord_shifts if bus_for[lane] in CHORD_FOLLOW_BUSES else None,
            duty_cycle=phrase if lane == "11_lead_vocal" else None,
        )
        rendered[lane] = audio
    if grammar is not None:
        comp_steps = comping_open_steps(grammar.comping_style)
        bass_steps = bass_open_steps(grammar.bass_behavior)
        rendered["07_primary_comp"] = _apply_step_gate(rendered["07_primary_comp"], sr, bpm, comp_steps)
        if comp_steps:
            complement = {step for step in range(16) if step not in comp_steps}
            rendered["09_secondary_comp"] = _apply_step_gate(
                rendered["09_secondary_comp"], sr, bpm, complement or {3, 6, 10, 13, 15}
            )
        rendered["05_sub_bass"] = _apply_step_gate(rendered["05_sub_bass"], sr, bpm, bass_steps)
        rendered["06_mid_bass"] = _apply_step_gate(rendered["06_mid_bass"], sr, bpm, bass_steps)
        phrase_bars = int(grammar.vocal_phrase_bars)
        rest_bars = int(grammar.vocal_rest_bars)

        def _lead_bar(section, local, _song):
            window = section.get("fill_bars")
            if not window:
                window = fill_window(int(section.get("bars") or 0) or local, phrase_bars, rest_bars)
            return local in set(window)

        def _backing_bar(section, local, _song):
            bars = int(section.get("bars") or 0)
            return local in set(cadence_bars(duty_mask(bars, phrase_bars, rest_bars)))

        def _fx_bar(section, local, song):
            start = int(song) - local
            return local in set(boundary_bars(start, int(section.get("bars") or 1)))

        def _aux_bar(section, _local, _song):
            name = str(section.get("name") or section.get("role") or "").lower()
            return not any(token in name for token in ("intro", "breakdown", "outro", "ambient"))

        rendered["10_lead_inst"] = _apply_mask(
            rendered["10_lead_inst"], _section_sample_mask(plan, total_samples, sr, bpm, _lead_bar)
        )
        rendered["12_vocal_backing"] = _apply_mask(
            rendered["12_vocal_backing"], _section_sample_mask(plan, total_samples, sr, bpm, _backing_bar)
        )
        rendered["13_transitions_fx"] = _apply_mask(
            rendered["13_transitions_fx"], _section_sample_mask(plan, total_samples, sr, bpm, _fx_bar)
        )
        rendered["04_aux_perc"] = _apply_mask(
            rendered["04_aux_perc"], _section_sample_mask(plan, total_samples, sr, bpm, _aux_bar)
        )
    if swing_offset_ms:
        for lane in ("06_mid_bass", "07_primary_comp", "09_secondary_comp"):
            rendered[lane] = _delay_ms(rendered[lane], sr, swing_offset_ms)
    vocal = rendered["11_lead_vocal"]
    hot = np.max(np.abs(vocal), axis=1 if vocal.ndim > 1 else 0) > 1e-3
    rendered["07_primary_comp"][hot] *= COMP_DUCK_GAIN
    rendered["10_lead_inst"][hot] *= LEAD_OVERLAP_GAIN
    kick = rendered["01_kick"]
    kick_hot = np.max(np.abs(kick), axis=1 if kick.ndim > 1 else 0) > 1e-3
    rendered["05_sub_bass"][kick_hot] *= COMP_DUCK_GAIN
    print("[LANES] bounced 13 isolated stems", flush=True)
    return rendered


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
    mix_intents: dict | None = None,
    section_plan: dict | None = None,
    song_plan_sections: list[dict] | None = None,
    vocal_mode: str | None = None,
    chord_key: str | None = None,
    chord_scale: str | None = None,
    genre: str | None = None,
    bounce_lanes: bool = False,
    swing_offset_ms: float = 0.0,
) -> dict[str, np.ndarray]:
    """Render the four buses from a per-section activation map.

    ``vocal_mode``: ``none`` mutes the vocal bus; ``lead`` / ``adlib`` place
    short ad-lib chops as one-shots (``lead`` limits them to transitions and
    chorus drops) instead of looping them like a synth.

    Loops stay steady inside a section (one loop per bus per phrase — the
    8-bar lock), vary across sections via ``bus_variant``, and are gated by a
    ramped activation envelope so a bus can drop right out for a section.
    The map is produced by ``engine.local_song_conductor``. Gain staging
    targets a per-bus RMS from the genre profile instead of a fixed multiplier.

    After staging, ``RelationalMixer`` applies kick->bass ducking, vocal
    pocketing, and a shared coherence reverb bus (Module 2).
    """
    targets = dict(DEFAULT_BUS_TARGET_RMS)
    targets.update({k: float(v) for k, v in (bus_targets or {}).items() if k in targets})

    mode = (vocal_mode or "").strip().lower() or None
    if mode is not None and mode not in VOCAL_MODES:
        mode = None
    pools = _arranged_bus_pools(rotators, plan)
    from engine.stem_lanes import BUS_TO_LANE, filter_lane

    for bus, paths in list(pools.items()):
        lane = BUS_TO_LANE.get(bus, bus)
        kept = filter_lane(lane, paths)
        if len(kept) != len(paths):
            print(
                f"[LANE] {lane} rejected {len(paths) - len(kept)} "
                "stem(s) locked to another lane",
                flush=True,
            )
        pools[bus] = kept
    if mode == "none":
        pools["vocal"] = []
        print("[VOCAL] instrumental: vocal bus muted")
    grammar = None
    duty_cycle: tuple[int, int, int] | None = None
    comping_steps: set[int] | None = None
    bass_steps: set[int] | None = None
    if genre:
        from engine.genre_arrangement_profiles import (
            bass_open_steps,
            comping_open_steps,
            resolve_genre_grammar,
        )

        grammar = resolve_genre_grammar(genre)
        duty_cycle = (
            int(grammar.vocal_phrase_bars),
            int(grammar.vocal_rest_bars),
            int(grammar.max_consecutive_repeats),
        )
        comping_steps = comping_open_steps(grammar.comping_style)
        bass_steps = bass_open_steps(grammar.bass_behavior)
        print(
            f"[GRAMMAR] {genre} archetype={grammar.archetype} "
            f"pocket={grammar.comping_style} bass={grammar.bass_behavior} "
            f"vocal={grammar.vocal_phrase_bars}/{grammar.vocal_rest_bars}",
            flush=True,
        )
        # Anchor: harmony, leads, and vocals wait until rhythm and bass exist.
        if not pools.get("rhythm") or not pools.get("bass"):
            print(
                "[ANCHOR] rhythm/bass missing after the widened search; "
                "harmonic, vocal, and lead stay silent",
                flush=True,
            )
            pools["harmonic"] = []
            pools["vocal"] = []
        elif grammar.lead_monophony_strict:
            for section, bars, _n in plan:
                if not section.get("fill_bars"):
                    section["fill_bars"] = _fill_window_bars(
                        int(bars),
                        int(grammar.vocal_phrase_bars),
                        int(grammar.vocal_rest_bars),
                    )
    chord_shifts: list[list[int] | None] | None = None
    if chord_key and song_plan_sections and len(song_plan_sections) == len(plan):
        chord_shifts = [
            section_chord_offsets(
                list(sp.get("chord_progression") or []),
                int(bars),
                int(sp.get("bars_per_chord") or 1),
                chord_key,
                chord_scale,
            )
            for sp, (_section, bars, _n) in zip(song_plan_sections, plan)
        ]
        if any(chord_shifts):
            print(
                "[HARMONY] "
                + " | ".join(
                    f"{sp.get('name', '?')}: {'-'.join(sp.get('chord_progression') or [])}"
                    f" x{int(sp.get('bars_per_chord') or 1)}bar"
                    for sp in song_plan_sections
                )
            )
        else:
            chord_shifts = None
    # Each section now plays a staged loop that qualifies against its own chords.
    try:
        moved = assign_harmonic_variants(plan, pools, song_plan_sections)
        if moved:
            print(
                "[HARMONY] section variants re-pointed by chord fit: "
                + " ".join(f"{bus}={count}" for bus, count in sorted(moved.items())),
                flush=True,
            )
        for bus in HARMONIC_VARIANT_BUSES:
            if len(pools.get(bus) or []) > 1:
                print(describe_section_variants(bus, plan, song_plan_sections), flush=True)
    except Exception as exc:
        print(f"[HARMONY] per-section variant fit skipped ({exc})", flush=True)
    _carry_foundation_variant(plan)

    envelopes: dict[str, np.ndarray] = {}
    raw: dict[str, np.ndarray] = {}
    sources: dict[str, dict[str, str]] = {}
    for bus in ARRANGE_BUSES:
        audio, used = _render_arranged_bus(
            bus, pools[bus], plan, total_samples, sr, bpm, channels,
            target_key, target_bpm, fade,
            vocal_mode=mode if bus == "vocal" else None,
            chord_shifts=chord_shifts if bus in CHORD_FOLLOW_BUSES else None,
            duty_cycle=duty_cycle if bus == "vocal" else None,
        )
        if bus == "harmonic" and comping_steps is not None:
            audio = _apply_step_gate(audio, sr, bpm, comping_steps)
        if bus == "bass" and bass_steps is not None:
            audio = _apply_step_gate(audio, sr, bpm, bass_steps)
        env = _activation_envelope(plan, bus, total_samples, sr)
        envelopes[bus] = env
        raw[bus] = audio * env
        sources[bus] = used
        print(
            f"[ARRANGE] {bus} variants={len(pools[bus])} "
            f"({', '.join(os.path.basename(p) for p in pools[bus]) or '-'})"
        )

    # Lead plays in the fill window only. While the vocal owns the midrange
    # the lead drops 12 dB, so the two never share that pocket.
    bounced_leads: list[str] = []
    if (
        grammar is not None
        and grammar.lead_monophony_strict
        and pools.get("rhythm")
        and pools.get("bass")
        and raw.get("harmonic") is not None
    ):
        lead_rotator = rotators.get("lead")
        lead_paths = _pick_variant_paths(lead_rotator, 1) if lead_rotator else []
        lead_paths = filter_lane("lead", lead_paths)
        bounced_leads = list(lead_paths)
        if source_trace is not None and lead_paths:
            source_trace.setdefault("_buses", {})["lead"] = {
                "variants": list(lead_paths),
                "reason": None,
            }
        if lead_paths:
            lead_audio, _lead_used = _render_arranged_bus(
                "harmonic", lead_paths, plan, total_samples, sr, bpm, channels,
                target_key, target_bpm, fade,
                chord_shifts=chord_shifts,
            )
            mask = np.zeros(int(total_samples), dtype=np.float64)
            cursor = 0
            bar_n = samples_per_bar(sr, bpm)
            for section, _bars, n in plan:
                for fill_bar in section.get("fill_bars") or []:
                    start = cursor + int(fill_bar) * bar_n
                    end = min(int(total_samples), start + bar_n)
                    if end > start:
                        mask[start:end] = 1.0
                cursor += int(n)
            if lead_audio.ndim == 1:
                lead_audio = lead_audio * mask
            else:
                lead_audio = lead_audio * mask[:, None]
            vocal_audio = raw.get("vocal")
            if vocal_audio is not None and vocal_audio.size:
                hot = np.max(np.abs(vocal_audio), axis=1 if vocal_audio.ndim > 1 else 0) > 1e-3
                from engine.stem_lanes import LEAD_OVERLAP_GAIN

                lead_audio[hot] *= LEAD_OVERLAP_GAIN
            harm_env = envelopes.get("harmonic")
            if harm_env is not None:
                lead_audio = lead_audio * (harm_env[:, None] if lead_audio.ndim > 1 else harm_env)
            raw["harmonic"] = raw["harmonic"] + lead_audio

    staged: dict[str, np.ndarray] = {}
    for bus in ARRANGE_BUSES:
        staged[bus], measured, gain_db = _stage_bus_to_target(
            bus, raw[bus], envelopes[bus], targets[bus],
            ignore_silence=bus == "vocal" and mode is not None,
        )
        if source_trace is not None:
            source_trace.setdefault("_buses", {})[bus] = {
                "target_rms_dbfs": targets[bus],
                "source_rms_dbfs": round(measured, 2),
                "gain_db": round(gain_db, 2),
                "variants": list(sources[bus].values()),
            }

    # Module 2: relational DSP before the final sum.
    try:
        from engine.relational_mixer import (
            apply_relational_mix,
            apply_sectioned_relational_mix,
        )

        bus_inputs = {bus: staged[bus] for bus in ARRANGE_BUSES}
        plan_genre = str(genre or "").strip()
        if song_plan_sections and len(song_plan_sections) == len(plan):
            # Per-section rules on this map's own sample grid.
            windows = []
            cursor = 0
            for sp_section, (_section, _bars, n) in zip(song_plan_sections, plan):
                payload = dict(sp_section) if isinstance(sp_section, dict) else {"name": str(sp_section)}
                if plan_genre and not payload.get("genre"):
                    payload["genre"] = plan_genre
                if bpm and not payload.get("bpm"):
                    payload["bpm"] = bpm
                windows.append((payload, cursor, cursor + int(n)))
                cursor += int(n)
            mixed = apply_sectioned_relational_mix(
                bus_inputs, int(sr), windows, mix_intents=mix_intents, genre=plan_genre or None
            )
        else:
            active_section = section_plan
            if active_section is None and plan:
                # Use the loudest arranged section as the pocketing/sidechain hint.
                sections = [item[0] for item in plan]

                def _hint_rank(section: dict) -> tuple[float, float]:
                    energy = float(section.get("energy") or section.get("energy_level") or 0.0)
                    activation = section.get("bus_activation") or {}
                    live = sum(float(value) for value in activation.values())
                    return (energy, live)

                active_section = max(sections, key=_hint_rank)
            if isinstance(active_section, dict) and plan_genre and not active_section.get("genre"):
                active_section = {**active_section, "genre": plan_genre, "bpm": bpm}
            mixed = apply_relational_mix(
                bus_inputs,
                int(sr),
                mix_intents=mix_intents,
                section=active_section,
                genre=plan_genre or None,
            )
        for bus in ARRANGE_BUSES:
            if bus in mixed.stems:
                staged[bus] = mixed.stems[bus]
        meters = mixed.meters
        print(
            "[RELATIONAL] "
            f"sections={len(meters.get('sections') or []) or 'single'} "
            f"sidechain={'yes' if meters.get('sidechain_applied') else 'no'} "
            f"kick_bass_aligned={bool(meters.get('kick_bass_aligned'))} "
            f"snaps={int(meters.get('snaps') or 0)} "
            f"median_shift_ms={float(meters.get('median_shift_ms') or 0):.3f} "
            f"pocket={'yes' if meters.get('vocal_pocket_applied') else 'no'} "
            f"reverb_send={float(meters.get('reverb_send') or 0):.2f} "
            f"mix_peak={float(meters.get('mix_peak_dbfs') or -120):.1f} dBFS"
        )
        if source_trace is not None:
            source_trace["_relational"] = dict(meters)
        staged["_relational_mix"] = mixed.mix  # type: ignore[assignment]
    except Exception as exc:
        print(f"[RELATIONAL] skipped ({exc})")

    staged["_envelopes"] = envelopes  # type: ignore[assignment]
    if bounce_lanes:
        try:
            staged["_console_lanes"] = _bounce_console_lanes(  # type: ignore[assignment]
                pools,
                bounced_leads,
                plan,
                total_samples,
                sr,
                bpm,
                channels,
                target_key,
                target_bpm,
                fade,
                chord_shifts,
                grammar,
                float(swing_offset_ms),
            )
        except Exception as exc:
            print(f"[LANES] bounce skipped ({exc})", flush=True)
    return staged


def _write_console_lanes(
    lane_dir: str,
    lanes: dict[str, np.ndarray],
    sr: int,
    source_trace: dict | None,
) -> None:
    """Float copies of the 13 lanes. The package exporter turns them into PCM24."""
    os.makedirs(lane_dir, exist_ok=True)
    written: dict[str, str] = {}
    for lane, audio in lanes.items():
        path = os.path.join(lane_dir, f"{lane}.wav")
        sf.write(path, np.asarray(audio, dtype=np.float64), int(sr), subtype="FLOAT")
        written[lane] = path
    print(f"[LANES] wrote {len(written)} lane files: {lane_dir}", flush=True)
    if source_trace is not None:
        source_trace["_console_lanes"] = {"dir": lane_dir, "files": written, "sr": int(sr)}


def _write_lane_manifest(
    output_wav: str,
    song_id: str,
    song_plan: dict | None,
    plan_sections: list[tuple[dict, int, int]],
    genre: str | None,
    bpm: float,
    source_trace: dict | None,
) -> None:
    """Write render_manifest.json beside the mix so every lane decision is readable."""
    from engine.genre_arrangement_profiles import resolve_genre_grammar
    from engine.stem_lanes import BUS_TO_LANE, build_render_manifest, write_render_manifest

    grammar = resolve_genre_grammar(genre or "")
    planned = list((song_plan or {}).get("sections") or [])
    if len(planned) != len(plan_sections):
        cursor = 0
        planned = []
        for section, bars, _n in plan_sections:
            planned.append({
                "name": section.get("name") or "section",
                "bars": bars,
                "start_bar": section.get("start_bar", cursor),
                "chord_progression": section.get("chord_progression") or [],
            })
            cursor += int(bars)
    buses = (source_trace or {}).get("_buses") or {}
    lane_files: dict[str, list[str]] = {}
    gains: dict[str, float] = {}
    for bus, payload in buses.items():
        lane = BUS_TO_LANE.get(str(bus))
        if not lane or not isinstance(payload, dict):
            continue
        bucket = lane_files.setdefault(lane, [])
        for path in payload.get("variants") or []:
            if path and path not in bucket:
                bucket.append(str(path))
        if payload.get("gain_db") is not None:
            gains[lane] = float(payload["gain_db"])
    key = str((song_plan or {}).get("key") or "C")
    scale = str((song_plan or {}).get("scale") or "minor")
    manifest = build_render_manifest(
        song_id,
        key=key,
        scale=scale,
        bpm=bpm,
        sections=planned,
        lane_files=lane_files,
        phrase_bars=int(grammar.vocal_phrase_bars),
        rest_bars=int(grammar.vocal_rest_bars),
        comping_style=grammar.comping_style,
        allow_clash=grammar.archetype in {"driving_rock_metal", "roots_americana"},
        gains_db=gains,
    )
    dest = os.path.join(os.path.dirname(os.path.abspath(output_wav)) or ".", "render_manifest.json")
    write_render_manifest(dest, manifest)
    print(f"[MANIFEST] {dest}", flush=True)
    if source_trace is not None:
        source_trace["_manifest"] = dest


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
    bounce_lanes: bool = False,
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
    # MUSDB-style packs: never layer the unseparated full mix (see
    # ``_is_full_mixture``); prefer drums / other / bass names without dropping
    # the rest of the scored pool.
    rhythm_pool = _order_preferring_name(
        _exclude_full_mixtures(_exclude_names(rhythm_pool, "bass")), "drum"
    )
    harmonic_pool = _order_preferring_name(
        _exclude_full_mixtures(_exclude_names(harmonic_pool, "bass")), "other"
    )
    bass_pool = _order_preferring_name(_exclude_full_mixtures(bass_pool), "bass")

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
        song_plan = arrange_meta.get("song_plan") if isinstance(arrange_meta, dict) else None
        mix_intents = None
        peak_section = None
        plan_genre = str(arrange_meta.get("genre") or "")
        if isinstance(song_plan, dict):
            from engine.genre_planner import genre_from_plan

            mix_intents = song_plan.get("mix_intents")
            plan_genre = genre_from_plan(song_plan) or plan_genre
            sections = song_plan.get("sections") or []
            if sections:
                peak_section = max(
                    sections,
                    key=lambda s: float(s.get("energy_level") or 0.0),
                )
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
                mix_intents=mix_intents,
                section_plan=peak_section,
                song_plan_sections=(
                    list(song_plan.get("sections") or []) if isinstance(song_plan, dict) else None
                ),
                vocal_mode=meta.get("vocal_mode"),
                chord_key=(
                    (song_plan.get("key") if isinstance(song_plan, dict) else None)
                    or meta.get("root_key")
                ),
                chord_scale=(
                    (song_plan.get("scale") if isinstance(song_plan, dict) else None)
                    or meta.get("scale")
                ),
                genre=plan_genre or None,
                bounce_lanes=bounce_lanes,
                swing_offset_ms=float(
                    (song_plan.get("swing_offset_ms") or 0.0) if isinstance(song_plan, dict) else 0.0
                ),
            )
        finally:
            if index_conn is not None:
                index_conn.close()

        envelopes = staged.pop("_envelopes")
        relational_mix = staged.pop("_relational_mix", None)
        console_lanes = staged.pop("_console_lanes", None)
        if console_lanes:
            _write_console_lanes(
                os.path.join(os.path.dirname(os.path.abspath(output_wav)) or ".", "console_lanes"),
                console_lanes,
                sr,
                source_trace,
            )
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

        if relational_mix is not None and np.asarray(relational_mix).size:
            full_mix = np.asarray(relational_mix, dtype=np.float64)
        else:
            full_mix = sum(staged[bus] for bus in ARRANGE_BUSES)

        # Module 3: quality gate after RelationalMixer, before export.
        try:
            from engine.local_song_conductor import gate_conducted_mix

            report_dir = os.path.dirname(os.path.abspath(output_wav)) or "."
            gated = gate_conducted_mix(
                {bus: staged[bus] for bus in ARRANGE_BUSES if bus in staged},
                full_mix,
                {"song_plan": song_plan} if isinstance(song_plan, dict) else {},
                sr=int(sr),
                report_dir=report_dir,
                regenerate_fn=None,
            )
            full_mix = np.asarray(gated.mix, dtype=np.float64)
            for bus in ARRANGE_BUSES:
                if bus in gated.stems:
                    staged[bus] = gated.stems[bus]
            if source_trace is not None:
                source_trace["_quality"] = gated.to_report()
        except Exception as exc:
            print(f"[QUALITY] skipped ({exc})")

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
        _write_lane_manifest(
            output_wav,
            session_id or os.path.splitext(os.path.basename(output_wav))[0],
            song_plan if isinstance(song_plan, dict) else None,
            plan_sections,
            plan_genre,
            float(bpm),
            source_trace,
        )
        return _finalize_mix(
            full_mix, sr, output_wav, session_id, scratch_root,
            normalize_lufs, ceiling_dbtp, source_trace,
            bus_stems={bus: staged[bus] for bus in ARRANGE_BUSES if bus in staged},
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
        bus_stems={"rhythm": r_bus, "bass": b_bus, "harmonic": h_bus, "vocal": v_bus},
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
