"""Energy arc + DSP state machine."""
from __future__ import annotations

import os
import sys

import numpy as np
import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.conductor_matrix import (  # noqa: E402
    apply_bar_dsp,
    apply_dsp_rules,
    generate_energy_arc,
    mute_kick_on_beat_one,
    rhythm_filter_hz,
)


def test_energy_arc_scales_to_any_length_and_stays_seeded():
    short = generate_energy_arc(8, seed=7)
    long = generate_energy_arc(96, seed=7)
    assert short.shape == (8,)
    assert long.shape == (96,)
    assert short.min() >= 1.0 and short.max() <= 10.0
    assert long.min() >= 1.0 and long.max() <= 10.0
    assert np.array_equal(generate_energy_arc(96, seed=7), long)
    assert not np.array_equal(generate_energy_arc(96, seed=8), long)
    # Long form must visit both sparse and climax acts.
    assert float(long.min()) <= 3.0
    assert float(long.max()) >= 8.0


def test_dsp_rules_map_console_commands():
    intro = apply_dsp_rules(2)
    assert intro["drums_active"] is False
    assert intro["bass_active"] is False
    assert intro["rhythm_filter"] == "lowpass_400Hz"
    assert rhythm_filter_hz(intro) == 400.0

    build = apply_dsp_rules(4)
    assert build["kick_muted"] is True
    assert build["bass_active"] is False
    assert rhythm_filter_hz(build) == 1000.0

    groove = apply_dsp_rules(6)
    assert groove["drums_active"] is True
    assert groove["bass_active"] is True
    assert groove["lead_active"] is False

    drive = apply_dsp_rules(8)
    assert drive["lead_active"] is True
    assert drive["rhythm_swell"] is False

    climax = apply_dsp_rules(10)
    assert climax["lead_active"] is True
    assert climax["rhythm_swell"] is True
    assert apply_dsp_rules(9)["rhythm_swell"] is True


def test_kick_mute_removes_low_band_on_beat_one_only():
    sr = 22050
    bpm = 120.0
    n = int(round(2.0 * sr))  # one bar
    t = np.arange(n) / sr
    # Kick-like click at beat 1 (t=0) and beat 3 (t=1.0).
    drums = np.zeros(n, dtype=np.float64)
    for onset_sec in (0.0, 1.0):
        i = int(onset_sec * sr)
        body = np.linspace(1.0, 0.0, int(0.08 * sr))
        drums[i : i + body.size] += 0.9 * body * np.sin(2 * np.pi * 60.0 * t[: body.size])

    muted = mute_kick_on_beat_one(drums, sr, bpm)
    beat1 = slice(0, int(0.12 * sr))
    beat3 = slice(int(1.0 * sr), int(1.12 * sr))
    assert float(np.sqrt(np.mean(muted[beat1] ** 2))) < float(np.sqrt(np.mean(drums[beat1] ** 2))) * 0.85
    assert float(np.sqrt(np.mean(muted[beat3] ** 2))) > float(np.sqrt(np.mean(muted[beat1] ** 2)))


def test_bar_dsp_filters_harmonic_and_mutes_bass():
    sr = 8000
    n = 2000
    t = np.arange(n) / sr
    dry = {
        "rhythm": 0.3 * np.sin(2 * np.pi * 80.0 * t),
        "bass": 0.4 * np.sin(2 * np.pi * 55.0 * t),
        "harmonic": 0.3 * np.sin(2 * np.pi * 2000.0 * t),
    }
    out = apply_bar_dsp(dry, apply_dsp_rules(2), sr, 120.0)
    assert float(np.max(np.abs(out["rhythm"]))) == 0.0
    assert float(np.max(np.abs(out["bass"]))) == 0.0
    # 2 kHz tone through 400 Hz LPF should collapse.
    assert float(np.max(np.abs(out["harmonic"]))) < 0.05
