"""ITU-R BS.1770-4 / EBU R128 loudness (K-weight, dual-gate, short-term).

Library API is ``measure_loudness(ndarray, sr)``. The optional CLI (``-i wav``)
prints the same fields as JSON. Standard 48 kHz K-weighting biquads are kept as
named constants and applied via SOS; other rates are resampled to 48 kHz so
those coefficients are not used off-rate.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from math import gcd
from typing import Any

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.signal import resample_poly, sosfilt, tf2sos

# ITU-R BS.1770-4 Annex 1 — published 48 kHz discrete coefficients.
K_WEIGHT_SR = 48000
# Stage 1: high-frequency shelf (pre-filter).
K_SHELF_B = np.array([1.53512485958697, -2.69169618940638, 1.19839281085285], dtype=np.float64)
K_SHELF_A = np.array([1.0, -1.69065929318241, 0.73248077421585], dtype=np.float64)
# Stage 2: RLB high-pass.
K_HP_B = np.array([1.0, -2.0, 1.0], dtype=np.float64)
K_HP_A = np.array([1.0, -1.99004745483398, 0.99007225036621], dtype=np.float64)

K_OFFSET = -0.691
ABS_GATE_LKFS = -70.0
REL_GATE_LU = 10.0
MOMENTARY_SEC = 0.400
SHORT_TERM_SEC = 3.0
BLOCK_OVERLAP = 0.75
EBU_TARGET_LUFS = -14.0
SILENCE_LUFS = -70.0


@dataclass(frozen=True)
class LoudnessReport:
    integrated_lufs: float
    short_term_max: float
    momentary_max: float
    target_gap_db: float


def _finite(value: float, fallback: float = SILENCE_LUFS) -> float:
    number = float(value)
    if not np.isfinite(number):
        return fallback
    return number


def _silence_report(target_lufs: float = EBU_TARGET_LUFS) -> LoudnessReport:
    return LoudnessReport(
        integrated_lufs=SILENCE_LUFS,
        short_term_max=SILENCE_LUFS,
        momentary_max=SILENCE_LUFS,
        target_gap_db=_finite(target_lufs - SILENCE_LUFS, 0.0),
    )


def _normalize_audio(audio: np.ndarray) -> np.ndarray:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 0:
        data = data.reshape(1)
    if data.ndim == 1:
        data = data[:, np.newaxis]
    if data.ndim > 2:
        data = data.reshape(data.shape[0], -1)
    if not np.isfinite(data).all():
        data = np.nan_to_num(data, nan=0.0, posinf=0.0, neginf=0.0)
    return data


def bs1770_channel_weights(num_channels: int) -> np.ndarray:
    """BS.1770-4 channel gains. LFE is ignored when a 5.1/7.1 layout is assumed."""
    n = max(1, int(num_channels))
    weights = np.ones(n, dtype=np.float64)
    if n == 1:
        return weights
    if n == 2:
        return weights
    if n == 3:
        return weights  # L R C
    if n == 4:
        weights[2:] = 1.41  # L R Ls Rs
        return weights
    if n == 5:
        weights[3:] = 1.41  # L R C Ls Rs
        return weights
    # 5.1 / 7.1 ITU order: L R C LFE Ls Rs [Lb Rb]
    weights[3] = 0.0
    if n >= 5:
        weights[4:] = 1.41
    return weights


def _resample_to_k_weight_sr(data: np.ndarray, sr: int) -> tuple[np.ndarray, int]:
    rate = int(sr)
    if rate <= 0:
        raise ValueError("sample rate must be positive")
    if rate == K_WEIGHT_SR:
        return data, rate
    divisor = gcd(rate, K_WEIGHT_SR)
    up = K_WEIGHT_SR // divisor
    down = rate // divisor
    return resample_poly(data, up, down, axis=0).astype(np.float64, copy=False), K_WEIGHT_SR


def apply_k_weighting(audio: np.ndarray, sr: int) -> tuple[np.ndarray, int]:
    """Apply both published 48 kHz stages. Other rates are resampled first."""
    data = _normalize_audio(audio)
    data, rate = _resample_to_k_weight_sr(data, sr)
    sos = np.vstack(
        (
            tf2sos(K_SHELF_B, K_SHELF_A),
            tf2sos(K_HP_B, K_HP_A),
        )
    )
    return sosfilt(sos, data, axis=0), rate


def _ms_to_lkfs(mean_square: np.ndarray | float) -> np.ndarray:
    z = np.asarray(mean_square, dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        return K_OFFSET + 10.0 * np.log10(np.maximum(z, 1e-15))


def _strided_mean_square(weighted: np.ndarray, window: int, hop: int) -> np.ndarray:
    """Per-block, per-channel mean-square using sliding windows (no Python hop loop)."""
    if window <= 0:
        raise ValueError("window must be positive")
    hop = max(1, int(hop))
    if weighted.shape[0] < window:
        return np.mean(weighted * weighted, axis=0, keepdims=True)
    views = sliding_window_view(weighted, window, axis=0)[::hop]
    return np.mean(views * views, axis=-1)


def _weighted_block_z(weighted: np.ndarray, weights: np.ndarray, window_sec: float, hop_sec: float, sr: int) -> np.ndarray:
    window = max(1, int(round(window_sec * sr)))
    hop = max(1, int(round(hop_sec * sr)))
    channel_ms = _strided_mean_square(weighted, window, hop)
    return channel_ms @ weights[: channel_ms.shape[1]]


def _max_lufs(block_z: np.ndarray) -> float:
    if block_z.size == 0:
        return SILENCE_LUFS
    peak = _finite(float(np.max(_ms_to_lkfs(block_z))), SILENCE_LUFS)
    if peak <= ABS_GATE_LKFS:
        return SILENCE_LUFS
    return peak


def _gated_integrated(block_z: np.ndarray) -> float:
    """Absolute −70 LKFS, then relative −10 LU on remaining *linear* mean-square."""
    if block_z.size == 0:
        return SILENCE_LUFS
    block_lkfs = _ms_to_lkfs(block_z)
    abs_mask = block_lkfs > ABS_GATE_LKFS
    if not np.any(abs_mask):
        return SILENCE_LUFS
    abs_z = block_z[abs_mask]
    abs_mean_z = float(np.mean(abs_z))
    if abs_mean_z <= 0.0:
        return SILENCE_LUFS
    relative_lkfs = float(_ms_to_lkfs(abs_mean_z)) - REL_GATE_LU
    rel_mask = abs_mask & (block_lkfs > relative_lkfs)
    gated_z = block_z[rel_mask]
    if gated_z.size == 0:
        gated_z = abs_z
    return _finite(float(_ms_to_lkfs(float(np.mean(gated_z)))), SILENCE_LUFS)


def measure_loudness(
    audio: np.ndarray,
    sr: int,
    target_lufs: float = EBU_TARGET_LUFS,
) -> LoudnessReport:
    """Return integrated, short-term max, momentary max, and gap vs EBU −14 LUFS."""
    data = _normalize_audio(audio)
    if data.size == 0 or data.shape[0] == 0:
        return _silence_report(target_lufs)

    weighted, rate = apply_k_weighting(data, sr)
    weights = bs1770_channel_weights(weighted.shape[1])
    hop_sec = MOMENTARY_SEC * (1.0 - BLOCK_OVERLAP)

    momentary_z = _weighted_block_z(weighted, weights, MOMENTARY_SEC, hop_sec, rate)
    short_term_z = _weighted_block_z(weighted, weights, SHORT_TERM_SEC, hop_sec, rate)
    integrated = _gated_integrated(momentary_z)
    report = LoudnessReport(
        integrated_lufs=round(integrated, 3),
        short_term_max=round(_max_lufs(short_term_z), 3),
        momentary_max=round(_max_lufs(momentary_z), 3),
        target_gap_db=round(_finite(target_lufs - integrated, 0.0), 3),
    )
    return report


def measure_loudness_dict(audio: np.ndarray, sr: int, target_lufs: float = EBU_TARGET_LUFS) -> dict[str, float]:
    return asdict(measure_loudness(audio, sr, target_lufs=target_lufs))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ITU-R BS.1770-4 / EBU R128 loudness meter")
    parser.add_argument("-i", "--input", required=True, help="WAV (or any soundfile-readable) path")
    parser.add_argument("--target", type=float, default=EBU_TARGET_LUFS)
    args = parser.parse_args(argv)
    import soundfile as sf

    data, sr = sf.read(args.input, always_2d=False)
    payload: dict[str, Any] = measure_loudness_dict(np.asarray(data), int(sr), target_lufs=args.target)
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
