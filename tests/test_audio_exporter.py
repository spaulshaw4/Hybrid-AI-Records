"""The production folder contains 13 stems, a master, and a manifest."""
import json

import numpy as np
import soundfile as sf

from engine.audio_exporter import (
    PACKAGE_RATE,
    STEM_EXPORT_IDS,
    RenderSession,
    export_multitrack_package,
    save_wav_pcm24,
)


def test_package_writes_thirteen_stems_and_a_master(tmp_path):
    sr = 8000
    frames = sr // 2
    t = np.linspace(0, 0.5, frames, endpoint=False)
    lanes = {}
    for index, export_id in enumerate(STEM_EXPORT_IDS.values()):
        tone = (0.05 * np.sin(2 * np.pi * (80 + index * 30) * t)).astype(np.float64)
        lanes[export_id] = np.stack([tone, tone], axis=1)
    dest = export_multitrack_package(
        RenderSession(lanes, {"song_id": "ht_test", "key": "G_minor", "bpm": 104}, sr),
        str(tmp_path / "song_20261003_001"),
    )
    stem_dir = tmp_path / "song_20261003_001" / "stems"
    written = sorted(path.name for path in stem_dir.glob("*.wav"))
    assert written == [f"{export_id}.wav" for export_id in STEM_EXPORT_IDS.values()]
    assert (tmp_path / "song_20261003_001" / "master_full.wav").is_file()
    manifest = json.loads((tmp_path / "song_20261003_001" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["song_id"] == "ht_test"
    assert manifest["sample_rate"] == PACKAGE_RATE
    assert manifest["key"] == "G_minor"
    assert len(manifest["stems"]) == 13
    assert dest.endswith("song_20261003_001")


def test_hot_lanes_stay_inside_unit_float(tmp_path):
    """Thirteen full-scale lanes must not wrap or clip to a square wave."""
    frames = 1000
    t = np.linspace(0, 1, frames, endpoint=False)
    lanes = {}
    for index, export_id in enumerate(STEM_EXPORT_IDS.values()):
        tone = (0.9 * np.sin(2 * np.pi * (40 + index * 15) * t)).astype(np.float64)
        lanes[export_id] = np.stack([tone, tone], axis=1)
    dest = export_multitrack_package(
        RenderSession(lanes, {"song_id": "ht_hot"}, 8000),
        str(tmp_path / "song_hot"),
    )
    master, rate = sf.read(f"{dest}/master_full.wav", always_2d=True)
    assert rate == PACKAGE_RATE
    peak = float(np.max(np.abs(master)))
    assert peak <= 1.0
    # A rail-to-rail square occupies almost every sample. A sine sum does not.
    assert float(np.mean(np.abs(master) > 0.98)) < 0.05
    kick, _ = sf.read(f"{dest}/stems/01_kick.wav", always_2d=True)
    assert float(np.max(np.abs(kick))) <= 1.0
    assert float(np.mean(np.abs(kick) > 0.98)) < 0.05


def test_integer_pcm_is_scaled_before_the_wav(tmp_path):
    raw = (np.sin(np.linspace(0, 8, 400)) * 30000).astype(np.int16)
    stereo = np.stack([raw, raw], axis=1)
    path = save_wav_pcm24(str(tmp_path / "kick.wav"), stereo, sample_rate=8000)
    audio, _ = sf.read(path, always_2d=True)
    assert float(np.max(np.abs(audio))) < 1.0
    assert float(np.mean(np.abs(audio) > 0.98)) < 0.05
