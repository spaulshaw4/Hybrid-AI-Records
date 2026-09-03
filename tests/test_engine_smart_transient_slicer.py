import os
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dsp.smart_transient_slicer import RawSourceError  # noqa: E402
from engine.smart_transient_slicer import (  # noqa: E402
    DriveRootError,
    assert_engine_source,
    assert_not_drive_root,
    DEFAULT_WORKERS,
    layer_output_dir,
    main as slicer_main,
    resample_to_sr,
    resolve_worker_count,
    run_multiprocess_slicing,
    slice_engine_batch,
    slice_one_source,
)


def _tone(path: str, sr: int = 8000, seconds: float = 8.0, hz: float = 110.0) -> None:
    t = np.arange(int(seconds * sr), dtype=np.float64) / sr
    sig = (0.35 * np.sin(2.0 * np.pi * hz * t)).astype(np.float32)
    sf.write(path, np.stack([sig, sig], axis=1), sr)


class TestEngineSmartTransientSlicer(unittest.TestCase):
    def test_layer_routing_matches_indexer_keywords(self):
        root = r"D:\out"
        self.assertTrue(layer_output_dir(root, r"d:\packs\drums\kick_loop.wav").endswith("rhythm"))
        self.assertTrue(layer_output_dir(root, r"d:\packs\leads\pluck_arp.wav").endswith("lead"))
        self.assertTrue(layer_output_dir(root, r"d:\packs\vox\vocal_chop.wav").endswith("vocal"))
        self.assertTrue(layer_output_dir(root, r"d:\packs\pads\warm_pad.wav").endswith("harmonic"))

    def test_refuses_uploaded_slices_and_corpus_4s(self):
        with self.assertRaises(RawSourceError):
            assert_engine_source(r"D:\MusicDatasets\uploaded_slices", [], allow=False)
        with self.assertRaises(RawSourceError):
            assert_engine_source(r"D:\MusicDatasets\corpus_4s", [], allow=False)
        assert_engine_source(r"D:\MusicDatasets\corpus_4s", [], allow=True)

    def test_dry_run_and_write_route_to_layer_folders(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw = os.path.join(tmp, "raw_packs")
            drums = os.path.join(raw, "drums")
            os.makedirs(drums)
            src = os.path.join(drums, "kick_loop.wav")
            _tone(src, sr=8000, seconds=8.0, hz=80.0)
            out = os.path.join(tmp, "corpus_4s")
            dry = slice_engine_batch(raw, out, target_sr=8000, dry_run=True, limit=1)
            self.assertGreaterEqual(dry["would_write"], 1)
            self.assertEqual(dry["written"], 0)
            self.assertFalse(os.path.isdir(os.path.join(out, "rhythm")))
            written = slice_engine_batch(raw, out, target_sr=8000, dry_run=False, limit=1)
            self.assertGreaterEqual(written["written"], 1)
            self.assertGreaterEqual(written["by_layer"]["rhythm"], 1)
            self.assertTrue(os.path.isdir(os.path.join(out, "rhythm")))
            self.assertTrue(any(name.endswith(".wav") for name in os.listdir(os.path.join(out, "rhythm"))))

    def test_resample_without_librosa(self):
        sr = 8000
        t = np.arange(int(0.2 * sr), dtype=np.float64) / sr
        sig = np.sin(2.0 * np.pi * 220.0 * t)
        stereo = np.column_stack((sig, sig))
        out = resample_to_sr(stereo, sr, 16000)
        self.assertEqual(out.shape[1], 2)
        self.assertGreater(out.shape[0], stereo.shape[0] * 1.8)

    def test_cli_refuse_uploaded_slices(self):
        with tempfile.TemporaryDirectory() as tmp:
            dumped = os.path.join(tmp, "uploaded_slices")
            os.makedirs(dumped)
            _tone(os.path.join(dumped, "already_sliced.wav"), sr=8000, seconds=4.0)
            code = slicer_main(["--input", dumped, "--output", os.path.join(tmp, "no_corpus")])
            self.assertEqual(code, 2)

    def test_slice_one_source_does_not_write_on_dry_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "lead_pluck.wav")
            _tone(src, sr=8000, seconds=8.0, hz=330.0)
            out = os.path.join(tmp, "corpus_4s")
            result = slice_one_source(src, out, target_sr=8000, dry_run=True)
            self.assertEqual(result["layer"], "lead")
            self.assertEqual(result["written"], [])
            self.assertFalse(os.path.isdir(result["dest_dir"]))

    def test_refuses_workstation_root(self):
        with self.assertRaises(DriveRootError):
            assert_not_drive_root(r"D:\MusicDatasets")
        with self.assertRaises(DriveRootError):
            assert_not_drive_root("D:\\")
        code = slicer_main(["--input", r"D:\MusicDatasets", "--output", r"D:\MusicDatasets\corpus_4s"])
        self.assertEqual(code, 2)

    def test_default_workers_pin_is_eight(self):
        self.assertEqual(DEFAULT_WORKERS, 8)
        self.assertEqual(resolve_worker_count(16), 16)
        capped = resolve_worker_count(None)
        self.assertGreaterEqual(capped, 1)
        self.assertLessEqual(capped, 8)

    def test_multiprocess_slicing_sequential_file_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw = os.path.join(tmp, "raw_packs", "drums")
            os.makedirs(raw)
            src = os.path.join(raw, "kick_loop.wav")
            _tone(src, sr=8000, seconds=8.0, hz=80.0)
            out = os.path.join(tmp, "corpus_4s")
            summary = run_multiprocess_slicing([src], out, workers=1, target_sr=8000, dry_run=True)
            self.assertGreaterEqual(summary["would_write"], 1)
            self.assertEqual(summary["written"], 0)
            self.assertEqual(summary["workers"], 1)


if __name__ == "__main__":
    unittest.main()
