"""Session shovel: long sources are phrase-sliced beside the job, not into the corpus."""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pytest
import soundfile as sf

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from dsp.smart_transient_slicer import RawSourceError  # noqa: E402
from scripts.generic_slice_stager import (  # noqa: E402
    shovel_into_session,
    stamp_session_blueprint,
)


def _tone(path: str, seconds: float, sr: int = 8000) -> None:
    t = np.arange(int(seconds * sr)) / sr
    tone = (0.2 * np.sin(2.0 * np.pi * 220.0 * t)).astype(np.float32)
    sf.write(path, np.stack([tone, tone], axis=1), sr)


def test_long_source_is_shoveled_into_the_session(tmp_path):
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    for i in range(6):
        _tone(str(corpus / f"hit_{i:02d}.wav"), 0.4)
    _tone(str(corpus / "bed.wav"), 12.0)
    session = tmp_path / "session"
    workspace = shovel_into_session(str(corpus), str(session), 4.0)
    assert os.path.basename(workspace) == "slices"
    names = os.listdir(workspace)
    assert any(name.startswith("bed") and "_phrase_" in name for name in names)
    assert any(name.startswith("hit_") for name in names)
    assert not (tmp_path / "uploaded_slices").exists()


def test_uploaded_slices_are_refused(tmp_path):
    dump = tmp_path / "uploaded_slices"
    dump.mkdir()
    _tone(str(dump / "bed.wav"), 12.0)
    with pytest.raises(RawSourceError):
        shovel_into_session(str(dump), str(tmp_path / "session"), 4.0)


def test_genre_stamp_does_not_rewrite_the_shared_blueprint(tmp_path):
    shared = tmp_path / "shared" / "gemini_arrangement.json"
    shared.parent.mkdir()
    shared.write_text(json.dumps({"genre": "old", "sections": []}), encoding="utf-8")
    dest = stamp_session_blueprint(str(shared), str(tmp_path / "session"), "alt_rock")
    assert json.loads(shared.read_text(encoding="utf-8"))["genre"] == "old"
    stamped = json.loads(open(dest, encoding="utf-8").read())
    assert stamped["genre"] == "alt_rock"
    assert os.path.basename(dest) == "arrangement.json"
