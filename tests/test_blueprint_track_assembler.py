import json
import os
import random
import sys
import tempfile
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.blueprint_track_assembler import (  # noqa: E402
    DynamicSliceRotator,
    apply_equal_power_crossfade,
    assemble_from_blueprint,
    default_cooldown,
    equal_power_fade_samples,
    get_section_order,
    junction_zero_crossing,
    load_phrase_slice,
    loop_join_fade_samples,
    samples_for_bars,
    samples_per_bar,
    scratch_unmastered_path,
    snap_cut_to_zc_or_silence,
    tile_loop_equal_power,
    DEFAULT_BPM,
    LOOP_BOUNDARY_FADE_MS,
)
from engine.stem_role_router import (  # noqa: E402
    fade_samples,
    infer_role_from_path,
    is_grid_role,
    is_phrase_role,
    pad_or_trim,
    role_for_weight_key,
    split_on_silence,
)
import numpy as np
import soundfile as sf


class TestDynamicSliceRotator(unittest.TestCase):
    def test_cooldown_matches_design(self):
        self.assertEqual(default_cooldown(24), 8)
        self.assertEqual(default_cooldown(12), 4)
        self.assertEqual(default_cooldown(3), 1)
        self.assertEqual(default_cooldown(1), 0)

    def test_cooldown_leaves_two_free_when_pool_allows(self):
        rot = DynamicSliceRotator([f"s{i}" for i in range(6)], cooldown_size=8)
        self.assertEqual(rot.cooldown_size, min(8, max(1, 6 - 2)))
        self.assertEqual(rot.cooldown_size, 4)
        tiny = DynamicSliceRotator(["a"], cooldown_size=8)
        self.assertEqual(tiny.cooldown_size, 0)

    def test_no_repeat_within_cooldown_when_pool_is_large(self):
        pool = [f"slice_{i:02d}" for i in range(24)]
        rot = DynamicSliceRotator(pool, rng=random.Random(7))
        self.assertEqual(rot.cooldown_size, 8)
        picked = [rot.choose_slice(rot.get_section_bank(6)) for _ in range(8)]
        self.assertEqual(len(picked), 8)
        self.assertEqual(len(set(picked)), 8)

    def test_empty_bank_falls_back_without_choice_error(self):
        pool = [f"s{i}" for i in range(10)]
        rot = DynamicSliceRotator(pool, rng=random.Random(1))
        chosen = rot.choose_slice([])
        self.assertIn(chosen, pool)

    def test_empty_available_bank_falls_back_to_pool(self):
        pool = [f"s{i}" for i in range(8)]
        rot = DynamicSliceRotator(pool, cooldown_size=6, rng=random.Random(3))
        for _ in range(6):
            rot.choose_slice()
        bank = rot.get_section_bank(6)
        self.assertGreater(len(bank), 0)
        self.assertTrue(set(bank).issubset(set(pool)))

    def test_seed_is_reproducible(self):
        pool = [f"s{i}" for i in range(16)]
        ra = DynamicSliceRotator(pool, seed=42)
        rb = DynamicSliceRotator(pool, seed=42)
        a = [ra.choose_slice() for _ in range(6)]
        b = [rb.choose_slice() for _ in range(6)]
        self.assertEqual(a, b)


class TestSectionOrder(unittest.TestCase):
    def test_startswith_longest_prefix(self):
        self.assertEqual(get_section_order({"name": "Intro"}, 0), 10)
        self.assertEqual(get_section_order({"name": "verse_1"}, 0), 21)
        self.assertEqual(get_section_order({"name": "Chorus 2"}, 0), 40)
        self.assertEqual(get_section_order({"name": "drop_chorus"}, 0), 45)
        self.assertEqual(get_section_order({"name": "mystery"}, 3), 103)


