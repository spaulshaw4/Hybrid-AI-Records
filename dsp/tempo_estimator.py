"""Tempo estimation for short slices. numpy + scipy only.

Replaces the integer-lag autocorrelation peak in ``dsp.tempo_time_stretch``.
That estimator read the BPM straight off ``argmax`` of a frame-rate
autocorrelation, so every answer had to be ``frame_rate * 60 / lag`` for an
integer ``lag``. At 44100 Hz with hop 512 only lags 23..85 fall inside its
60-220 BPM window, which is why the whole 1.39M-row corpus carries just 63
distinct tempos and why the spacing above 150 BPM exceeds the +/-3% the
selector matches on.

Three things change here:

* the tempo axis is a continuous log-spaced grid, scored by interpolating the
  autocorrelation at fractional lags, so the output is not quantised at all;
* the score is a harmonic comb (lag, 2*lag, 3*lag, 4*lag) minus the offbeat
  half-lags, which is what separates a true beat period from its own
  subdivisions instead of letting ``argmax`` take whichever is tallest;
* a log-normal prior around 120 BPM breaks the remaining octave ties, and the
  returned confidence lets callers drop slices with no tempo at all.

librosa/numba/soxr are unreliable on this workstation (see
``ml.audio_features``), so nothing here imports them.
"""
from __future__ import annotations

import numpy as np
from scipy import fft as sp_fft
from scipy import signal as sp_signal

TARGET_SR = 22050
N_FFT = 1024
#: 5.8 ms frames. Onset positions are what limit accuracy once the tempo axis
#: itself is continuous, so the hop is a quarter of the one the old path used.
HOP = 128
N_MELS = 48
EPS = 1e-10

BPM_MIN = 50.0
BPM_MAX = 215.0
#: 0.25% steps. Finer than the +/-3% window the selector cares about by more
#: than an order of magnitude, and still only ~600 grid points.
BPM_STEPS = 600

#: Beat-period multiples summed by the comb, unweighted. Terms past
#: ``_MAX_LAG_FRACTION`` of the envelope contribute nothing, so slow hypotheses
#: naturally get fewer terms than fast ones -- that asymmetry is deliberate and
#: measured: it is what stops a 4 s slice from reading as half-time.
_COMB_MULTIPLES = (1.0, 2.0, 3.0, 4.0, 5.0, 6.0)
#: The autocorrelation past this fraction of the envelope is built from too
#: little overlap to trust.
_MAX_LAG_FRACTION = 0.7

#: Subtracted at 2/3 and 4/3 of the candidate period. A dotted reading (period
#: 1.5 beats) was the single largest error class in the first version: its comb
#: lands on true beats at multiples 2 and 4, so nothing else distinguishes it.
#: For the true period these two taps fall between beats and cost nothing.
_THIRD_MULTIPLES = (2.0 / 3.0, 4.0 / 3.0)
_THIRD_WEIGHT = 0.8

#: Log-normal tempo prior. Tuned on a held-out-free dev half of the filename
#: ground truth; the corpus is dance/production loops and really is centred
#: near 120. Half an octave of spread still admits 85-170 comfortably.
_PRIOR_CENTER_BPM = 120.0
_PRIOR_SIGMA_OCTAVES = 0.5
#: Overlap-normalisation exponent: ``corr[l] / (n - l) ** _OVERLAP_EXPONENT``.
#: 1.0 is fully unbiased and too noisy at long lags; 0.0 is the raw biased
#: estimate and favours fast tempos. The midpoint measured best.
_OVERLAP_EXPONENT = 0.5

_MEL_FB_CACHE: dict[tuple[int, int, int], np.ndarray] = {}


