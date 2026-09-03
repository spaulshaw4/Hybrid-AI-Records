"""WSOLA-style tempo lock that keeps pitch and pads to a fixed slice length.

BPM estimate uses onset strength + autocorrelation in numpy. Librosa is
optional and only imported when HYBRID_USE_LIBROSA=1.
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np

_RATE_PASSTHROUGH = 0.01
_RATE_MIN = 0.5
_RATE_MAX = 2.0


def _as_frames(audio: np.ndarray) -> np.ndarray:
    data = np.asarray(audio)
    if data.ndim == 1:
        return np.column_stack((data, data))
    if data.shape[-1] == 1:
        return np.column_stack((data[..., 0], data[..., 0]))
    return data


def _mono(audio: np.ndarray) -> np.ndarray:
    return np.mean(_as_frames(audio), axis=1)


def _optional_librosa():
    flag = os.environ.get("HYBRID_USE_LIBROSA", "").strip().lower()
    if flag not in {"1", "true", "yes"}:
        return None
    try:
        import librosa

        return librosa
    except Exception:
        return None


def _onset_envelope(mono: np.ndarray, sr: int, hop: int = 512) -> np.ndarray:
    n_fft = 1024
    window = np.hanning(n_fft)
    prev = None
    flux = []
    limit = max(0, len(mono) - n_fft)
    for i in range(0, limit + 1, hop) if limit > 0 or len(mono) >= n_fft else []:
        chunk = mono[i : i + n_fft]
        if len(chunk) < n_fft:
            chunk = np.pad(chunk, (0, n_fft - len(chunk)))
        spec = np.abs(np.fft.rfft(chunk * window))
        if prev is None:
            flux.append(0.0)
        else:
            flux.append(float(np.sum(np.maximum(spec - prev, 0.0))))
        prev = spec
    if not flux and len(mono) > 0:
        padded = np.pad(mono, (0, max(0, n_fft - len(mono))))
        spec = np.abs(np.fft.rfft(padded[:n_fft] * window))
        flux.append(float(np.sum(spec)))
    env = np.asarray(flux, dtype=np.float64)
    if env.size == 0:
        return np.zeros(1)
    env -= np.median(env)
    env = np.maximum(env, 0.0)
    return env


def _bpm_from_autocorr(env: np.ndarray, sr: int, hop: int) -> float | None:
    if env.size < 8:
        return None
    centered = env - np.mean(env)
    corr = np.correlate(centered, centered, mode="full")[len(centered) - 1 :]
    min_lag = int(sr / hop / (220.0 / 60.0))
    max_lag = int(sr / hop / (60.0 / 60.0))
    min_lag = max(1, min_lag)
    max_lag = min(len(corr) - 1, max(min_lag + 1, max_lag))
    if max_lag <= min_lag:
        return None
    peak_lag = min_lag + int(np.argmax(corr[min_lag:max_lag]))
    if peak_lag <= 0:
        return None
    return float((sr / hop) * 60.0 / peak_lag)


def _bpm_from_onset_intervals(env: np.ndarray, sr: int, hop: int) -> float | None:
    if env.size < 4:
        return None
    thresh = float(np.mean(env) + 0.4 * np.std(env))
    interior = env[1:-1]
    peaks = np.where((interior > env[:-2]) & (interior > env[2:]) & (interior > thresh))[0] + 1
    if peaks.size < 2:
        return None
    intervals = np.diff(peaks.astype(np.float64))
    med = float(np.median(intervals))
    if med < 1.0:
        return None
    bpm = float((sr / hop) * 60.0 / med)
    if bpm < 40.0 or bpm > 240.0:
        return None
    return bpm


def estimate_slice_bpm(audio_mono: np.ndarray, sr: int = 44100) -> float:
    """Onset-strength autocorrelation BPM. Numpy path is the default."""
    mono = np.asarray(audio_mono, dtype=np.float64)
    if mono.ndim > 1:
        mono = _mono(mono)
    hop = 512
    env = _onset_envelope(mono, sr, hop=hop)
    bpm = _bpm_from_autocorr(env, sr, hop)
    if bpm is None:
        bpm = _bpm_from_onset_intervals(env, sr, hop)
    if bpm is None:
        librosa = _optional_librosa()
        if librosa is not None:
            try:
                onset_env = librosa.onset.onset_strength(y=mono, sr=sr)
                tempo = librosa.beat.tempo(onset_envelope=onset_env, sr=sr, aggregate=np.median)
                bpm = float(np.atleast_1d(tempo)[0]) if len(np.atleast_1d(tempo)) else None
            except Exception:
                bpm = None
    return float(bpm) if bpm is not None else 120.0


def _wsola_channel(y: np.ndarray, rate: float, win: int = 1024, hop_s: int = 256) -> np.ndarray:
    if len(y) < win * 2:
        from scipy.signal import resample

        return resample(y, max(1, int(round(len(y) / rate))))
    hop_a = max(1, int(round(hop_s * rate)))
    search = hop_s
    window = np.hanning(win)
    out_len = max(win, int(round(len(y) / rate)) + win)
    out = np.zeros(out_len, dtype=np.float64)
    norm = np.zeros(out_len, dtype=np.float64)
    read = 0
    write = 0
    while write + win < out_len and read + win < len(y):
        lo = max(0, read - search)
        hi = min(len(y) - win, read + search)
        target = out[write : write + win] if write > 0 else y[read : read + win]
        # Baseline the search at ``read`` itself. A silent target region makes
        # every candidate score 0.0, and picking the first candidate instead
        # would rewind the read pointer by ``search`` on every hop: the reader
        # would then crawl forward at (hop_a - search) samples per iteration
        # while the writer advances hop_s, so a slice with a long silent head
        # ran the writer off the end and rendered as digital silence.
        best = int(min(max(read, lo), hi))
        best_score = float(np.dot(y[best : best + win], target))
        for cand in range(lo, hi + 1, 8):
            chunk = y[cand : cand + win]
            score = float(np.dot(chunk, target))
            if score > best_score:
                best_score = score
                best = cand
        framed = y[best : best + win] * window
        out[write : write + win] += framed
        norm[write : write + win] += window
        write += hop_s
        read = best + hop_a
    norm = np.maximum(norm, 1e-8)
    return (out / norm)[: max(1, int(round(len(y) / rate)))]


def clip_stretch_rate(rate: float) -> float:
    """Clamp a tempo ratio so WSOLA never sees an extreme stretch."""
    return float(min(_RATE_MAX, max(_RATE_MIN, float(rate))))


def time_stretch_wsola(audio: np.ndarray, rate_multiplier: float, sr: int = 44100) -> np.ndarray:
    del sr
    source = np.asarray(audio)
    if source.size == 0:
        return audio
    rate = float(rate_multiplier)
    if abs(rate - 1.0) < _RATE_PASSTHROUGH:
        return audio
    rate = clip_stretch_rate(rate)
    if abs(rate - 1.0) < _RATE_PASSTHROUGH:
        return audio
    frames = _as_frames(audio)
    librosa = _optional_librosa()
    channels = []
    for ch in range(frames.shape[1]):
        y = np.asarray(frames[:, ch], dtype=np.float64)
        stretched = None
        if librosa is not None:
            try:
                stretched = librosa.effects.time_stretch(y, rate=rate)
            except Exception:
                stretched = None
        if stretched is None:
            stretched = _wsola_channel(y, rate)
        channels.append(stretched)
    min_len = min(len(ch) for ch in channels)
    out = np.column_stack([ch[:min_len] for ch in channels])
    source = np.asarray(audio)
    if source.ndim == 1:
        return out[:, 0].astype(source.dtype, copy=False)
    return out.astype(source.dtype, copy=False)


def fold_bpm_octave(current_bpm: float, target_bpm: float) -> float:
    """Fold half/double-time estimates toward the target tempo."""
    target = float(target_bpm)
    bpm = float(current_bpm) if current_bpm > 1e-6 else target
    if target <= 1e-6:
        return bpm
    while bpm < target * 0.70:
        bpm *= 2.0
    while bpm > target * 1.40:
        bpm /= 2.0
    return bpm


def lock_slice_to_tempo(
    audio_stereo: np.ndarray,
    target_bpm: float = 120.0,
    sr: int = 44100,
    target_samples: int | None = None,
    original_bpm: float | None = None,
) -> np.ndarray:
    if np.asarray(audio_stereo).size == 0 or float(target_bpm) <= 0.0:
        return audio_stereo
    if target_samples is None:
        target_samples = int(4 * sr)
    if original_bpm is None or float(original_bpm) <= 0.0:
        current = estimate_slice_bpm(_mono(audio_stereo), sr=sr)
    else:
        current = float(original_bpm)
    current = fold_bpm_octave(current, target_bpm)
    rate = float(target_bpm) / current if current > 1e-6 else 1.0
    rate = clip_stretch_rate(rate)
    stretched = time_stretch_wsola(audio_stereo, rate_multiplier=rate, sr=sr)
    frames = _as_frames(stretched)
    if len(frames) < target_samples:
        pad = np.zeros((target_samples - len(frames), frames.shape[1]), dtype=frames.dtype)
        frames = np.vstack((frames, pad))
    else:
        frames = frames[:target_samples]
    if np.asarray(audio_stereo).ndim == 1:
        return frames[:, 0]
    return frames


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Lock a slice to a target tempo")
    parser.add_argument("-i", "--input", required=True)
    parser.add_argument("-o", "--output", required=True)
    parser.add_argument("--bpm", type=float, default=120.0)
    args = parser.parse_args()
    try:
        import soundfile as sf
    except ImportError:
        print("[ERROR] soundfile is required for CLI use", file=sys.stderr)
        sys.exit(1)
    data, sample_rate = sf.read(args.input, always_2d=True)
    locked = lock_slice_to_tempo(data, target_bpm=args.bpm, sr=sample_rate)
    sf.write(args.output, locked, sample_rate, subtype="PCM_24")
