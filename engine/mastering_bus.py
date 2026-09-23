"""Module 5 — Broadcast-grade mastering bus.

Mono sub-bass, true-peak brickwall, ITU-R BS.1770 LUFS dial-in, and gentle
high-side stereo polish for delivery masters.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from engine.dsp_utils import highpass, split_crossover
from engine.song_evaluator import measure_integrated_lufs, measure_true_peak

DEFAULT_LUFS = -14.0
DEFAULT_LUFS_TOLERANCE = 0.5
DEFAULT_CEILING_DBTP = -1.0
MONO_SUB_HZ = 90.0
SIDE_AIR_HZ = 5000.0
SIDE_WIDTH_MIN = 1.05
SIDE_WIDTH_MAX = 1.10
MONO_SUB_ORDER = 4  # 24 dB/oct Butterworth on the Side channel
LIMITER_LOOKAHEAD_MS = 5.0
LIMITER_RELEASE_MS = 50.0
# Max drive above the peak-safe gain the LUFS loop may push into the limiter.
MAX_LIMITER_PUSH_DB = 8.5
LUFS_TARGET = DEFAULT_LUFS
LUFS_TOLERANCE = DEFAULT_LUFS_TOLERANCE


class LoudnessComplianceError(RuntimeError):
    """Master missed the integrated-loudness window; it must not be delivered."""

    def __init__(self, final_lufs: float, target_lufs: float, tolerance: float, push_capped: bool) -> None:
        self.final_lufs = float(final_lufs)
        self.target_lufs = float(target_lufs)
        self.tolerance = float(tolerance)
        self.push_capped = bool(push_capped)
        cap_note = f", max push {MAX_LIMITER_PUSH_DB} dB hit" if push_capped else ""
        super().__init__(
            f"Master failed broadcast loudness compliance: reached {self.final_lufs:.2f} LUFS "
            f"(target {self.target_lufs} ±{self.tolerance} LUFS{cap_note})"
        )


def assert_loudness_compliance(report: "MasteringReport", *, tolerance: float | None = None) -> None:
    """Raise ``LoudnessComplianceError`` unless ``report`` is inside the LUFS window."""
    tol = float(LUFS_TOLERANCE if tolerance is None else tolerance)
    lufs = float(report.integrated_lufs)
    if not np.isfinite(lufs) or abs(lufs - float(report.target_lufs)) > tol:
        raise LoudnessComplianceError(
            lufs,
            report.target_lufs,
            tol,
            bool((report.details or {}).get("limiter_push_capped")),
        )


@dataclass
class MasteringReport:
    integrated_lufs: float
    true_peak_dbtp: float
    target_lufs: float
    ceiling_dbtp: float
    mono_sub_hz: float
    side_width: float
    phase_correlation: float
    gain_db: float = 0.0
    details: dict[str, Any] = field(default_factory=dict)


def _as_stereo(audio: np.ndarray) -> np.ndarray:
    data = np.asarray(audio, dtype=np.float64)
    if data.ndim == 1:
        return np.column_stack((data, data))
    if data.shape[1] == 1:
        return np.repeat(data, 2, axis=1)
    return data[:, :2]


def phase_correlation(audio: np.ndarray) -> float:
    """Pearson correlation of L/R (−1..+1). Positive = coherent."""
    stereo = _as_stereo(audio)
    left = stereo[:, 0]
    right = stereo[:, 1]
    if left.size < 2:
        return 1.0
    left_c = left - np.mean(left)
    right_c = right - np.mean(right)
    denom = float(np.sqrt(np.sum(left_c * left_c) * np.sum(right_c * right_c)))
    if denom < 1e-18:
        return 1.0
    return float(np.clip(np.sum(left_c * right_c) / denom, -1.0, 1.0))


def mono_sub_bass(audio: np.ndarray, sr: int, cutoff_hz: float = MONO_SUB_HZ) -> np.ndarray:
    """Collapse stereo information below ``cutoff_hz`` to pure mono.

    Mid/Side encode, high-pass the Side at ``cutoff_hz`` (4th-order, 24 dB/oct)
    so the sub foundation is mid-only (phase-coherent on club/subwoofer
    systems), then decode.
    """
    stereo = _as_stereo(audio)
    mid = 0.5 * (stereo[:, 0] + stereo[:, 1])
    side = 0.5 * (stereo[:, 0] - stereo[:, 1])
    side_hp = highpass(side, sr, cutoff_hz, order=MONO_SUB_ORDER)
    return np.column_stack((mid + side_hp, mid - side_hp))


def stereo_air_polish(
    audio: np.ndarray,
    sr: int,
    *,
    side_hz: float = SIDE_AIR_HZ,
    width: float = 1.08,
) -> np.ndarray:
    """Boost high-frequency side channel by ``width`` (1.05–1.10) for stereo air."""
    stereo = _as_stereo(audio)
    width = float(np.clip(width, SIDE_WIDTH_MIN, SIDE_WIDTH_MAX))
    mid = 0.5 * (stereo[:, 0] + stereo[:, 1])
    side = 0.5 * (stereo[:, 0] - stereo[:, 1])
    side_low, side_high = split_crossover(side, sr, side_hz)
    # Only widen the air band; keep mid and low-side intact for phase.
    side_out = np.asarray(side_low) + np.asarray(side_high) * width
    left = mid + side_out
    right = mid - side_out
    return np.column_stack((left, right))


def normalize_lufs(
    audio: np.ndarray,
    sr: int,
    *,
    target_lufs: float = DEFAULT_LUFS,
    tolerance: float = DEFAULT_LUFS_TOLERANCE,
    ceiling_dbtp: float = DEFAULT_CEILING_DBTP,
) -> tuple[np.ndarray, float]:
    """Dial integrated loudness to target (±tolerance) without iterative pumping."""
    current = measure_integrated_lufs(audio, sr)
    if not np.isfinite(current) or current <= -70.0:
        return np.asarray(audio, dtype=np.float64), 0.0
    gap = float(target_lufs) - float(current)
    # Only nudge when outside the allowed window.
    if abs(gap) <= float(tolerance):
        return np.asarray(audio, dtype=np.float64), 0.0
    gain_db = float(gap)
    gained = np.asarray(audio, dtype=np.float64) * (10.0 ** (gain_db / 20.0))
    # Soft safety vs ceiling before the dedicated limiter stage.
    peak = measure_true_peak(gained, sr)
    if peak > ceiling_dbtp:
        trim = ceiling_dbtp - peak
        gained = gained * (10.0 ** (trim / 20.0))
        gain_db += trim
    return gained, gain_db


class MasteringBus:
    """Broadcast delivery chain for the conducted master mix."""

    def __init__(
        self,
        *,
        target_lufs: float = DEFAULT_LUFS,
        lufs_tolerance: float = DEFAULT_LUFS_TOLERANCE,
        ceiling_dbtp: float = DEFAULT_CEILING_DBTP,
        mono_sub_hz: float = MONO_SUB_HZ,
        side_width: float = 1.08,
        side_air_hz: float = SIDE_AIR_HZ,
        enforce_compliance: bool = False,
    ) -> None:
        """``enforce_compliance=True`` makes ``process`` raise
        ``LoudnessComplianceError`` when the master misses the LUFS window
        (delivery paths use this so a non-compliant master never ships).
        """
        self.enforce_compliance = bool(enforce_compliance)
        self.target_lufs = float(target_lufs)
        self.lufs_tolerance = float(lufs_tolerance)
        self.ceiling_dbtp = float(ceiling_dbtp)
        self.mono_sub_hz = float(mono_sub_hz)
        self.side_width = float(np.clip(side_width, SIDE_WIDTH_MIN, SIDE_WIDTH_MAX))
        self.side_air_hz = float(side_air_hz)

    def process(self, audio: np.ndarray, sr: int) -> tuple[np.ndarray, MasteringReport]:
        from dsp.true_peak_limiter import (
            _forward_window_max,
            lookahead_samples_for,
            measure_true_peak_dbtp,
            oversampled_peak_envelope,
            peak_limiter_gain,
        )

        sr = int(sr)
        stereo = mono_sub_bass(audio, sr, self.mono_sub_hz)
        stereo = stereo_air_polish(stereo, sr, side_hz=self.side_air_hz, width=self.side_width)
        n = stereo.shape[0]

        # One 4x analysis of the pre-limiter signal. The detector is linear in
        # drive gain, so every LUFS iteration re-renders the limiter from the
        # original signal (no cascaded re-limiting, no extra resampling).
        envelope = oversampled_peak_envelope(stereo)
        peak_in = float(np.max(envelope)) if envelope.size else 0.0
        tp_in_db = float(20.0 * np.log10(peak_in + 1e-12))
        window_max = _forward_window_max(envelope, lookahead_samples_for(sr, LIMITER_LOOKAHEAD_MS))
        del envelope
        # Drive that puts the unlimited true peak exactly on the ceiling;
        # anything above it is limiter push (capped at MAX_LIMITER_PUSH_DB).
        safe_db = self.ceiling_dbtp - tp_in_db
        push_limit_db = safe_db + MAX_LIMITER_PUSH_DB
        push_capped = False

        def capped(drive: float) -> float:
            nonlocal push_capped
            if drive > push_limit_db:
                push_capped = True
                return push_limit_db
            return drive

        def render(drive: float) -> np.ndarray:
            gain = 10.0 ** (drive / 20.0)
            curve = peak_limiter_gain(
                window_max,
                n,
                sr=sr,
                ceiling_dbtp=self.ceiling_dbtp,
                lookahead_ms=LIMITER_LOOKAHEAD_MS,
                release_ms=LIMITER_RELEASE_MS,
                input_gain=gain,
            )
            return stereo * (gain * curve)[:, np.newaxis]

        lufs_in = measure_integrated_lufs(stereo, sr)
        if not np.isfinite(lufs_in) or lufs_in <= -70.0:
            drive_db = min(0.0, safe_db)
        else:
            gap = self.target_lufs - float(lufs_in)
            drive_db = 0.0 if abs(gap) <= self.lufs_tolerance else gap
        drive_db = capped(drive_db)
        limited = render(drive_db)
        lufs = measure_integrated_lufs(limited, sr)
        # Limiting eats loudness on dense material, so iterate the drive until
        # LUFS lands in the window (or the push cap / convergence stops it).
        for _ in range(4):
            if not np.isfinite(lufs):
                break
            gap = self.target_lufs - float(lufs)
            if abs(gap) <= self.lufs_tolerance:
                break
            next_drive = capped(drive_db + gap)
            if abs(next_drive - drive_db) < 0.05:
                break
            drive_db = next_drive
            limited = render(drive_db)
            lufs = measure_integrated_lufs(limited, sr)

        # Final compliance on the actual output: 4x true peak, static trim.
        dbtp = float(measure_true_peak_dbtp(limited))
        gain_db = drive_db
        if dbtp > self.ceiling_dbtp:
            trim_db = self.ceiling_dbtp - dbtp
            limited = limited * (10.0 ** (trim_db / 20.0))
            gain_db += trim_db
            dbtp = self.ceiling_dbtp
            # Integrated loudness scales 1:1 with a static gain.
            lufs = float(lufs) + trim_db
        pushed_db = max(0.0, drive_db - safe_db)
        corr = phase_correlation(limited)
        report = MasteringReport(
            integrated_lufs=round(float(lufs), 3),
            true_peak_dbtp=round(dbtp, 3),
            target_lufs=self.target_lufs,
            ceiling_dbtp=self.ceiling_dbtp,
            mono_sub_hz=self.mono_sub_hz,
            side_width=self.side_width,
            phase_correlation=round(corr, 4),
            gain_db=round(gain_db, 3),
            details={
                "within_lufs_window": abs(float(lufs) - self.target_lufs)
                <= self.lufs_tolerance,
                "under_ceiling": dbtp <= self.ceiling_dbtp + 0.05,
                "limiter_push_db": round(pushed_db, 3),
                "limiter_push_capped": push_capped,
            },
        )
        if self.enforce_compliance:
            assert_loudness_compliance(report, tolerance=self.lufs_tolerance)
        return np.asarray(limited, dtype=np.float64), report
