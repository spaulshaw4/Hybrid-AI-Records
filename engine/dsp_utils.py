"""Lightweight DSP helpers for the relational mixer (NumPy / Torch).

Parametric EQ building blocks, envelope followers, and metering. Prefers
``torchaudio.functional.lfilter`` (SciPy DLLs are often blocked by Windows
application control). Falls back to a NumPy IIR and ``np.convolve``.
"""
from __future__ import annotations

from typing import Literal

import numpy as np

EPS = 1e-12

try:
    import torch
    from torchaudio.functional import lfilter as _torch_lfilter

    _HAS_TORCH = True
except Exception:  # pragma: no cover - optional accel
    torch = None  # type: ignore[assignment]
    _torch_lfilter = None  # type: ignore[assignment]
    _HAS_TORCH = False


def as_frames(audio: np.ndarray) -> tuple[np.ndarray, bool]:
    """Return ``(n, ch)`` float64 frames and whether the input was 1-D."""
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return data[:, np.newaxis], True
    if data.ndim == 2:
        return data, False
    raise ValueError(f"audio must be 1-D or 2-D, got shape {data.shape}")


def restore_shape(frames: np.ndarray, was_1d: bool, dtype: np.dtype | None = None) -> np.ndarray:
    out = frames[:, 0] if was_1d else frames
    if dtype is not None:
        return out.astype(dtype, copy=False)
    return out


def align_length(audio: np.ndarray, n: int) -> np.ndarray:
    frames, was_1d = as_frames(audio)
    if frames.shape[0] == n:
        return restore_shape(frames, was_1d)
    if frames.shape[0] > n:
        frames = frames[:n]
    else:
        frames = np.pad(frames, ((0, n - frames.shape[0]), (0, 0)), mode="constant")
    return restore_shape(frames, was_1d)


def to_mono(audio: np.ndarray) -> np.ndarray:
    frames, was_1d = as_frames(audio)
    if was_1d or frames.shape[1] == 1:
        return frames[:, 0].copy()
    return np.mean(frames, axis=1)


def time_const_coeff(sr: int, ms: float) -> float:
    """One-pole coefficient for an exponential time constant in milliseconds."""
    ms = max(0.0, float(ms))
    if ms <= 0.0 or sr <= 0:
        return 0.0
    return float(np.exp(-1.0 / (float(sr) * (ms / 1000.0))))


def lfilter_ba(b: np.ndarray, a: np.ndarray, x: np.ndarray) -> np.ndarray:
    """Direct-form IIR filter. Torch when available; NumPy fallback otherwise."""
    b = np.asarray(b, dtype=np.float64).ravel()
    a = np.asarray(a, dtype=np.float64).ravel()
    x = np.asarray(x, dtype=np.float64).ravel()
    if a.size == 0 or abs(a[0]) < EPS:
        raise ValueError("a[0] must be non-zero")
    if abs(a[0] - 1.0) > 1e-15:
        b = b / a[0]
        a = a / a[0]
    if _HAS_TORCH and _torch_lfilter is not None and x.size > 0:
        # torchaudio expects (batch, channels, time); coeffs length-matched.
        max_order = max(b.size, a.size)
        b_pad = np.zeros(max_order, dtype=np.float64)
        a_pad = np.zeros(max_order, dtype=np.float64)
        b_pad[: b.size] = b
        a_pad[: a.size] = a
        waveform = torch.as_tensor(x, dtype=torch.float64).view(1, 1, -1)
        b_t = torch.as_tensor(b_pad, dtype=torch.float64)
        a_t = torch.as_tensor(a_pad, dtype=torch.float64)
        out = _torch_lfilter(waveform, a_t, b_t, clamp=False)
        return out.view(-1).detach().cpu().numpy()
    # Slow but correct pure-NumPy path (short signals / CI without torchaudio).
    n = x.size
    y = np.zeros(n, dtype=np.float64)
    nb = b.size
    na = a.size
    for i in range(n):
        acc = 0.0
        for j in range(nb):
            if i - j >= 0:
                acc += b[j] * x[i - j]
        for j in range(1, na):
            if i - j >= 0:
                acc -= a[j] * y[i - j]
        y[i] = acc
    return y