class TestStemRoleRouter(unittest.TestCase):
    def test_folder_and_weight_roles(self):
        self.assertEqual(infer_role_from_path(r"D:\MusicDatasets\corpus_4s\vocals\take.wav"), "vocal")
        self.assertEqual(infer_role_from_path(r"D:\stems\drums\kick.wav"), "drums")
        self.assertTrue(is_grid_role(role_for_weight_key("rhythm")))
        self.assertTrue(is_phrase_role(role_for_weight_key("lead")))
        self.assertTrue(is_phrase_role(role_for_weight_key("harmonic")))

    def test_silence_gate_splits_without_librosa(self):
        sr = 8000
        tone = 0.5 * np.sin(2.0 * np.pi * 200.0 * np.arange(int(0.8 * sr)) / sr)
        gap = np.zeros(int(0.5 * sr))
        sig = np.concatenate([tone, gap, tone])
        regions = split_on_silence(sig, sr, gate_dbfs=-35.0, min_phrase_sec=0.2)
        self.assertGreaterEqual(len(regions), 2)

    def test_pad_or_trim_five_ms_fade(self):
        sr = 44100
        long = np.ones((sr, 2), dtype=np.float64)
        trimmed = pad_or_trim(long, 1000, sr=sr, fade_ms=5.0)
        self.assertEqual(trimmed.shape, (1000, 2))
        fade_len = fade_samples(sr, fade_ms=5.0, target=1000)
        self.assertLess(float(trimmed[-1, 0]), 0.05)
        self.assertGreater(float(trimmed[-fade_len, 0]), 0.9)


class TestLoadPhraseSlice(unittest.TestCase):
    def test_pads_and_trims_with_fade(self):
        sr = 8000
        with tempfile.TemporaryDirectory() as tmp:
            short_path = os.path.join(tmp, "short.wav")
            long_path = os.path.join(tmp, "long.wav")
            sf.write(short_path, np.ones((200, 2), dtype=np.float32), sr)
            sf.write(long_path, np.ones((4000, 2), dtype=np.float32), sr)
            padded = load_phrase_slice(short_path, 1000)
            trimmed = load_phrase_slice(long_path, 1000)
            self.assertEqual(padded.shape[0], 1000)
            self.assertEqual(trimmed.shape[0], 1000)
            self.assertLess(float(np.max(np.abs(trimmed[-1]))), 0.05)


