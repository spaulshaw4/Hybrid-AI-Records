import json
import os
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np
import soundfile as sf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.blueprint_schema import SAMPLE_BLUEPRINT, validate_blueprint  # noqa: E402
from engine.blueprint_track_assembler import assemble_from_blueprint  # noqa: E402
from engine.generate_track_headless import (  # noqa: E402
    execute_prompt_pipeline,
    parse_cli_key,
    session_scratch_dir,
    wav_duration_sec,
)


def _write_tone(path: str, sr: int = 8000, hz: float = 220.0, seconds: float = 0.3) -> None:
    t = np.linspace(0, seconds, int(seconds * sr), endpoint=False)
    sig = (0.2 * np.sin(2 * np.pi * hz * t)).astype(np.float32)
    sf.write(path, np.stack([sig, sig], axis=1), sr)


def _tiny_blueprint() -> dict:
    sections = []
    for name, energy in (
        ("intro", 0.35),
        ("verse_1", 0.55),
        ("chorus", 0.85),
        ("drop", 0.90),
        ("outro", 0.30),
    ):
        sections.append(
            {
                "name": name,
                "slice_count": 1,
                "energy": energy,
                "volume_weights": {"rhythm": 0.7, "harmonic": 0.5, "lead": 0.3, "vocal": 0.0},
                "query_tags": {
                    "rhythm": ["kick"],
                    "harmonic": ["pad"],
                    "lead": ["lead"],
                    "vocal": [],
                },
                "dsp_filters": {"lowpass_hz": 12000, "reverb_send": 0.2, "saturation_drive": 0.15},
            }
        )
    raw = {
        "track_metadata": {
            "title": "Unit_Test",
            "bpm": 120,
            "root_key": "A",
            "genre": "alt_rock",
            "total_bars": 5,
        },
        "sections": sections,
    }
    return validate_blueprint(raw, enforce_section_span=True)


class TestGenerateTrackHeadless(unittest.TestCase):
    def test_session_scratch_resolution(self):
        nested = session_scratch_dir(r"D:\MusicDatasets\scratch\sess_1", "sess_1")
        self.assertTrue(nested.replace("/", "\\").endswith("sess_1"))
        joined = session_scratch_dir(r"D:\MusicDatasets\scratch", "sess_1")
        self.assertTrue(joined.replace("/", "\\").endswith(os.path.join("scratch", "sess_1")))

    def test_query_tags_empty_index_falls_back_to_glob(self):
        sr = 8000
        with tempfile.TemporaryDirectory() as tmp:
            corpus = os.path.join(tmp, "corpus")
            os.makedirs(corpus)
            for i in range(8):
                _write_tone(os.path.join(corpus, f"slice_{i:02d}.wav"), sr=sr, hz=200 + i * 10)
            bp_path = os.path.join(tmp, "bp.json")
            out_path = os.path.join(tmp, "mix.wav")
            with open(bp_path, "w", encoding="utf-8") as handle:
                json.dump(SAMPLE_BLUEPRINT, handle)
            assembled = assemble_from_blueprint(
                bp_path,
                corpus,
                out_path,
                sr=sr,
                seed=3,
                index_db=os.path.join(tmp, "missing.sqlite"),
                use_index=True,
            )
            self.assertTrue(os.path.isfile(assembled))
            data, out_sr = sf.read(assembled)
            self.assertEqual(out_sr, sr)
            self.assertGreater(data.shape[0], 0)

    def test_offline_pipeline_writes_unmastered_mix(self):
        sr = 8000
        tiny = _tiny_blueprint()
        with tempfile.TemporaryDirectory() as tmp:
            corpus = os.path.join(tmp, "corpus_4s")
            os.makedirs(os.path.join(corpus, "drums"))
            os.makedirs(os.path.join(corpus, "pads"))
            for i in range(4):
                _write_tone(os.path.join(corpus, "drums", f"kick_{i}.wav"), sr=sr, hz=90)
                _write_tone(os.path.join(corpus, "pads", f"pad_{i}.wav"), sr=sr, hz=330)
                _write_tone(os.path.join(corpus, f"lead_{i}.wav"), sr=sr, hz=440)
            db_path = os.path.join(tmp, "empty.sqlite")
            with mock.patch(
                "engine.generate_track_headless.arrange_from_prompt",
                return_value=(tiny, "offline"),
            ):
                result = execute_prompt_pipeline(
                    "unit test prompt",
                    "unit_sess",
                    db_path,
                    tmp,
                    offline=True,
                    live=False,
                    corpus_dir=corpus,
                    max_per_stem=4,
                    max_stage=16,
                    sr=sr,
                )
            mix = result["unmastered_mix"]
            named = result["unmastered_wav"]
            self.assertEqual(result["mode"], "offline")
            self.assertTrue(os.path.isfile(mix))
            self.assertTrue(os.path.isfile(named))
            self.assertGreater(wav_duration_sec(mix), 0.5)
            self.assertTrue(os.path.isfile(result["blueprint_path"]))

    def test_parse_cli_key_dmin(self):
        self.assertEqual(parse_cli_key("Dmin"), ("D", "minor"))
        self.assertEqual(parse_cli_key("D minor"), ("D", "minor"))
        self.assertEqual(parse_cli_key("A#maj")[0], "A#")

    def test_cli_bpm_key_override_offline_pipeline(self):
        sr = 8000
        tiny = _tiny_blueprint()
        with tempfile.TemporaryDirectory() as tmp:
            corpus = os.path.join(tmp, "corpus_4s")
            os.makedirs(os.path.join(corpus, "drums"))
            os.makedirs(os.path.join(corpus, "pads"))
            for i in range(4):
                _write_tone(os.path.join(corpus, "drums", f"kick_{i}.wav"), sr=sr, hz=90)
                _write_tone(os.path.join(corpus, "pads", f"pad_{i}.wav"), sr=sr, hz=330)
                _write_tone(os.path.join(corpus, f"lead_{i}.wav"), sr=sr, hz=440)
            db_path = os.path.join(tmp, "empty.sqlite")
            with mock.patch(
                "engine.generate_track_headless.arrange_from_prompt",
                return_value=(tiny, "offline"),
            ):
                result = execute_prompt_pipeline(
                    "unit test prompt",
                    "unit_sess_key",
                    db_path,
                    tmp,
                    offline=True,
                    live=False,
                    corpus_dir=corpus,
                    max_per_stem=4,
                    max_stage=16,
                    sr=sr,
                    bpm=140,
                    key="Dmin",
                )
            with open(result["blueprint_path"], encoding="utf-8") as handle:
                locked = json.load(handle)
            meta = locked["track_metadata"]
            self.assertEqual(meta["bpm"], 140)
            self.assertEqual(meta["root_key"], "D")
            self.assertEqual(meta.get("scale"), "minor")


if __name__ == "__main__":
    unittest.main()