def one_pole(signal: np.ndarray, coeff: float) -> np.ndarray:
    coeff = float(np.clip(coeff, 0.0, 1.0 - 1e-12))
    return lfilter_ba(
        np.array([1.0 - coeff], dtype=np.float64),
        np.array([1.0, -coeff], dtype=np.float64),
        np.asarray(signal, dtype=np.float64),
    )


# Keeps rc**-block_len inside float64 range for the scaled running max.
_MAX_BLOCK_LOG_SCALE = 40.0


def _decaying_running_max(values: np.ndarray, rc: float, init: float) -> np.ndarray:
    """``m[i] = max(rc * m[i-1], values[i])`` with ``m[-1] = init``, vectorised.

    Blockwise ``rc**t * cummax(values * rc**-t)``; blocks keep ``rc**-t`` finite.
    (Mirrors ``dsp.true_peak_limiter._decaying_running_min``; this module must
    not import the ``dsp`` package, whose ``__init__`` pulls in SciPy.)
    """
    x = np.asarray(values, dtype=np.float64)
    out = np.empty_like(x)
    if x.size == 0:
        return out
    decay = -float(np.log(rc))
    block = x.size if decay <= 0.0 else max(1, int(_MAX_BLOCK_LOG_SCALE / decay))
    prev = float(init)
    for start in range(0, x.size, block):
        seg = x[start : start + block]
        t = np.arange(seg.size, dtype=np.float64)
        grow = np.exp(decay * t)
        scaled = np.maximum.accumulate(seg * grow)
        np.maximum(scaled, rc * prev, out=scaled)
        out[start : start + seg.size] = scaled / grow
        prev = float(out[start + seg.size - 1])
    return out


def peak_hold(signal: np.ndarray, release_coeff: float) -> np.ndarray:
    """Causal peak hold: instant attack, one-pole release toward ``|x|``.

    Exact vectorised form of ``y[i] = |x[i]|`` if ``|x[i]| >= y[i-1]`` else
    ``rc * y[i-1] + (1 - rc) * |x[i]|`` (``y[-1] = 0``). Each step is ``max``
    of an increasing affine map, so ``y = L + M``: ``L`` is the zero-state
    one-pole of ``|x|`` and ``M`` a decaying running max of ``|x| - L``.
    """
    x = np.abs(np.asarray(signal, dtype=np.float64))
    rc = float(np.clip(release_coeff, 0.0, 1.0))
    if x.size == 0 or rc <= 0.0:
        return x.copy()
    if rc >= 1.0:
        return np.maximum.accumulate(x)
    smoothed = lfilter_ba(
        np.array([1.0 - rc], dtype=np.float64),
        np.array([1.0, -rc], dtype=np.float64),
        x.reshape(-1),
    ).reshape(x.shape)
    return smoothed + _decaying_running_max(x - smoothed, rc, init=0.0)


def envelope_follower(
    signal: np.ndarray,
    sr: int,
    *,
    attack_ms: float = 5.0,
    release_ms: float = 80.0,
) -> np.ndarray:
    """Peak-hold envelope with attack smoothing. Returns mono gain in [0, inf)."""
    mono = np.abs(to_mono(signal))
    if mono.size == 0:
        return mono
    held = peak_hold(mono, time_const_coeff(sr, release_ms))
    attack_c = time_const_coeff(sr, attack_ms)
    if attack_c <= 1e-9:
        return held
    return one_pole(held, attack_c)


def _nyquist_safe(sr: int, hz: float) -> float:
    nyq = float(sr) / 2.0
    return float(np.clip(hz, 20.0, max(21.0, nyq * 0.49)))