class TestAssembleFromBlueprint(unittest.TestCase):
    def test_missing_blueprint_raises_not_sys_exit(self):
        with self.assertRaises(FileNotFoundError):
            assemble_from_blueprint(
                "Z:\\missing\\blueprint.json",
                "Z:\\missing\\corpus",
                os.path.join(tempfile.gettempdir(), "no_mix.wav"),
            )

    def test_assemble_weighted_mix_is_readable(self):
        sr = 8000
        with tempfile.TemporaryDirectory() as tmp:
            corpus = os.path.join(tmp, "corpus")
            os.makedirs(corpus)
            t = np.arange(int(0.6 * sr)) / sr
            for i in range(8):
                sig = (0.2 * np.sin(2.0 * np.pi * (220 + 20 * i) * t)).astype(np.float32)
                stereo = np.stack([sig, sig], axis=1)
                sf.write(os.path.join(corpus, f"slice_{i:02d}.wav"), stereo, sr)
            blueprint = {
                "sections": [
                    {"name": "intro", "slice_count": 2, "volume_weights": {"rhythm": 0.8, "harmonic": 0.5, "lead": 0.3}},
                    {"name": "verse", "slice_count": 2, "volume_weights": {"rhythm": 0.7, "harmonic": 0.6, "lead": 0.4}},
                    {"name": "chorus", "slice_count": 2, "volume_weights": {"rhythm": 0.9, "harmonic": 0.7, "lead": 0.5}},
                ]
            }
            bp_path = os.path.join(tmp, "blueprint.json")
            out_path = os.path.join(tmp, "mix.wav")
            with open(bp_path, "w", encoding="utf-8") as handle:
                json.dump(blueprint, handle)
            assembled = assemble_from_blueprint(bp_path, corpus, out_path, sr=sr, seed=11)
            self.assertTrue(os.path.isfile(assembled))
            data, out_sr = sf.read(assembled)
            self.assertEqual(out_sr, sr)
            self.assertGreater(data.shape[0], 0)
            peak = float(np.max(np.abs(data)))
            self.assertLessEqual(peak, 10.0 ** (-3.0 / 20.0) + 1e-4)
            bar_n = samples_per_bar(sr, DEFAULT_BPM)
            section_n = 2 * bar_n
            n_sections = 3
            self.assertEqual(data.shape[0], n_sections * section_n)

    def test_crossfade_length_is_a_plus_b_minus_fade(self):
        fade = 64
        mono_a = np.ones(200, dtype=np.float64)
        mono_b = np.full(150, 0.5, dtype=np.float64)
        mono = apply_equal_power_crossfade(mono_a, mono_b, fade)
        self.assertEqual(mono.shape[0], 200 + 150 - fade)
        stereo_a = np.ones((200, 2), dtype=np.float64)
        stereo_b = np.full((150, 2), 0.25, dtype=np.float64)
        stereo = apply_equal_power_crossfade(stereo_a, stereo_b, fade)
        self.assertEqual(stereo.shape, (200 + 150 - fade, 2))

    def test_assemble_two_blocks_match_a_plus_b_minus_fade(self):
        sr = 8000
        fade = 48
        with tempfile.TemporaryDirectory() as tmp:
            corpus = os.path.join(tmp, "corpus")
            os.makedirs(corpus)
            t = np.arange(int(0.5 * sr)) / sr
            for i in range(6):
                sig = (0.2 * np.sin(2.0 * np.pi * (180 + 15 * i) * t)).astype(np.float32)
                sf.write(os.path.join(corpus, f"slice_{i:02d}.wav"), np.stack([sig, sig], axis=1), sr)
            blueprint = {
                "track_metadata": {"bpm": 120},
                "sections": [
                    {
                        "name": "verse_a",
                        "slice_count": 1,
                        "volume_weights": {"rhythm": 0.7, "harmonic": 0.4, "lead": 0.2, "vocal": 0.0},
                    },
                    {
                        "name": "verse_b",
                        "slice_count": 1,
                        "volume_weights": {"rhythm": 0.7, "harmonic": 0.4, "lead": 0.2, "vocal": 0.0},
                    },
                ],
            }
            bp_path = os.path.join(tmp, "blueprint.json")
            out_path = os.path.join(tmp, "mix.wav")
            with open(bp_path, "w", encoding="utf-8") as handle:
                json.dump(blueprint, handle)
            assemble_from_blueprint(bp_path, corpus, out_path, sr=sr, seed=4, crossfade_samples=fade)
            data, _ = sf.read(out_path)
            bar_n = samples_per_bar(sr, 120)
            self.assertEqual(data.shape[0], 2 * bar_n)

    def test_silence_stem_when_weight_tiny_or_no_candidates(self):
        sr = 8000
        with tempfile.TemporaryDirectory() as tmp:
            generic = os.path.join(tmp, "generic")
            session = os.path.join(tmp, "session_slices")
            os.makedirs(generic)
            os.makedirs(session)
            t = np.arange(int(0.4 * sr)) / sr
            for i in range(8):
                sig = (0.25 * np.sin(2.0 * np.pi * (200 + 12 * i) * t)).astype(np.float32)
                stereo = np.stack([sig, sig], axis=1)
                sf.write(os.path.join(generic, f"slice_{i:02d}.wav"), stereo, sr)
            vocal_tone = (0.9 * np.sin(2.0 * np.pi * 880.0 * t)).astype(np.float32)
            vocal_stereo = np.stack([vocal_tone, vocal_tone], axis=1)
            for i in range(3):
                sf.write(os.path.join(session, f"rhythm_{i:02d}.wav"), vocal_stereo * 0.2, sr)
                sf.write(os.path.join(session, f"harmonic_{i:02d}.wav"), vocal_stereo * 0.15, sr)
                sf.write(os.path.join(session, f"lead_{i:02d}.wav"), vocal_stereo * 0.1, sr)

            def _write_bp(path: str, vocal: float) -> None:
                payload = {
                    "sections": [
                        {
                            "name": "chorus",
                            "slice_count": 2,
                            "volume_weights": {
                                "rhythm": 0.6,
                                "harmonic": 0.4,
                                "lead": 0.2,
                                "vocal": vocal,
                            },
                        }
                    ]
                }
                with open(path, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle)

            quiet_bp = os.path.join(tmp, "quiet.json")
            silent_bp = os.path.join(tmp, "silent.json")
            _write_bp(quiet_bp, 0.005)
            _write_bp(silent_bp, 0.0)
            quiet = os.path.join(tmp, "quiet.wav")
            silent = os.path.join(tmp, "silent.wav")
            assemble_from_blueprint(quiet_bp, generic, quiet, sr=sr, seed=9)
            assemble_from_blueprint(silent_bp, generic, silent, sr=sr, seed=9)
            quiet_data, _ = sf.read(quiet)
            silent_data, _ = sf.read(silent)
            self.assertEqual(quiet_data.shape, silent_data.shape)
            self.assertTrue(np.allclose(quiet_data, silent_data, atol=1e-6))

            loud_bp = os.path.join(tmp, "loud.json")
            none_bp = os.path.join(tmp, "none.json")
            _write_bp(loud_bp, 0.9)
            _write_bp(none_bp, 0.0)
            loud = os.path.join(tmp, "session_loud.wav")
            none = os.path.join(tmp, "session_none.wav")
            assemble_from_blueprint(loud_bp, session, loud, sr=sr, seed=5)
            assemble_from_blueprint(none_bp, session, none, sr=sr, seed=5)
            loud_data, _ = sf.read(loud)
            none_data, _ = sf.read(none)
            self.assertEqual(loud_data.shape, none_data.shape)
            self.assertTrue(np.allclose(loud_data, none_data, atol=1e-6))

    def test_session_writes_unmastered_mix_contract_path(self):
        sr = 8000
        with tempfile.TemporaryDirectory() as tmp:
            corpus = os.path.join(tmp, "corpus")
            os.makedirs(corpus)
            t = np.arange(int(0.3 * sr)) / sr
            for i in range(6):
                sig = (0.15 * np.sin(2.0 * np.pi * (160 + 10 * i) * t)).astype(np.float32)
                sf.write(os.path.join(corpus, f"slice_{i:02d}.wav"), np.stack([sig, sig], axis=1), sr)
            bp_path = os.path.join(tmp, "blueprint.json")
            out_path = os.path.join(tmp, "named_out.wav")
            with open(bp_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "sections": [
                            {
                                "name": "intro",
                                "slice_count": 1,
                                "volume_weights": {"rhythm": 0.5, "harmonic": 0.3, "lead": 0.1},
                            }
                        ]
                    },
                    handle,
                )
            assemble_from_blueprint(
                bp_path,
                corpus,
                out_path,
                sr=sr,
                seed=2,
                session_id="sess_xfade",
                scratch_root=tmp,
            )
            contract = scratch_unmastered_path("sess_xfade", tmp)
            self.assertTrue(os.path.isfile(out_path))
            self.assertTrue(os.path.isfile(contract))
            self.assertTrue(contract.endswith(os.path.join("sess_xfade", "unmastered_mix.wav")))


