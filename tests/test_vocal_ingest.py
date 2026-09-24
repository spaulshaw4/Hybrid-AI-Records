"""Vocal duration math and mid-duck envelope — no FFmpeg required."""
from __future__ import annotations

import os
import sys

import numpy as np
import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.vocal_ingest import (  # noqa: E402
    bars_for_duration,
    duck_mix_mids_for_vocal,
    overlay_vocal_on_mix,
    song_length_from_vocal,
)


def test_bars_formula_90s_at_110_is_not_96():
    assert bars_for_duration(90.0, 110.0) == 41
    assert bars_for_duration(210.0, 110.0) == 96


def test_vocal_plus_eight_bar_outro():
    # 90s take @ 110 BPM + 8 bars (≈17.45s) → ~107s, not 210.
    length = song_length_from_vocal(90.0, 110.0)
    assert 100.0 < length < 120.0
    assert bars_for_duration(length, 110.0) < 60


def test_duck_lowers_mids_when_voice_is_loud():
    sr = 8000
    n = sr
    t = np.arange(n) / sr
    mix = np.sin(2 * np.pi * 2000.0 * t) * 0.4
    vocal = np.sin(2 * np.pi * 220.0 * t) * 0.5
    ducked = duck_mix_mids_for_vocal(mix, vocal, sr, duck_db=2.5)
    assert float(np.sqrt(np.mean(ducked * ducked))) < float(np.sqrt(np.mean(mix * mix)))


def test_overlay_adds_vocal_energy():
    mix = np.zeros(1000)
    vocal = np.ones(1000) * 0.2
    out = overlay_vocal_on_mix(mix, vocal)
    assert float(np.max(np.abs(out))) == pytest.approx(0.2)
