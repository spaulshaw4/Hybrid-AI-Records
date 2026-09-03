"""Engineered spectral/temporal features for a 4 s slice. numpy + scipy only.

librosa/numba/soxr are unreliable on this workstation, so nothing here imports
them. Everything is plain numpy plus ``scipy.signal`` / ``scipy.fft``, which are
both known good.

The extractor turns a variable-length mono buffer into a fixed-length float32
vector. Frame-level descriptors are summarized with mean and standard deviation
so the vector length never depends on slice duration.
"""
from __future__ import annotations

import numpy as np
from scipy import fft as sp_fft
from scipy import signal as sp_signal

TARGET_SR = 22050
N_FFT = 1024
HOP = 512
N_MELS = 40
N_MFCC = 20
EPS = 1e-10

#: Band edges in Hz used for the energy-ratio features.
BAND_EDGES = (0.0, 60.0, 250.0, 500.0, 2000.0, 6000.0, float(TARGET_SR) / 2.0)


def _hz_to_mel(hz: np.ndarray | float) -> np.ndarray | float:
    return 2595.0 * np.log10(1.0 + np.asarray(hz, dtype=np.float64) / 700.0)


def _mel_to_hz(mel: np.ndarray | float) -> np.ndarray | float:
    return 700.0 * (10.0 ** (np.asarray(mel, dtype=np.float64) / 2595.0) - 1.0)


def mel_filterbank(sr: int = TARGET_SR, n_fft: int = N_FFT, n_mels: int = N_MELS) -> np.ndarray:
    """Slaney-style triangular mel filterbank, shape ``(n_mels, n_fft//2 + 1)``."""
    fmin, fmax = 0.0, sr / 2.0
    mel_points = np.linspace(_hz_to_mel(fmin), _hz_to_mel(fmax), n_mels + 2)
    hz_points = np.asarray(_mel_to_hz(mel_points), dtype=np.float64)
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    fb = np.zeros((n_mels, freqs.size), dtype=np.float64)
    for i in range(n_mels):
        left, center, right = hz_points[i], hz_points[i + 1], hz_points[i + 2]
        if right <= left:
            continue
        rising = (freqs - left) / max(center - left, EPS)
        falling = (right - freqs) / max(right - center, EPS)
        fb[i] = np.clip(np.minimum(rising, falling), 0.0, None)
    return fb


# Built once at import; the filterbank only depends on constants.
_MEL_FB = mel_filterbank()
_FREQS = np.fft.rfftfreq(N_FFT, 1.0 / TARGET_SR)


def to_mono(data: np.ndarray) -> np.ndarray:
    """Collapse any channel layout to a 1-D float64 buffer."""
    arr = np.asarray(data, dtype=np.float64)
    if arr.ndim == 1:
        return arr
    return arr.mean(axis=1)


