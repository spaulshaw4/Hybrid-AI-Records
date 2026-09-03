"""Scale-quantize vocal chops to a root + mode without librosa.pyin.

Median f0 is estimated with framed autocorrelation, then an FFT peak in
C2–C6 if the ACF vote is unvoiced. Pitch-shift reuses scipy STFT from
``pitch_key_aligner`` (librosa only when HYBRID_USE_LIBROSA=1).
"""
from __future__ import annotations

import argparse
import math
import sys

import numpy as np

from dsp.pitch_key_aligner import (  # NOTE_MAP is applied inside normalise_root_note
    NOTE_NAMES,
    _NOOP_SEMITONES,
    _is_quiet,
    _mono,
    normalise_root_note,
    pitch_shift_slice,
)

# C2 … C6 vocal hunt band (MIDI 36 … 84)
_F0_LO_HZ = 65.40639132514966
_F0_HI_HZ = 1046.5022612023945
_MAX_ABS_SHIFT = 4.0
_ACF_VOICED = 0.28
_MIN_VOICED_FRAMES = 1
_FRAME_SEC = 0.046
_HOP_SEC = 0.023

SCALE_INTERVALS: dict[str, tuple[int, ...]] = {
    "major": (0, 2, 4, 5, 7, 9, 11),
    "minor": (0, 2, 3, 5, 7, 8, 10),
    "dorian": (0, 2, 3, 5, 7, 9, 10),
    "phrygian": (0, 1, 3, 5, 7, 8, 10),
}
_SCALE_ALIASES = {
    "maj": "major",
    "ionian": "major",
    "min": "minor",
    "aeolian": "minor",
    "natural_minor": "minor",
    "nat_minor": "minor",
    "dor": "dorian",
    "phr": "phrygian",
}


def normalise_scale_name(scale: str) -> str:
    token = (scale or "minor").strip().lower().replace("-", "_").replace(" ", "_")
    token = _SCALE_ALIASES.get(token, token)
    if token not in SCALE_INTERVALS:
        raise ValueError(f"Unknown scale: {scale}")
    return token


def get_scale_notes(root: str, scale: str) -> list[str]:
    """Pitch-class names for ``root`` in ``scale``, tonic first."""
    tonic = normalise_root_note(root)
    mode = normalise_scale_name(scale)
    tonic_idx = NOTE_NAMES.index(tonic)
    return [NOTE_NAMES[(tonic_idx + step) % 12] for step in SCALE_INTERVALS[mode]]


def _hz_to_midi(freq: float) -> float:
    return 69.0 + 12.0 * math.log2(float(freq) / 440.0)


def _midi_to_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((float(midi) - 69.0) / 12.0))


def snap_frequency_to_scale(freq: float, root: str, scale: str) -> float:
    """Nearest scale-degree frequency (any octave) to ``freq``."""
    hz = float(freq)
    if not math.isfinite(hz) or hz <= 0.0:
        return hz
    pcs = {NOTE_NAMES.index(name) for name in get_scale_notes(root, scale)}
    midi = _hz_to_midi(hz)
    best_midi = midi
    best_dist = float("inf")
    base = int(math.floor(midi)) - 12
    for candidate in range(base, base + 25):
        if (candidate % 12) not in pcs:
            continue
        dist = abs(midi - float(candidate))
        if dist < best_dist:
            best_dist = dist
            best_midi = float(candidate)
    return _midi_to_hz(best_midi)


def clip_vocal_shift(semitones: float) -> float:
    return float(np.clip(float(semitones), -_MAX_ABS_SHIFT, _MAX_ABS_SHIFT))


def requested_semitone_shift(freq: float, root: str, scale: str) -> float:
    """Clipped correction from ``freq`` onto ``root``/``scale``."""
    hz = float(freq)
    if not math.isfinite(hz) or hz <= 0.0:
        return 0.0
    target = snap_frequency_to_scale(hz, root, scale)
    if target <= 0.0:
        return 0.0
    raw = 12.0 * math.log2(target / hz)
    return clip_vocal_shift(raw)


def _parabolic_lag(values: np.ndarray, peak_i: int) -> float:
    if peak_i <= 0 or peak_i >= len(values) - 1:
        return float(peak_i)
    left, mid, right = (float(values[peak_i - 1]), float(values[peak_i]), float(values[peak_i + 1]))
    denom = left - 2.0 * mid + right
    if abs(denom) < 1e-18:
        return float(peak_i)
    return float(peak_i) + 0.5 * (left - right) / denom