def _butter_biquad(
    sr: int,
    cutoff_hz: float,
    btype: Literal["lowpass", "highpass"],
) -> tuple[np.ndarray, np.ndarray]:
    """2nd-order Butterworth LP/HP via bilinear transform (RBJ cookbook)."""
    w0 = 2.0 * np.pi * _nyquist_safe(sr, cutoff_hz) / float(sr)
    cos_w0 = np.cos(w0)
    sin_w0 = np.sin(w0)
    alpha = sin_w0 / (2.0 * np.sqrt(0.5))  # Q = 1/sqrt(2) for Butterworth
    if btype == "lowpass":
        b0 = (1.0 - cos_w0) / 2.0
        b1 = 1.0 - cos_w0
        b2 = (1.0 - cos_w0) / 2.0
    else:
        b0 = (1.0 + cos_w0) / 2.0
        b1 = -(1.0 + cos_w0)
        b2 = (1.0 + cos_w0) / 2.0
    a0 = 1.0 + alpha
    a1 = -2.0 * cos_w0
    a2 = 1.0 - alpha
    b = np.array([b0 / a0, b1 / a0, b2 / a0], dtype=np.float64)
    a = np.array([1.0, a1 / a0, a2 / a0], dtype=np.float64)
    return b, a


def _cascade_ba(sections: list[tuple[np.ndarray, np.ndarray]], x: np.ndarray) -> np.ndarray:
    y = np.asarray(x, dtype=np.float64)
    for b, a in sections:
        y = lfilter_ba(b, a, y)
    return y


def filter_ba(audio: np.ndarray, sections: list[tuple[np.ndarray, np.ndarray]]) -> np.ndarray:
    frames, was_1d = as_frames(audio)
    if frames.size == 0:
        return restore_shape(frames, was_1d)
    out = np.empty_like(frames)
    for ch in range(frames.shape[1]):
        out[:, ch] = _cascade_ba(sections, frames[:, ch])
    return restore_shape(out, was_1d, frames.dtype)