def resample_to_target(mono: np.ndarray, sr: int, target_sr: int = TARGET_SR) -> np.ndarray:
    """Polyphase resample. Avoids soxr/librosa entirely."""
    sr = int(sr)
    if sr == target_sr or mono.size == 0:
        return mono
    gcd = np.gcd(sr, target_sr)
    return sp_signal.resample_poly(mono, target_sr // gcd, sr // gcd).astype(np.float64)


def _stats(values: np.ndarray) -> tuple[float, float]:
    """Mean and std of a frame series, safe on empty input."""
    if values.size == 0:
        return 0.0, 0.0
    return float(np.mean(values)), float(np.std(values))


def _magnitude_spectrogram(mono: np.ndarray) -> np.ndarray:
    """``(n_frames, n_bins)`` magnitude STFT with a Hann window."""
    if mono.size < N_FFT:
        mono = np.pad(mono, (0, N_FFT - mono.size))
    window = np.hanning(N_FFT)
    n_frames = 1 + (mono.size - N_FFT) // HOP
    if n_frames < 1:
        n_frames = 1
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    frames = mono[idx] * window[None, :]
    return np.abs(sp_fft.rfft(frames, axis=1))


def feature_names() -> list[str]:
    """Ordered feature names; length equals the extracted vector length."""
    names: list[str] = []
    names += [f"logmel{i}_mean" for i in range(N_MELS)]
    names += [f"logmel{i}_std" for i in range(N_MELS)]
    names += [f"mfcc{i}_mean" for i in range(N_MFCC)]
    names += [f"mfcc{i}_std" for i in range(N_MFCC)]
    names += [f"dmfcc{i}_mean" for i in range(N_MFCC)]
    names += [f"dmfcc{i}_std" for i in range(N_MFCC)]
    for base in (
        "centroid",
        "bandwidth",
        "rolloff85",
        "rolloff95",
        "flatness",
        "flux",
        "zcr",
        "rms_db",
    ):
        names += [f"{base}_mean", f"{base}_std"]
    names += [f"band{i}_ratio" for i in range(len(BAND_EDGES) - 1)]
    names += [
        "crest_factor",
        "onset_rate",
        "attack_slope",
        "env_skew",
        "flux_percussive_ratio",
        "harmonic_peak_ratio",
        "low_high_ratio",
        "silence_fraction",
    ]
    return names


N_FEATURES = len(feature_names())


def extract_features(mono: np.ndarray, sr: int) -> np.ndarray:
    """Fixed-length float32 feature vector for one slice.

    Deterministic: same buffer in, bit-identical vector out.
    """
    mono = to_mono(mono)
    if mono.size == 0:
        return np.zeros(N_FEATURES, dtype=np.float32)
    mono = resample_to_target(mono, sr)
    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    if peak > EPS:
        mono = mono / peak  # loudness-invariant; level is already a DB column

    mag = _magnitude_spectrogram(mono)
    power = mag**2
    frame_energy = power.sum(axis=1) + EPS

    mel = mag @ _MEL_FB.T
    log_mel = np.log(mel + EPS)
    mfcc = sp_fft.dct(log_mel, type=2, axis=1, norm="ortho")[:, :N_MFCC]
    dmfcc = np.diff(mfcc, axis=0) if mfcc.shape[0] > 1 else np.zeros((1, N_MFCC))

    feats: list[float] = []
    feats += list(np.mean(log_mel, axis=0))
    feats += list(np.std(log_mel, axis=0))
    feats += list(np.mean(mfcc, axis=0))
    feats += list(np.std(mfcc, axis=0))
    feats += list(np.mean(dmfcc, axis=0))
    feats += list(np.std(dmfcc, axis=0))

    centroid = (power @ _FREQS) / frame_energy
    spread = np.sqrt(
        np.maximum((power @ (_FREQS**2)) / frame_energy - centroid**2, 0.0)
    )
    cumulative = np.cumsum(power, axis=1)
    totals = cumulative[:, -1:] + EPS
    rolloff85 = _FREQS[np.argmax(cumulative >= 0.85 * totals, axis=1)]
    rolloff95 = _FREQS[np.argmax(cumulative >= 0.95 * totals, axis=1)]
    flatness = np.exp(np.mean(np.log(mag + EPS), axis=1)) / (np.mean(mag, axis=1) + EPS)
    flux = np.sqrt(np.sum(np.diff(mag, axis=0) ** 2, axis=1)) if mag.shape[0] > 1 else np.zeros(1)

    frame_len = N_FFT
    n_frames = mag.shape[0]
    idx = np.arange(frame_len)[None, :] + HOP * np.arange(n_frames)[:, None]
    padded = np.pad(mono, (0, max(0, int(idx.max()) + 1 - mono.size)))
    time_frames = padded[idx]
    zcr = np.mean(np.abs(np.diff(np.sign(time_frames), axis=1)) > 0, axis=1)
    rms = np.sqrt(np.mean(time_frames**2, axis=1) + EPS)
    rms_db = 20.0 * np.log10(rms + EPS)

    for series in (centroid, spread, rolloff85, rolloff95, flatness, flux, zcr, rms_db):
        mean, std = _stats(np.asarray(series, dtype=np.float64))
        feats += [mean, std]

    total_power = float(power.sum()) + EPS
    for lo, hi in zip(BAND_EDGES[:-1], BAND_EDGES[1:]):
        band = (_FREQS >= lo) & (_FREQS < hi)
        feats.append(float(power[:, band].sum()) / total_power)

    env = rms
    env_mean = float(np.mean(env)) + EPS
    feats.append(float(np.max(np.abs(mono))) / (float(np.sqrt(np.mean(mono**2))) + EPS))
    # Onset rate: fraction of frames where flux jumps above its own upper quantile.
    if flux.size > 1:
        thresh = float(np.quantile(flux, 0.75)) + EPS
        onset_rate = float(np.mean(flux > thresh))
        strong = flux[flux > thresh]
        flux_ratio = float(np.sum(strong) / (np.sum(flux) + EPS))
    else:
        onset_rate, flux_ratio = 0.0, 0.0
    feats.append(onset_rate)
    peak_frame = int(np.argmax(env))
    feats.append(float(env[peak_frame] / (peak_frame + 1)))
    centered = env - env_mean
    denom = (float(np.std(env)) + EPS) ** 3
    feats.append(float(np.mean(centered**3) / denom))
    feats.append(flux_ratio)
    # Harmonic-ness proxy: how concentrated each frame is in its loudest bins.
    top_k = max(1, mag.shape[1] // 64)
    part = np.partition(power, -top_k, axis=1)[:, -top_k:]
    feats.append(float(np.mean(part.sum(axis=1) / frame_energy)))
    low = float(power[:, _FREQS < 500.0].sum())
    high = float(power[:, _FREQS >= 500.0].sum())
    feats.append(low / (high + EPS))
    feats.append(float(np.mean(rms_db < -60.0)))

    vec = np.asarray(feats, dtype=np.float32)
    if vec.size != N_FEATURES:  # pragma: no cover - guards refactors
        raise AssertionError(f"expected {N_FEATURES} features, built {vec.size}")
    return np.nan_to_num(vec, nan=0.0, posinf=0.0, neginf=0.0)


def extract_from_file(path: str) -> np.ndarray | None:
    """Read a wav and extract features. ``None`` if the file cannot be read."""
    try:
        import soundfile as sf

        data, sr = sf.read(path, always_2d=True, dtype="float64")
    except Exception:
        return None
    try:
        return extract_features(data, int(sr))
    except Exception:
        return None
