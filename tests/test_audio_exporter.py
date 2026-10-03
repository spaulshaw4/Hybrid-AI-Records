"""The production folder contains 13 stems, a master, and a manifest."""
import json

import numpy as np

from engine.audio_exporter import PACKAGE_RATE, STEM_EXPORT_IDS, RenderSession, export_multitrack_package


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
