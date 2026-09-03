import os
import sys
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.blueprint_schema import (  # noqa: E402
    SAMPLE_BLUEPRINT,
    normalise_root_key,
    strip_json_fences,
    validate_blueprint,
    validate_sample_contract,
)


class TestBlueprintSchema(unittest.TestCase):
    def test_user_intro_chorus_example(self):
        blueprint = validate_sample_contract(SAMPLE_BLUEPRINT)
        self.assertEqual(blueprint["track_metadata"]["root_key"], "D#")
        self.assertEqual(int(blueprint["track_metadata"]["bpm"]), 138)
        self.assertEqual(len(blueprint["sections"]), 2)
        self.assertEqual(blueprint["sections"][0]["name"], "intro")
        self.assertEqual(blueprint["sections"][1]["name"], "chorus")
        self.assertGreaterEqual(blueprint["sections"][0]["slice_count"], 1)
        chorus = blueprint["sections"][1]["volume_weights"]
        self.assertEqual(chorus["vocal"], 0.60)

    def test_flat_key_alias_and_bpm_clamp(self):
        raw = {
            "track_metadata": {
                "title": "T",
                "bpm": 240,
                "root_key": "Db",
                "genre": "alt_rock",
                "total_bars": 8,
            },
            "sections": [
                {
                    "name": "intro",
                    "slice_count": 0,
                    "energy": 1.5,
                    "volume_weights": {"rhythm": 2, "harmonic": -1, "lead": 0.5, "vocal": 0.1},
                    "query_tags": {"rhythm": ["kick"], "harmonic": [], "lead": [], "vocal": []},
                    "dsp_filters": {"lowpass_hz": 1000, "reverb_send": 0.2, "saturation_drive": 0.1},
                }
            ],
        }
        blueprint = validate_blueprint(raw)
        self.assertEqual(blueprint["track_metadata"]["root_key"], "C#")
        self.assertEqual(blueprint["track_metadata"]["bpm"], 180)
        self.assertGreaterEqual(blueprint["sections"][0]["slice_count"], 1)
        self.assertLessEqual(blueprint["sections"][0]["energy"], 1.0)
        self.assertEqual(blueprint["sections"][0]["volume_weights"]["rhythm"], 1.0)
        self.assertEqual(blueprint["sections"][0]["volume_weights"]["harmonic"], 0.0)

    def test_arrange_span_pads_to_five(self):
        blueprint = validate_blueprint(SAMPLE_BLUEPRINT, enforce_section_span=True)
        self.assertGreaterEqual(len(blueprint["sections"]), 5)
        self.assertLessEqual(len(blueprint["sections"]), 8)

    def test_strip_fences(self):
        blob = '```json\n{"track_metadata": {"title": "X"}}\n```'
        cleaned = strip_json_fences(blob)
        self.assertTrue(cleaned.startswith("{"))
        self.assertNotIn("```", cleaned)

    def test_normalise_root_key(self):
        self.assertEqual(normalise_root_key("bb"), "A#")
        self.assertEqual(normalise_root_key("A"), "A")


if __name__ == "__main__":
    unittest.main()
