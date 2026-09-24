"""Local pitch snap math — no pyworld required for these cases."""
from __future__ import annotations

import os
import sys

import numpy as np
import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from engine.vocal_tuner import (  # noqa: E402
    hz_to_midi,
    midi_to_hz,
    normalize_mode,
    parse_root_key,
    snap_midi_to_scale,
)


def test_parse_root_key_variants():
    assert parse_root_key("G") == ("G", "major")
    assert parse_root_key("G_minor") == ("G", "minor")
    assert parse_root_key("Em") == ("E", "minor")
    assert parse_root_key("Db major") == ("C#", "major")


def test_hz_midi_roundtrip_a440():
    f0 = np.array([0.0, 440.0, 880.0])
    midi = hz_to_midi(f0)
    assert midi[0] == 0.0
    assert midi[1] == pytest.approx(69.0)
    assert midi[2] == pytest.approx(81.0)
    voiced = f0 > 0
    back = midi_to_hz(midi, voiced)
    np.testing.assert_allclose(back[voiced], f0[voiced], rtol=1e-6)


def test_snap_g_major_locks_off_scale_notes():
    # F natural (65) is not in G major; nearest is F# (66) or E (64).
    snapped = snap_midi_to_scale(65.2, "G", "major")
    assert snapped in {64.0, 66.0}
    # G itself stays G.
    assert snap_midi_to_scale(67.0, "G", "major") == 67.0


def test_snap_g_minor_avoids_major_third():
    # B4 (71) is in G major; G minor wants Bb (70), not B natural.
    assert snap_midi_to_scale(71.0, "G", mode="minor") == 70.0
    assert snap_midi_to_scale(71.0, "G", mode="major") == 71.0
    # mode= wins over a leftover scale="major" so conductor G_minor is honored.
    assert snap_midi_to_scale(71.0, "G", "major", mode="minor") == 70.0
    assert normalize_mode("min") == "minor"
    assert normalize_mode(None, "major") == "major"


def test_snap_accepts_arrays():
    midi = np.array([60.0, 61.0, 62.0])  # C, C#, D in C major → C, C, D
    out = snap_midi_to_scale(midi, "C", "major")
    assert list(out) == [60.0, 60.0, 62.0]


def test_tune_vocal_to_song_writes_wav(tmp_path):
    pytest.importorskip("pyworld")
    import soundfile as sf

    from engine.vocal_tuner import tune_vocal_to_song

    sr = 16000
    t = np.arange(int(0.4 * sr)) / sr
    # F4 (349 Hz) is off G major; tuner should emit a same-length WAV.
    tone = 0.2 * np.sin(2 * np.pi * 349.23 * t)
    src = tmp_path / "raw.wav"
    dest = tmp_path / "tuned.wav"
    sf.write(src, tone.astype(np.float32), sr)
    out = tune_vocal_to_song(str(src), str(dest), root_key="G")
    assert os.path.isfile(out)
    audio, file_sr = sf.read(out)
    assert file_sr == sr
    assert audio.size > 0