def _acf_period_hz(frame: np.ndarray, sr: int) -> float | None:
    n = int(frame.size)
    if n < 32 or sr <= 0:
        return None
    centered = np.asarray(frame, dtype=np.float64) - float(np.mean(frame))
    energy = float(np.dot(centered, centered))
    if energy < 1e-12:
        return None
    nfft = 1 << int(math.ceil(math.log2(max(8, 2 * n))))
    spectrum = np.fft.rfft(centered, n=nfft)
    acf = np.fft.irfft(np.abs(spectrum) ** 2, n=nfft)[:n]
    min_lag = max(1, int(math.floor(sr / _F0_HI_HZ)))
    max_lag = min(n - 2, int(math.ceil(sr / _F0_LO_HZ)))
    if max_lag <= min_lag:
        return None
    region = acf[min_lag : max_lag + 1]
    peak_i = int(np.argmax(region))
    peak = float(region[peak_i])
    if peak <= 0.0 or (peak / float(acf[0] if acf[0] > 0 else energy)) < _ACF_VOICED:
        return None
    lag = min_lag + _parabolic_lag(region, peak_i)
    if lag < 1.0:
        return None
    hz = float(sr) / lag
    if hz < _F0_LO_HZ * 0.92 or hz > _F0_HI_HZ * 1.08:
        return None
    return hz


def _fft_band_peak_hz(frame: np.ndarray, sr: int) -> float | None:
    n = int(frame.size)
    if n < 32 or sr <= 0:
        return None
    windowed = np.asarray(frame, dtype=np.float64) * np.hanning(n)
    mag = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    band = (freqs >= _F0_LO_HZ) & (freqs <= _F0_HI_HZ)
    if not np.any(band):
        return None
    local = mag.copy()
    local[~band] = 0.0
    peak_i = int(np.argmax(local))
    peak = float(local[peak_i])
    floor = float(np.median(mag[band]))
    if peak < 1e-10 or (floor > 0.0 and peak < floor * 4.0):
        return None
    refined = _parabolic_lag(local, peak_i)
    if refined <= 0.0:
        return None
    hz = float(refined * (sr / n))
    if hz < _F0_LO_HZ * 0.92 or hz > _F0_HI_HZ * 1.08:
        return None
    return hz


def estimate_median_f0(audio_mono: np.ndarray, sr: int = 44100) -> float | None:
    """Median voiced f0 in C2–C6. None when empty, quiet, or unvoiced."""
    mono = np.asarray(audio_mono, dtype=np.float64)
    if mono.ndim > 1:
        mono = _mono(mono)
    if mono.size == 0 or sr <= 0 or _is_quiet(mono):
        return None
    frame = max(64, int(round(sr * _FRAME_SEC)))
    hop = max(32, int(round(sr * _HOP_SEC)))
    votes: list[float] = []
    if len(mono) < frame:
        chunks = [mono]
    else:
        chunks = [mono[i : i + frame] for i in range(0, len(mono) - frame + 1, hop)]
    for chunk in chunks:
        if _is_quiet(chunk):
            continue
        hz = _acf_period_hz(chunk, sr)
        if hz is None:
            hz = _fft_band_peak_hz(chunk, sr)
        if hz is not None:
            votes.append(hz)
    if len(votes) < _MIN_VOICED_FRAMES:
        hz = _acf_period_hz(mono, sr)
        if hz is None:
            hz = _fft_band_peak_hz(mono, sr)
        return hz
    return float(np.median(np.asarray(votes, dtype=np.float64)))


def tune_vocal_buffer(
    audio: np.ndarray,
    sr: int = 44100,
    key: str = "A",
    scale: str = "minor",
) -> np.ndarray:
    """Snap a mono ``(N,)`` or stereo ``(N, ch)`` vocal buffer onto ``key``/``scale``."""
    source = np.asarray(audio)
    if source.size == 0:
        return audio
    mono = _mono(source)
    if _is_quiet(mono):
        return audio
    f0 = estimate_median_f0(mono, sr=int(sr))
    if f0 is None:
        return audio
    shift = requested_semitone_shift(f0, key, scale)
    if abs(shift) < _NOOP_SEMITONES:
        return audio
    return pitch_shift_slice(source, shift, sr=int(sr))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scale-quantize a vocal wav to root + mode")
    parser.add_argument("--input", "-i", required=True)
    parser.add_argument("--output", "-o", required=True)
    parser.add_argument("--key", "-k", default="A")
    parser.add_argument("--scale", "-s", default="minor")
    args = parser.parse_args(argv)
    try:
        import soundfile as sf
    except ImportError:
        print("[ERROR] soundfile is required for CLI use", file=sys.stderr)
        return 1
    data, sample_rate = sf.read(args.input, always_2d=False)
    tuned = tune_vocal_buffer(data, sr=int(sample_rate), key=args.key, scale=args.scale)
    sf.write(args.output, tuned, int(sample_rate), subtype="PCM_24")
    print(f"[VOCAL TUNE] key={normalise_root_note(args.key)} scale={normalise_scale_name(args.scale)} -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