def lowpass(audio: np.ndarray, sr: int, cutoff_hz: float, order: int = 2) -> np.ndarray:
    """Butterworth-style low-pass (cascaded 2nd-order stages)."""
    stages = max(1, int(order) // 2)
    sections = [_butter_biquad(sr, cutoff_hz, "lowpass") for _ in range(stages)]
    return filter_ba(audio, sections)


def highpass(audio: np.ndarray, sr: int, cutoff_hz: float, order: int = 2) -> np.ndarray:
    """Butterworth-style high-pass (cascaded 2nd-order stages)."""
    stages = max(1, int(order) // 2)
    sections = [_butter_biquad(sr, cutoff_hz, "highpass") for _ in range(stages)]
    return filter_ba(audio, sections)


def bandpass(
    audio: np.ndarray,
    sr: int,
    low_hz: float,
    high_hz: float,
    order: int = 2,
) -> np.ndarray:
    """Band-pass as cascaded HPF + LPF."""
    return lowpass(highpass(audio, sr, low_hz, order), sr, high_hz, order)


def peaking_eq(
    audio: np.ndarray,
    sr: int,
    freq_hz: float,
    gain_db: float,
    q: float = 1.0,
) -> np.ndarray:
    """Single peaking (bell) EQ via RBJ biquad coefficients."""
    frames, was_1d = as_frames(audio)
    if frames.size == 0 or abs(gain_db) < 1e-6:
        return restore_shape(frames, was_1d)

    a = 10.0 ** (float(gain_db) / 40.0)
    w0 = 2.0 * np.pi * _nyquist_safe(sr, freq_hz) / float(sr)
    alpha = np.sin(w0) / (2.0 * max(0.1, float(q)))
    cos_w0 = np.cos(w0)

    b0 = 1.0 + alpha * a
    b1 = -2.0 * cos_w0
    b2 = 1.0 - alpha * a
    a0 = 1.0 + alpha / a
    a1 = -2.0 * cos_w0
    a2 = 1.0 - alpha / a

    b = np.array([b0 / a0, b1 / a0, b2 / a0], dtype=np.float64)
    a_coeff = np.array([1.0, a1 / a0, a2 / a0], dtype=np.float64)

    out = np.empty_like(frames)
    for ch in range(frames.shape[1]):
        out[:, ch] = lfilter_ba(b, a_coeff, frames[:, ch])
    return restore_shape(out, was_1d, frames.dtype)


def split_crossover(audio: np.ndarray, sr: int, cutoff_hz: float) -> tuple[np.ndarray, np.ndarray]:
    """Complementary low / high split at ``cutoff_hz``."""
    low = lowpass(audio, sr, cutoff_hz)
    frames, was_1d = as_frames(audio)
    low_f, _ = as_frames(align_length(low, frames.shape[0]))
    high = restore_shape(frames - low_f, was_1d)
    return restore_shape(low_f, was_1d), high


def split_mid_band(
    audio: np.ndarray,
    sr: int,
    low_hz: float = 1000.0,
    high_hz: float = 3500.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return ``(low, mid, high)`` bands for vocal-pocket processing."""
    frames, was_1d = as_frames(audio)
    n = frames.shape[0]
    low = align_length(lowpass(audio, sr, low_hz), n)
    high = align_length(highpass(audio, sr, high_hz), n)
    mid = restore_shape(frames - as_frames(low)[0] - as_frames(high)[0], was_1d)
    return low, mid, high


def db_to_lin(db: float) -> float:
    return float(10.0 ** (float(db) / 20.0))


def lin_to_db(lin: float) -> float:
    return float(20.0 * np.log10(max(EPS, float(lin))))


def rms_dbfs(audio: np.ndarray) -> float:
    frames, _ = as_frames(audio)
    if frames.size == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(frames * frames) + EPS))
    return lin_to_db(rms)


def peak_dbfs(audio: np.ndarray) -> float:
    frames, _ = as_frames(audio)
    if frames.size == 0:
        return -120.0
    peak = float(np.max(np.abs(frames)))
    return lin_to_db(peak) if peak > 0 else -120.0


def synthesize_impulse(
    sr: int,
    *,
    decay_sec: float = 1.2,
    high_damp: float = 0.35,
) -> np.ndarray:
    """Synthetic mono IR (noise * exponential decay) for the coherence bus."""
    n = max(8, int(float(sr) * max(0.05, float(decay_sec))))
    t = np.arange(n, dtype=np.float64) / float(sr)
    noise = np.random.default_rng(0).standard_normal(n)
    env = np.exp(-t / max(1e-3, float(decay_sec)))
    ir = noise * env
    ir = lowpass(ir, sr, 8000.0 * (1.0 - 0.5 * float(np.clip(high_damp, 0.0, 1.0))))
    peak = float(np.max(np.abs(ir))) + EPS
    return (ir / peak).astype(np.float64)


def _fft_convolve(signal: np.ndarray, ir: np.ndarray) -> np.ndarray:
    """Same-length wet signal via FFT (Torch when available)."""
    n = signal.size
    m = ir.size
    n_fft = 1
    while n_fft < n + m - 1:
        n_fft <<= 1
    if _HAS_TORCH:
        sig_t = torch.as_tensor(signal, dtype=torch.float64)
        ir_t = torch.as_tensor(ir, dtype=torch.float64)
        wet = torch.fft.irfft(torch.fft.rfft(sig_t, n=n_fft) * torch.fft.rfft(ir_t, n=n_fft), n=n_fft)
        return wet[:n].detach().cpu().numpy()
    return np.convolve(signal, ir, mode="full")[:n]


def convolve_reverb(
    audio: np.ndarray,
    ir: np.ndarray,
    *,
    wet: float = 0.2,
) -> np.ndarray:
    """FFT convolution reverb; returns same length as input (wet/dry mix).

    The wet path is RMS-matched to the dry signal before blending so the
    coherence bus cannot inflate bus levels past the staged targets.
    """
    frames, was_1d = as_frames(audio)
    if frames.size == 0 or wet <= 0.0:
        return restore_shape(frames, was_1d)
    ir_m = to_mono(ir)
    wet_amt = float(np.clip(wet, 0.0, 1.0))
    out = np.empty_like(frames)
    for ch in range(frames.shape[1]):
        dry = frames[:, ch]
        wet_full = _fft_convolve(dry, ir_m)
        dry_rms = float(np.sqrt(np.mean(dry * dry) + EPS))
        wet_rms = float(np.sqrt(np.mean(wet_full * wet_full) + EPS))
        if wet_rms > EPS:
            wet_full = wet_full * (dry_rms / wet_rms)
        out[:, ch] = dry * (1.0 - wet_amt) + wet_full * wet_amt
    return restore_shape(out, was_1d, frames.dtype)
