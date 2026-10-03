"""Tests for the mono fold-down guard on the finished mix."""
from __future__ import annotations

import os
import sys

import numpy as np

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.conductor_matrix import (  # noqa: E402
    MONO_CORRELATION_FLOOR,
    enforce_mono_compatibility,
    stereo_correlation,
)

SR = 22050


def _noise(n: int, seed: int) -> np.ndarray:
    return np.random.default_rng(seed).normal(0.0, 0.2, n)


def _wide_mix(n: int = SR) -> np.ndarray:
    """Mostly decorrelated stereo: shared mid plus independent per-channel noise."""
    mid = _noise(n, 1) * 0.3
    return np.column_stack((mid + _noise(n, 2), mid + _noise(n, 3)))


def test_below_floor_is_pulled_up_to_the_floor():
    mix = _wide_mix()
    assert stereo_correlation(mix) < MONO_CORRELATION_FLOOR
    out, before, after = enforce_mono_compatibility(mix)
    assert before < MONO_CORRELATION_FLOOR
    assert after >= MONO_CORRELATION_FLOOR - 1e-6
    assert stereo_correlation(out) >= MONO_CORRELATION_FLOOR - 1e-6
    assert out.shape == mix.shape


def test_mix_above_floor_is_returned_untouched():
    mid = _noise(SR, 4)
    mix = np.column_stack((mid + _noise(SR, 5) * 0.1, mid - _noise(SR, 5) * 0.1))
    assert stereo_correlation(mix) > MONO_CORRELATION_FLOOR
    out, before, after = enforce_mono_compatibility(mix)
    assert np.array_equal(out, mix)
    assert before == after


def test_guard_never_widens():
    for seed in range(6):
        mid = _noise(SR, seed) * 0.4
        mix = np.column_stack((mid + _noise(SR, seed + 10), mid + _noise(SR, seed + 20)))
        out, before, after = enforce_mono_compatibility(mix)
        assert after >= before - 1e-9
        assert stereo_correlation(out) >= before - 1e-9


def test_dual_mono_is_a_no_op_without_dividing_by_zero():
    mono = _noise(SR, 7)
    mix = np.column_stack((mono, mono))
    out, before, after = enforce_mono_compatibility(mix)
    assert before == 1.0
    assert after == 1.0
    assert np.array_equal(out, mix)


def test_single_channel_input_is_a_no_op():
    mono = _noise(SR, 8)
    out, before, after = enforce_mono_compatibility(mono)
    assert out.shape == mono.shape
    assert before == after == 1.0


def test_silence_does_not_crash():
    silence = np.zeros((SR, 2))
    out, before, after = enforce_mono_compatibility(silence)
    assert np.array_equal(out, silence)
    assert np.isfinite(before) and np.isfinite(after)


def test_exactly_at_floor_is_left_alone():
    # L = M + kS / R = M - kS gives correlation (m - k^2 s) / (m + k^2 s);
    # with unit-power mid and side, k solves to the floor exactly.
    mid = _noise(SR, 9)
    side = _noise(SR, 11)
    mid /= np.sqrt(np.mean(mid * mid))
    side /= np.sqrt(np.mean(side * side))
    k = float(np.sqrt((1.0 - MONO_CORRELATION_FLOOR) / (1.0 + MONO_CORRELATION_FLOOR)))
    mix = np.column_stack((mid + side * k, mid - side * k))
    measured = stereo_correlation(mix)
    assert abs(measured - MONO_CORRELATION_FLOOR) < 0.02

    out, before, after = enforce_mono_compatibility(mix, floor=measured)
    assert np.array_equal(out, mix)
    assert before == after