def _mel_filterbank(sr: int, n_fft: int, n_mels: int) -> np.ndarray:
    key = (sr, n_fft, n_mels)
    cached = _MEL_FB_CACHE.get(key)
    if cached is not None:
        return cached
    def to_mel(hz: np.ndarray) -> np.ndarray:
        return 2595.0 * np.log10(1.0 + hz / 700.0)

    def to_hz(mel: np.ndarray) -> np.ndarray:
        return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)

    edges = to_hz(np.linspace(to_mel(np.array(0.0)), to_mel(np.array(sr / 2.0)), n_mels + 2))
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    fb = np.zeros((n_mels, freqs.size), dtype=np.float64)
    for i in range(n_mels):
        left, center, right = edges[i], edges[i + 1], edges[i + 2]
        if right <= left:
            continue
        rising = (freqs - left) / max(center - left, EPS)
        falling = (right - freqs) / max(right - center, EPS)
        fb[i] = np.clip(np.minimum(rising, falling), 0.0, None)
    _MEL_FB_CACHE[key] = fb
    return fb


def _to_mono(data: np.ndarray) -> np.ndarray:
    arr = np.asarray(data, dtype=np.float64)
    if arr.ndim == 1:
        return arr
    return arr.mean(axis=1)


def _resample(mono: np.ndarray, sr: int, target_sr: int = TARGET_SR) -> np.ndarray:
    sr = int(sr)
    if sr == target_sr or mono.size == 0:
        return mono
    gcd = int(np.gcd(sr, target_sr))
    return np.asarray(
        sp_signal.resample_poly(mono, target_sr // gcd, sr // gcd), dtype=np.float64
    )


def onset_envelope(mono: np.ndarray, sr: int = TARGET_SR) -> np.ndarray:
    """Half-wave-rectified log-mel flux, local-mean removed.

    Log compression before the difference is what makes this usable across the
    corpus: the raw linear flux the old estimator used is dominated by whichever
    hit happens to be loudest, so a loop with one big kick and three quiet ones
    autocorrelates at the bar, not the beat.
    """
    mono = np.asarray(mono, dtype=np.float64)
    if mono.size < N_FFT:
        mono = np.pad(mono, (0, N_FFT - mono.size))
    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    if peak > EPS:
        mono = mono / peak
    window = np.hanning(N_FFT)
    n_frames = 1 + (mono.size - N_FFT) // HOP
    if n_frames < 2:
        return np.zeros(1, dtype=np.float64)
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    mag = np.abs(sp_fft.rfft(mono[idx] * window, axis=1))
    mel = mag @ _mel_filterbank(sr, N_FFT, N_MELS).T
    log_mel = np.log1p(1000.0 * mel)
    flux = np.maximum(0.0, np.diff(log_mel, axis=0)).sum(axis=1)
    if flux.size < 2:
        return np.zeros(1, dtype=np.float64)
    # Subtract a ~0.15 s moving average so sustained material does not add a
    # DC floor that swamps the periodic part of the autocorrelation.
    win = max(3, int(round(0.15 * sr / HOP)) | 1)
    kernel = np.ones(win, dtype=np.float64) / float(win)
    local = np.convolve(flux, kernel, mode="same")
    env = np.maximum(0.0, flux - local)
    scale = float(np.max(env))
    return env / scale if scale > EPS else env


def _autocorrelation(env: np.ndarray) -> np.ndarray:
    """Overlap-compensated autocorrelation of the onset envelope, peak-scaled.

    Computed through the FFT, so cost is independent of the lag range. The
    partial division by overlap count keeps long lags comparable to short ones
    without fully amplifying their noise.
    """
    centered = env - float(np.mean(env))
    n = centered.size
    size = int(1 << (2 * n - 1).bit_length())
    spec = sp_fft.rfft(centered, size)
    corr = sp_fft.irfft(spec * np.conj(spec), size)[:n]
    overlap = np.arange(n, 0, -1, dtype=np.float64) ** _OVERLAP_EXPONENT
    corr = corr / overlap
    head = float(corr[0])
    return corr / head if head > EPS else corr


def _interp_at(corr: np.ndarray, lags: np.ndarray) -> np.ndarray:
    """Linear interpolation of ``corr`` at fractional lags; 0 past the limit."""
    limit = min(corr.size, int(_MAX_LAG_FRACTION * corr.size))
    floor = np.floor(lags).astype(np.int64)
    frac = lags - floor
    valid = (floor >= 0) & (floor + 1 < limit)
    out = np.zeros(lags.shape, dtype=np.float64)
    fi = floor[valid]
    out[valid] = corr[fi] * (1.0 - frac[valid]) + corr[fi + 1] * frac[valid]
    return out


def _tempo_grid() -> np.ndarray:
    return np.exp(np.linspace(np.log(BPM_MIN), np.log(BPM_MAX), BPM_STEPS))


_GRID = _tempo_grid()
_LOG_PRIOR = -0.5 * (
    (np.log2(_GRID / _PRIOR_CENTER_BPM) / _PRIOR_SIGMA_OCTAVES) ** 2
)
_PRIOR = np.exp(_LOG_PRIOR)


def tempo_salience(env: np.ndarray, sr: int = TARGET_SR, hop: int = HOP) -> np.ndarray:
    """Comb-filter score over ``_GRID``, prior applied. Same length as the grid."""
    if env.size < 8:
        return np.zeros(_GRID.size, dtype=np.float64)
    corr = _autocorrelation(env)
    frame_rate = float(sr) / float(hop)
    base_lags = frame_rate * 60.0 / _GRID
    score = np.zeros(_GRID.size, dtype=np.float64)
    for mult in _COMB_MULTIPLES:
        score += _interp_at(corr, base_lags * mult)
    for mult in _THIRD_MULTIPLES:
        score -= _THIRD_WEIGHT * _interp_at(corr, base_lags * mult)
    return score * _PRIOR


def estimate_tempo(audio: np.ndarray, sr: int = TARGET_SR) -> tuple[float, float]:
    """Return ``(bpm, confidence)`` for one buffer.

    Confidence is the winning comb score normalised by the grid's own spread,
    so a pad with no beat lands near 0 and a clean drum loop near 1.
    ``bpm`` is 0.0 only when the buffer is too short to frame.
    """
    mono = _to_mono(audio)
    if mono.size == 0:
        return 0.0, 0.0
    mono = _resample(mono, int(sr), TARGET_SR)
    env = onset_envelope(mono, TARGET_SR)
    if env.size < 8 or float(np.max(env)) <= EPS:
        return 0.0, 0.0
    score = tempo_salience(env, TARGET_SR, HOP)
    best = int(np.argmax(score))
    peak = float(score[best])
    if peak <= 0.0:
        return 0.0, 0.0
    bpm = _parabolic_peak(score, best)
    spread = float(np.mean(np.abs(score)))
    conf = peak / (peak + 4.0 * spread) if spread > EPS else 0.0
    return float(bpm), float(min(1.0, max(0.0, conf)))


def _parabolic_peak(score: np.ndarray, best: int) -> float:
    """Sub-grid peak in log-tempo space. The grid is log-spaced, so the shift
    is applied as a ratio rather than an offset."""
    if best <= 0 or best >= score.size - 1:
        return float(_GRID[best])
    left, mid, right = float(score[best - 1]), float(score[best]), float(score[best + 1])
    denom = left - 2.0 * mid + right
    if abs(denom) < EPS:
        return float(_GRID[best])
    delta = 0.5 * (left - right) / denom
    delta = float(np.clip(delta, -1.0, 1.0))
    step = np.log(BPM_MAX / BPM_MIN) / (BPM_STEPS - 1)
    return float(_GRID[best] * np.exp(delta * step))


def estimate_tempo_from_file(path: str) -> tuple[float, float, float] | None:
    """``(bpm, confidence, duration_sec)`` for a wav, or None if unreadable."""
    try:
        import soundfile as sf

        data, sr = sf.read(path, always_2d=True, dtype="float64")
    except Exception:
        return None
    try:
        bpm, conf = estimate_tempo(data, int(sr))
    except Exception:
        return None
    n = int(np.asarray(data).shape[0])
    return bpm, conf, (float(n) / float(sr) if sr else 0.0)
