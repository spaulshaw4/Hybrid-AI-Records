"""GCC-PHAT integer delay alignment of a target stem onto a reference."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

DEFAULT_MAX_SHIFT_MS = 50.0
DEFAULT_MIN_PEAK = 0.18


@dataclass(frozen=True)
class PhaseAlignResult:
    aligned: np.ndarray
    lag_samples: int
    peak: float
    applied: bool

    def __iter__(self):
        yield self.aligned
        yield self.lag_samples


def _as_frames(audio: np.ndarray) -> tuple[np.ndarray, bool]:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return data[:, np.newaxis], True
    return data, False


def _restore_shape(frames: np.ndarray, was_1d: bool, dtype: np.dtype) -> np.ndarray:
    out = frames[:, 0] if was_1d else frames
    return out.astype(dtype, copy=False)


def _mono_mix(frames: np.ndarray) -> np.ndarray:
    return np.mean(frames, axis=1)


def _shift_frames(frames: np.ndarray, lag: int) -> np.ndarray:
    """
    ``lag > 0`` means the target is late vs the reference: drop the leading
    ``lag`` samples and zero-pad the tail. No wrap (``np.roll`` would invent
    a click at the seam).
    """
    n = frames.shape[0]
    if lag == 0 or n == 0:
        return frames.copy()
    out = np.zeros_like(frames)
    if lag > 0:
        if lag >= n:
            return out
        out[: n - lag] = frames[lag:]
        return out
    lead = -lag
    if lead >= n:
        return out
    out[lead:] = frames[: n - lead]
    return out


def _flip_corr_lag(idx: int, max_shift: int) -> int:
    # xcorr(ref, tgt) / IFFT(ref * conj(tgt)) peaks negative when tgt is late.
    return -int(idx - max_shift)


def _gcc_phat_lag(reference: np.ndarray, target: np.ndarray, max_lag: int) -> tuple[int, float]:
    n = int(min(reference.shape[0], target.shape[0]))
    if n < 8 or max_lag <= 0:
        return 0, 0.0
    ref = np.asarray(reference[:n], dtype=np.float64)
    tgt = np.asarray(target[:n], dtype=np.float64)
    nfft = 1 << (2 * n - 1).bit_length()
    spec = np.fft.rfft(ref, n=nfft) * np.conj(np.fft.rfft(tgt, n=nfft))
    mag = np.abs(spec)
    spec = np.divide(spec, mag, out=np.zeros_like(spec), where=mag > 1e-12)
    cc = np.fft.irfft(spec, n=nfft)
    max_shift = min(int(max_lag), nfft // 2, n - 1)
    window = np.concatenate((cc[-max_shift:], cc[: max_shift + 1]))
    idx = int(np.argmax(window))
    return _flip_corr_lag(idx, max_shift), float(window[idx])


def _time_xcorr_lag(reference: np.ndarray, target: np.ndarray, max_lag: int) -> tuple[int, float]:
    """Broadband fallback — PHAT is unstable on narrow tones."""
    n = int(min(reference.shape[0], target.shape[0]))
    if n < 8 or max_lag <= 0:
        return 0, 0.0
    max_shift = min(int(max_lag), n - 1)
    corr = np.correlate(reference[:n], target[:n], mode="full")
    center = n - 1
    window = corr[center - max_shift : center + max_shift + 1]
    idx = int(np.argmax(np.abs(window)))
    return _flip_corr_lag(idx, max_shift), float(window[idx])


def _pearson_at_lag(reference: np.ndarray, target: np.ndarray, lag: int) -> float:
    n = int(min(reference.shape[0], target.shape[0]))
    if n < 8:
        return 0.0
    if lag > 0:
        a = reference[: n - lag]
        b = target[lag:n]
    elif lag < 0:
        a = reference[-lag:n]
        b = target[: n + lag]
    else:
        a = reference[:n]
        b = target[:n]
    if a.size < 8:
        return 0.0
    a = a - np.mean(a)
    b = b - np.mean(b)
    denom = float(np.sqrt(np.sum(a * a) * np.sum(b * b)))
    if denom < 1e-12:
        return 0.0
    return float(np.clip(np.sum(a * b) / denom, -1.0, 1.0))


def align_to_reference(
    target: np.ndarray,
    reference: np.ndarray,
    sr: int = 44100,
    max_shift_ms: float = DEFAULT_MAX_SHIFT_MS,
    min_peak: float = DEFAULT_MIN_PEAK,
) -> PhaseAlignResult:
    """
    Estimate an integer lag via GCC-PHAT and shift every target channel by
    that same lag. A weak peak returns an unshifted copy (lag 0) so a noisy
    cross-spectrum cannot invent a huge delay.
    """
    tgt_frames, tgt_1d = _as_frames(target)
    ref_frames, _ref_1d = _as_frames(reference)
    if tgt_frames.shape[0] == 0 or ref_frames.shape[0] == 0 or sr <= 0:
        aligned = _restore_shape(tgt_frames.copy(), tgt_1d, target.dtype)
        return PhaseAlignResult(aligned=aligned, lag_samples=0, peak=0.0, applied=False)

    max_lag = max(1, int(round(float(sr) * (max(float(max_shift_ms), 0.0) / 1000.0))))
    n = int(min(tgt_frames.shape[0], ref_frames.shape[0]))
    ref_mono = _mono_mix(ref_frames[:n])
    tgt_mono = _mono_mix(tgt_frames[:n])
    candidates: list[int] = []
    for estimator in (_gcc_phat_lag, _time_xcorr_lag):
        cand, _score = estimator(ref_mono, tgt_mono, max_lag)
        candidates.append(int(np.clip(cand, -max_lag, max_lag)))
    lag = 0
    pearson = 0.0
    for cand in candidates:
        score = abs(_pearson_at_lag(ref_mono, tgt_mono, cand))
        if score > pearson:
            pearson = score
            lag = cand
    peak = float(pearson)

    if pearson < float(min_peak) or lag == 0:
        aligned = _restore_shape(tgt_frames.copy(), tgt_1d, target.dtype)
        return PhaseAlignResult(aligned=aligned, lag_samples=0, peak=peak, applied=False)

    shifted = _shift_frames(tgt_frames, lag)
    aligned = _restore_shape(shifted, tgt_1d, target.dtype)
    return PhaseAlignResult(aligned=aligned, lag_samples=int(lag), peak=peak, applied=True)


def align_stem_group(
    stems: list[np.ndarray],
    sr: int = 44100,
    reference_index: int = 0,
    max_shift_ms: float = DEFAULT_MAX_SHIFT_MS,
    min_peak: float = DEFAULT_MIN_PEAK,
) -> tuple[list[np.ndarray], list[int]]:
    """Align every stem to ``stems[reference_index]`` with one shared integer lag each."""
    if not stems:
        return [], []
    if reference_index < 0 or reference_index >= len(stems):
        raise IndexError(f"reference_index {reference_index} out of range for {len(stems)} stems")
    reference = stems[reference_index]
    aligned: list[np.ndarray] = []
    lags: list[int] = []
    for i, stem in enumerate(stems):
        if i == reference_index:
            aligned.append(np.asarray(stem).copy())
            lags.append(0)
            continue
        result = align_to_reference(
            stem,
            reference,
            sr=sr,
            max_shift_ms=max_shift_ms,
            min_peak=min_peak,
        )
        aligned.append(result.aligned)
        lags.append(result.lag_samples)
    return aligned, lags
