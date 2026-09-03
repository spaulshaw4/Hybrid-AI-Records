"""Track-level split: no slice of the same song on both sides."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from ml.dataset_manifest import (  # noqa: E402
    build_manifest,
    normalize_track_id,
    parse_slice,
)
from ml.split import LeakageError, assert_no_leakage, group_folds, group_split  # noqa: E402


class TestNormalizeTrackId(unittest.TestCase):
    def test_collapses_musdb_and_dsd_spellings(self):
        musdb = normalize_track_id("001 - ANiMAL - Clinic A")
        dsd = normalize_track_id("001_animal_clinic_a")
        self.assertEqual(musdb, dsd)
        self.assertEqual(musdb, "001animalclinica")


class TestParseSlice(unittest.TestCase):
    def test_musdb_layout(self):
        rec = parse_slice(
            r"D:\MusicDatasets\corpus_4s",
            r"D:\MusicDatasets\corpus_4s\001 - ANiMAL - Clinic A",
            "drums_s4_00002.wav",
        )
        self.assertIsNotNone(rec)
        assert rec is not None
        self.assertEqual(rec.label, "drums")
        self.assertEqual(rec.source, "musdb")
        self.assertEqual(rec.track_id, normalize_track_id("001 - ANiMAL - Clinic A"))

    def test_dsd100_flat_layout(self):
        rec = parse_slice(
            r"D:\MusicDatasets\corpus_4s",
            r"D:\MusicDatasets\corpus_4s\dsd100",
            "001_animal_clinic_a__bass_s00002.wav",
        )
        self.assertIsNotNone(rec)
        assert rec is not None
        self.assertEqual(rec.label, "bass")
        self.assertEqual(rec.source, "dsd100")
        self.assertEqual(rec.track_id, normalize_track_id("001_animal_clinic_a"))

    def test_rejects_unlabeled_and_mixture(self):
        root = r"D:\MusicDatasets\corpus_4s"
        d = os.path.join(root, "some_track")
        self.assertIsNone(parse_slice(root, d, "kick_loop.wav"))
        rec = parse_slice(root, d, "mixture_s4_00000.wav")
        self.assertIsNotNone(rec)
        assert rec is not None
        self.assertEqual(rec.label, "mixture")


class TestGroupSplit(unittest.TestCase):
    def test_no_group_on_both_sides(self):
        groups = np.array(
            ["song_a", "song_a", "song_b", "song_b", "song_c", "song_c", "song_d"]
        )
        train_idx, val_idx = group_split(groups, val_fraction=0.25, seed=7)
        assert_no_leakage(groups, train_idx, val_idx)
        self.assertTrue(set(train_idx).isdisjoint(set(val_idx)))
        self.assertEqual(len(train_idx) + len(val_idx), len(groups))

    def test_assert_no_leakage_raises(self):
        groups = np.array(["a", "a", "b", "b"])
        with self.assertRaises(LeakageError):
            assert_no_leakage(groups, np.array([0, 2]), np.array([1, 3]))

    def test_folds_are_leakage_free(self):
        groups = np.array(["g0"] * 3 + ["g1"] * 3 + ["g2"] * 3 + ["g3"] * 3)
        folds = group_folds(groups, n_folds=4, seed=1)
        self.assertEqual(len(folds), 4)
        for train_idx, val_idx in folds:
            assert_no_leakage(groups, train_idx, val_idx)

    def test_musdb_and_dsd_slices_stay_together(self):
        """Walk a fake corpus: same song in both trees must share a group."""
        with tempfile.TemporaryDirectory() as tmp:
            musdb_dir = os.path.join(tmp, "001 - ANiMAL - Clinic A")
            dsd_dir = os.path.join(tmp, "dsd100")
            os.makedirs(musdb_dir)
            os.makedirs(dsd_dir)
            other = os.path.join(tmp, "002 - Other Track")
            os.makedirs(other)
            sr = 8000
            tone = (0.1 * np.sin(2 * np.pi * 110 * np.linspace(0, 0.2, int(0.2 * sr)))).astype(
                np.float32
            )
            files = [
                (musdb_dir, "drums_s4_00000.wav"),
                (musdb_dir, "bass_s4_00000.wav"),
                (dsd_dir, "001_animal_clinic_a__vocals_s00000.wav"),
                (other, "other_s4_00000.wav"),
                (other, "drums_s4_00001.wav"),
            ]
            for folder, name in files:
                sf.write(os.path.join(folder, name), tone, sr)
            records = build_manifest(root=tmp)
            self.assertEqual(len(records), 5)
            animal_recs = [
                r
                for r in records
                if "animal" in r.path.lower()
                or os.path.basename(os.path.dirname(r.path)).startswith("001")
            ]
            ids = {r.track_id for r in animal_recs}
            self.assertEqual(len(ids), 1, msg=ids)
            groups = np.array([r.track_id for r in records])
            train_idx, val_idx = group_split(groups, val_fraction=0.5, seed=3)
            assert_no_leakage(groups, train_idx, val_idx)
            animal_id = next(iter(ids))
            sides = set()
            for i, gid in enumerate(groups):
                if gid == animal_id:
                    sides.add("val" if i in set(val_idx.tolist()) else "train")
            self.assertEqual(len(sides), 1, "animal slices leaked across the split")


if __name__ == "__main__":
    unittest.main()
