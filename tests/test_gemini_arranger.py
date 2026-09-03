import json
import os
import sys
import tempfile
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.blueprint_schema import validate_blueprint  # noqa: E402
from engine.gemini_arranger import (  # noqa: E402
    arrange_from_prompt,
    heuristic_blueprint,
    infer_bpm,
    infer_genre,
    infer_root_key,
    write_blueprint,
)


class TestGeminiArrangerOffline(unittest.TestCase):
    def test_heuristic_from_keywords(self):
        blueprint, mode = arrange_from_prompt(
            "Heavy modern alternative rock with driving rhythm, 140 bpm, key of E",
            genre=None,
            offline=True,
            live=False,
        )
        self.assertEqual(mode, "offline")
        self.assertEqual(int(blueprint["track_metadata"]["bpm"]), 140)
        self.assertEqual(blueprint["track_metadata"]["root_key"], "E")
        self.assertIn("rock", blueprint["track_metadata"]["genre"])
        self.assertGreaterEqual(len(blueprint["sections"]), 5)
        self.assertLessEqual(len(blueprint["sections"]), 8)
        again = validate_blueprint(blueprint, enforce_section_span=True)
        self.assertEqual(again["track_metadata"]["root_key"], "E")

    def test_write_valid_json(self):
        blueprint = heuristic_blueprint("dark techno 128 bpm in F#", genre="techno")
        with tempfile.TemporaryDirectory() as tmp:
            dest = os.path.join(tmp, "arrangement.json")
            write_blueprint(blueprint, dest)
            with open(dest, encoding="utf-8") as handle:
                loaded = json.load(handle)
        self.assertEqual(loaded["track_metadata"]["genre"], "techno")
        self.assertEqual(int(loaded["track_metadata"]["bpm"]), 128)
        self.assertEqual(loaded["track_metadata"]["root_key"], "F#")

    def test_infer_helpers(self):
        self.assertEqual(infer_bpm("about 96 BPM please"), 96)
        self.assertEqual(infer_root_key("key of C#"), "C#")
        self.assertEqual(infer_genre("ambient drone bed", None), "ambient")


if __name__ == "__main__":
    unittest.main()
