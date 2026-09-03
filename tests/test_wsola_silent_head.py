"""Regression: a slice with a silent head must not time-stretch to digital silence.

The WSOLA search correlates each candidate against the accumulated output. When
that output region is still silent every candidate scores 0.0, and picking the
first candidate rewound the read pointer by the search radius on every hop. The
reader then advanced at (hop_a - search) samples per iteration while the writer
advanced hop_s, so the writer reached the end of the buffer before the reader
ever got to the audio.
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from dsp.tempo_time_stretch import (  # noqa: E402
    _wsola_channel,
    lock_slice_to_tempo,
    time_stretch_wsola,
)

SR = 44100


def _rms_dbfs(audio) -> float:
    arr = np.asarray(audio, dtype=np.float64)
    if arr.size == 0:
        return -120.0
    return 20.0 * np.log10(max(1e-12, float(np.sqrt(np.mean(arr**2)))))


def _silent_head_tone(silence_sec: float, tone_sec: float, freq: float = 220.0):
    silence = np.zeros(int(silence_sec * SR), dtype=np.float64)
    t = np.arange(int(tone_sec * SR), dtype=np.float64) / SR
    tone = 0.35 * np.sin(2.0 * np.pi * freq * t)
    mono = np.concatenate([silence, tone])
    return np.column_stack([mono, mono])


@pytest.mark.parametrize("silence_sec", [0.3, 1.0, 2.0, 3.0])
def test_stretch_preserves_energy_after_a_silent_head(silence_sec):
    audio = _silent_head_tone(silence_sec, 4.0 - silence_sec)
    source_db = _rms_dbfs(audio)
    stretched = time_stretch_wsola(audio, 1.0836, sr=SR)
    assert _rms_dbfs(stretched) > source_db - 12.0


def test_wsola_channel_does_not_return_all_zeros():
    audio = _silent_head_tone(2.0, 2.0)
    out = _wsola_channel(np.asarray(audio[:, 0]), 1.0836)
    assert np.count_nonzero(out) > 0


def test_tempo_lock_preserves_energy_after_a_silent_head():
    audio = _silent_head_tone(2.0, 2.0)
    locked = lock_slice_to_tempo(audio, target_bpm=140.0, sr=SR)
    assert _rms_dbfs(locked) > _rms_dbfs(audio) - 12.0


def test_stretch_still_works_on_continuous_audio():
    t = np.arange(4 * SR, dtype=np.float64) / SR
    mono = 0.3 * np.sin(2.0 * np.pi * 220.0 * t)
    audio = np.column_stack([mono, mono])
    stretched = time_stretch_wsola(audio, 1.25, sr=SR)
    assert _rms_dbfs(stretched) > _rms_dbfs(audio) - 6.0
    assert abs(len(stretched) - len(audio) / 1.25) < SR * 0.1
