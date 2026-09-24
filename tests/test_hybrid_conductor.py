"""Adaptive Frame Conductor — tension map + DSP commands."""
from __future__ import annotations

import os
import sys

import numpy as np
import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.hybrid_conductor import AdaptiveConductor  # noqa: E402
from engine.stem_adapter import stretch_to_bpm  # noqa: E402


def test_tension_map_scales_and_stays_in_range():
    short = AdaptiveConductor(8, "trap").generate_tension_map()
    long = AdaptiveConductor(96, "trap").generate_tension_map()
    assert short.shape == (8,)
    assert long.shape == (96,)
    assert 1.0 <= float(short.min()) <= float(short.max()) <= 100.0
    assert 1.0 <= float(long.min()) <= float(long.max()) <= 100.0
    assert float(long.max()) >= 85.0
    assert float(long.min()) <= 25.0


def test_dsp_rules_from_tension():
    c = AdaptiveConductor(32, "rock")
    intro = c.evaluate_dsp_rules(18)
    assert intro["drums_active"] is False
    assert intro["bass_active"] is False
    assert intro["rhythm_filter"] == "lowpass_600Hz"
    assert intro["stereo_width"] == 0.5

    build = c.evaluate_dsp_rules(40)
    assert build["kick_muted"] is True
    assert build["bass_active"] is False
    assert build["rhythm_filter"] == "lowpass_2000Hz"

    groove = c.evaluate_dsp_rules(60)
    assert groove["drums_active"] is True
    assert groove["bass_active"] is True
    assert groove["stereo_width"] == 0.8

    climax = c.evaluate_dsp_rules(92)
    assert climax["stereo_width"] == 1.25
    assert climax["rhythm_swell"] is True


def test_ui_bpm_forces_stretch_not_native_tempo():
    sr = 8000
    native_bpm = 112.0
    target_bpm = 89.0
    seconds = 2.0
    n = int(sr * seconds)
    t = np.arange(n) / sr
    # 112 BPM quarter clicks.
    tone = np.zeros(n)
    step = int(round(60.0 / native_bpm * sr))
    tone[::step] = 1.0
    locked = stretch_to_bpm(
        tone,
        source_bpm=native_bpm,
        target_bpm=target_bpm,
        sr=sr,
        target_samples=int(round(seconds * target_bpm / native_bpm * n)),
    )
    expected = int(round(seconds * target_bpm / native_bpm * n))
    assert locked.shape[0] == expected
    assert locked.shape[0] != n
