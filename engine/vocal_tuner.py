"""Local vocal pitch engine — pyworld WORLD vocoder, no cloud calls.

Extracts f0 with Harvest, snaps voiced frames to the song key, and
resynthesizes with CheapTrick / D4C so formants stay put (no chipmunk).
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

# Scale intervals relative to C (0 = C, 1 = C#, 2 = D, …).
MAJOR_SCALE_INTERVALS = [0, 2, 4, 5, 7, 9, 11]
MINOR_SCALE_INTERVALS = [0, 2, 3, 5, 7, 8, 10]
KEY_OFFSETS = {
    "C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
    "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11,
}
_FLATS = {"DB": "C#", "EB": "D#", "GB": "F#", "AB": "G#", "BB": "A#"}

# Blend: 80 % snapped scale, 20 % smoothed original micro-vibrato.
SCALE_LOCK = 0.8
VIBRATO_KEEP = 0.2
MEDFILT_KERNEL = 11
F0_FLOOR = 70.0
F0_CEIL = 500.0


def parse_root_key(raw: str | None, default: str = "G") -> tuple[str, str]:
    """``G``, ``G major``, ``G_minor``, ``Em`` → ``(root, scale)``."""
    token = str(raw or "").strip()
    if not token:
        return default, "major"
    compact = token.replace("-", "_").replace(" ", "_")
    parts = [p for p in compact.split("_") if p]
    head = parts[0]
    letter = head[:2].upper() if len(head) > 1 and head[1] in "#bB" else head[:1].upper()
    if len(head) > 1 and head[1] in "bB":
        letter = _FLATS.get(letter + "B", letter)
    letter = _FLATS.get(letter, letter)
    if letter not in KEY_OFFSETS:
        letter = default
    rest = " ".join(parts[1:]).lower() if len(parts) > 1 else ""
    suffix = head[len(letter) :].lower() if len(head) > len(letter) else ""
    if "min" in rest or suffix in {"m", "min"}:
        return letter, "minor"
    if "maj" in rest or suffix == "maj":
        return letter, "major"
    return letter, "major"


def hz_to_midi(f0: np.ndarray) -> np.ndarray:
    """Convert Hz array to fractional MIDI notes. Unvoiced (f0<=0) stays 0."""
    midi = np.zeros_like(f0, dtype=np.float64)
    voiced = np.asarray(f0) > 0
    midi[voiced] = 69.0 + 12.0 * np.log2(np.asarray(f0, dtype=np.float64)[voiced] / 440.0)
    return midi


def midi_to_hz(midi: np.ndarray, voiced_mask: np.ndarray) -> np.ndarray:
    """Convert MIDI notes back to Hz on voiced frames only."""
    f0 = np.zeros_like(midi, dtype=np.float64)
    mask = np.asarray(voiced_mask, dtype=bool)
    f0[mask] = 440.0 * (2.0 ** ((np.asarray(midi, dtype=np.float64)[mask] - 69.0) / 12.0))
    return f0


def normalize_mode(mode: str | None, fallback: str = "major") -> str:
    """``major`` | ``minor`` (aliases: maj, min, m, aeolian, ionian)."""
    token = str(mode or fallback or "major").strip().lower()
    if token in {"minor", "min", "m", "aeolian"} or token.startswith("min"):
        return "minor"
    return "major"


def _intervals_for(scale: str) -> np.ndarray:
    table = MINOR_SCALE_INTERVALS if normalize_mode(scale) == "minor" else MAJOR_SCALE_INTERVALS
    return np.asarray(table, dtype=np.float64)


def snap_midi_to_scale(
    midi_val: float | np.ndarray,
    root_key: str = "G",
    scale: str = "major",
    mode: str | None = None,
) -> float | np.ndarray:
    """Nearest degree of ``root_key`` in ``mode`` (``major`` | ``minor``).

    ``mode`` wins over ``scale`` so the conductor can pass G + minor without
    the tuner defaulting a bare ``G`` to major thirds.
    """
    offset = float(KEY_OFFSETS.get(str(root_key), 0))
    intervals = _intervals_for(mode or scale)
    scalar = np.isscalar(midi_val) or (isinstance(midi_val, np.ndarray) and midi_val.shape == ())
    rounded = np.round(np.asarray(midi_val, dtype=np.float64))
    pitch_class = np.mod(rounded - offset, 12.0)
    diffs = np.abs(intervals.reshape(-1, 1) - np.atleast_1d(pitch_class))
    closest = intervals[np.argmin(diffs, axis=0)]
    octave = np.floor((rounded - offset) / 12.0)
    snapped = (np.atleast_1d(octave) * 12.0) + closest + offset
    if scalar:
        return float(snapped.reshape(-1)[0])
    return snapped.reshape(rounded.shape)


def _median_filter(contour: np.ndarray, kernel_size: int = MEDFILT_KERNEL) -> np.ndarray:
    size = int(kernel_size)
    if size < 3:
        return np.asarray(contour, dtype=np.float64)
    if size % 2 == 0:
        size += 1
    try:
        from scipy.signal import medfilt

        return np.asarray(medfilt(np.asarray(contour, dtype=np.float64), kernel_size=size), dtype=np.float64)
    except Exception:
        pad = size // 2
        x = np.pad(np.asarray(contour, dtype=np.float64), (pad, pad), mode="edge")
        windows = np.lib.stride_tricks.sliding_window_view(x, size)
        return np.median(windows, axis=1)


def _synthesize_world(x: np.ndarray, fs: int, new_f0: np.ndarray) -> np.ndarray:
    import pyworld as pw

    f0, time_axis = pw.harvest(x, fs, f0_floor=F0_FLOOR, f0_ceil=F0_CEIL)
    sp = pw.cheaptrick(x, f0, time_axis, fs)
    ap = pw.d4c(x, f0, time_axis, fs)
    n = min(len(new_f0), len(f0), len(sp), len(ap))
    return np.asarray(pw.synthesize(new_f0[:n], sp[:n], ap[:n], fs), dtype=np.float64)


def tune_vocal_to_song(
    input_wav_path: str,
    output_wav_path: str,
    root_key: str = "G",
    mode: str | None = None,
) -> str:
    """Pitch-quantize a WAV take to the conductor's root + mode."""
    key, parsed_scale = parse_root_key(root_key)
    scale = normalize_mode(mode, parsed_scale)
    x, fs = sf.read(str(input_wav_path))
    if getattr(x, "ndim", 1) > 1:
        x = np.mean(x, axis=1)
    x = np.asarray(x, dtype=np.float64)
    dest = Path(output_wav_path)
    dest.parent.mkdir(parents=True, exist_ok=True)

    try:
        import pyworld as pw
    except ImportError:
        print("[VOICE TUNE] pyworld not installed — passing take through untuned", flush=True)
        sf.write(str(dest), x.astype(np.float32), int(fs))
        return str(dest)

    f0, _time_axis = pw.harvest(x, int(fs), f0_floor=F0_FLOOR, f0_ceil=F0_CEIL)
    voiced = f0 > 0
    if not np.any(voiced):
        print("[VOICE TUNE] no voiced frames — writing dry take", flush=True)
        sf.write(str(dest), x.astype(np.float32), int(fs))
        return str(dest)

    midi_contour = hz_to_midi(f0)
    smoothed_midi = _median_filter(midi_contour, MEDFILT_KERNEL)
    target_f0_midi = np.zeros_like(smoothed_midi)
    target_f0_midi[voiced] = snap_midi_to_scale(smoothed_midi[voiced], key, scale)
    tuned_midi = (SCALE_LOCK * target_f0_midi) + (VIBRATO_KEEP * smoothed_midi)
    new_f0 = midi_to_hz(tuned_midi, voiced)
    synthesized = _synthesize_world(x, int(fs), new_f0)
    peak = float(np.max(np.abs(synthesized))) + 1e-6
    synthesized = synthesized / peak * 0.85
    sf.write(str(dest), synthesized.astype(np.float32), int(fs))
    print(
        f"[VOICE TUNE] key={key}_{scale} voiced={int(np.sum(voiced))}/{len(f0)} "
        f"out={dest.name}",
        flush=True,
    )
    return str(dest)


def tune_if_possible(
    input_wav_path: str,
    root_key: str = "G",
    mode: str | None = None,
) -> str:
    """Tune in place next to the source; return the tuned path (or source on skip)."""
    src = Path(input_wav_path)
    dest = src.with_name(f"tuned_{src.name}")
    try:
        return tune_vocal_to_song(str(src), str(dest), root_key=root_key, mode=mode)
    except Exception as exc:
        print(f"[VOICE TUNE] failed ({type(exc).__name__}: {exc}) — using dry take", flush=True)
        return str(src)