class TestBarLock(unittest.TestCase):
    def test_samples_per_bar_140_44100(self):
        self.assertEqual(samples_per_bar(44100, 140), int(44100 * 240 / 140))
        self.assertEqual(samples_per_bar(44100, 140), 75600)
        self.assertEqual(samples_for_bars(8, 140, 44100), 8 * 75600)
        self.assertAlmostEqual(8 * (60.0 / 140.0) * 4.0, 13.7142857, places=5)
        self.assertAlmostEqual(samples_for_bars(8, 140, 44100) / 44100.0, 13.7142857, places=5)

    def test_loop_join_is_20ms_equal_power(self):
        sr = 44100
        fade = loop_join_fade_samples(sr)
        self.assertEqual(fade, 882)
        self.assertEqual(LOOP_BOUNDARY_FADE_MS, 20.0)
        loop = np.ones((4000, 2), dtype=np.float64)
        target = 4000 + 4000 - fade
        tiled = tile_loop_equal_power(loop, target, sr)
        manual = apply_equal_power_crossfade(loop, loop, fade)
        self.assertEqual(tiled.shape[0], target)
        self.assertEqual(manual.shape[0], target)
        np.testing.assert_allclose(tiled, manual, atol=1e-9)

    def test_drum_bass_same_loop_tiled_not_4s_shuffle(self):
        sr = 8000
        bpm = 140.0
        with tempfile.TemporaryDirectory() as tmp:
            session = os.path.join(tmp, "session_slices")
            os.makedirs(session)
            n = 400
            for i in range(3):
                rhythm = np.full((n, 2), 0.12 * (i + 1), dtype=np.float32)
                harm = np.zeros((n, 2), dtype=np.float32)
                lead = np.zeros((n, 2), dtype=np.float32)
                bass = np.full((n, 2), 0.04 * (i + 1), dtype=np.float32)
                sf.write(os.path.join(session, f"rhythm_{i:02d}.wav"), rhythm, sr)
                sf.write(os.path.join(session, f"harmonic_{i:02d}.wav"), harm, sr)
                sf.write(os.path.join(session, f"lead_{i:02d}.wav"), lead, sr)
                sf.write(os.path.join(session, f"bass_{i:02d}.wav"), bass, sr)
            blueprint = {
                "track_metadata": {"bpm": bpm},
                "sections": [
                    {
                        "name": "chorus",
                        "slice_count": 8,
                        "volume_weights": {
                            "rhythm": 0.8,
                            "harmonic": 0.0,
                            "lead": 0.0,
                            "vocal": 0.0,
                        },
                    }
                ],
            }
            bp_path = os.path.join(tmp, "blueprint.json")
            out_path = os.path.join(tmp, "mix.wav")
            with open(bp_path, "w", encoding="utf-8") as handle:
                json.dump(blueprint, handle)
            trace: dict = {}
            assemble_from_blueprint(
                bp_path, session, out_path, sr=sr, seed=3, source_trace=trace
            )
            self.assertIn("chorus", trace)
            self.assertIn("_track", trace)
            self.assertEqual(trace["chorus"]["rhythm"], trace["_track"]["rhythm"])
            self.assertEqual(trace["chorus"]["bass"], trace["_track"]["bass"])
            self.assertEqual(trace["chorus"]["bars"], 8)
            data, out_sr = sf.read(out_path)
            self.assertEqual(out_sr, sr)
            self.assertEqual(data.shape[0], samples_for_bars(8, bpm, sr))
            hop = sr
            interior = []
            skip = int(sr * 0.030)
            for start in range(0, data.shape[0] - hop, hop):
                window = data[start + skip : start + hop - skip]
                if window.size:
                    interior.append(float(np.median(np.abs(window))))
            self.assertGreaterEqual(len(interior), 2)
            # Same locked loop: EP joins wobble a few thousandths, not 0.12 vs 0.24 file steps.
            self.assertLess(
                max(interior) - min(interior),
                0.02,
                msg=f"rotated unique 4s files? got {interior}",
            )

    def test_track_wide_rhythm_bass_same_across_sections(self):
        sr = 8000
        with tempfile.TemporaryDirectory() as tmp:
            session = os.path.join(tmp, "session_slices")
            os.makedirs(session)
            n = 300
            for i in range(3):
                sf.write(
                    os.path.join(session, f"rhythm_{i:02d}.wav"),
                    np.full((n, 2), 0.15 * (i + 1), dtype=np.float32),
                    sr,
                )
                sf.write(
                    os.path.join(session, f"harmonic_{i:02d}.wav"),
                    np.full((n, 2), 0.05, dtype=np.float32),
                    sr,
                )
                sf.write(
                    os.path.join(session, f"lead_{i:02d}.wav"),
                    np.zeros((n, 2), dtype=np.float32),
                    sr,
                )
                sf.write(
                    os.path.join(session, f"bass_{i:02d}.wav"),
                    np.full((n, 2), 0.08, dtype=np.float32),
                    sr,
                )
                sf.write(
                    os.path.join(session, f"vocal_{i:02d}.wav"),
                    np.full((n, 2), 0.04, dtype=np.float32),
                    sr,
                )
            blueprint = {
                "track_metadata": {"bpm": 120},
                "sections": [
                    {
                        "name": "intro",
                        "slice_count": 2,
                        "volume_weights": {"rhythm": 0.5, "harmonic": 0.5, "lead": 0.2, "vocal": 0.3},
                    },
                    {
                        "name": "chorus",
                        "slice_count": 4,
                        "volume_weights": {"rhythm": 0.9, "harmonic": 0.7, "lead": 0.4, "vocal": 0.5},
                    },
                ],
            }
            bp_path = os.path.join(tmp, "bp.json")
            out_path = os.path.join(tmp, "mix.wav")
            with open(bp_path, "w", encoding="utf-8") as handle:
                json.dump(blueprint, handle)
            trace: dict = {}
            assemble_from_blueprint(bp_path, session, out_path, sr=sr, seed=1, source_trace=trace)
            self.assertEqual(trace["intro"]["rhythm"], trace["chorus"]["rhythm"])
            self.assertEqual(trace["intro"]["bass"], trace["chorus"]["bass"])
            self.assertEqual(trace["_track"]["rhythm"], trace["intro"]["rhythm"])
            self.assertEqual(
                sf.read(out_path)[0].shape[0],
                samples_for_bars(6, 120, sr),
            )

    def test_vocal_cut_is_zc_or_silence(self):
        sr = 8000
        hz = 100.0
        t = np.arange(sr) / sr
        sine = np.sin(2.0 * np.pi * hz * t)
        target = 20
        cut = snap_cut_to_zc_or_silence(sine, target, sr)
        self.assertLess(abs(float(sine[cut])), 0.05)
        self.assertLessEqual(abs(cut - target), int(sr * 0.015) + 1)
        stereo = np.stack([sine, sine], axis=1)
        cut_st = snap_cut_to_zc_or_silence(stereo, target, sr)
        self.assertLess(abs(float(stereo[cut_st, 0])), 0.05)
        junc = junction_zero_crossing(stereo, target, sr)
        self.assertLess(abs(float(stereo[junc, 0])), 0.05)
        self.assertEqual(stereo.shape[1], 2)

        tone = 0.5 * np.sin(2.0 * np.pi * 200.0 * np.arange(int(0.3 * sr)) / sr)
        gap = np.zeros(2000)
        buf = np.concatenate([tone, gap, tone])
        target_s = len(tone) + 1000
        cut_s = snap_cut_to_zc_or_silence(buf, target_s, sr)
        self.assertLess(abs(float(buf[cut_s])), 1e-6)
        self.assertGreaterEqual(cut_s, len(tone))
        self.assertLess(cut_s, len(tone) + 2000)


if __name__ == "__main__":
    unittest.main()
