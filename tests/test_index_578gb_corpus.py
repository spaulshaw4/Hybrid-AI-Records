import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np
import soundfile as sf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

import db.index_578gb_corpus as indexer  # noqa: E402
from db.index_578gb_corpus import (  # noqa: E402
    DEFAULT_DB,
    DEFAULT_WORKERS,
    LEGACY_DB,
    analyze_single_slice,
    assert_safe_corpus,
    batch_index_corpus,
    default_index_db,
    infer_stem_type,
    main as index_main,
)
from db.sample_indexer import query_corpus_slices  # noqa: E402


def _write_tone(path: str, sr: int = 8000, hz: float = 220.0, seconds: float = 0.25) -> None:
    t = np.linspace(0, seconds, int(seconds * sr), endpoint=False)
    sig = (0.25 * np.sin(2 * np.pi * hz * t)).astype(np.float32)
    sf.write(path, np.stack([sig, sig], axis=1), sr)


class TestIndex578GbCorpus(unittest.TestCase):
    def test_infer_stem_type(self):
        self.assertEqual(infer_stem_type(r"d:\packs\drums\kick_loop.wav"), "rhythm")
        self.assertEqual(infer_stem_type(r"d:\packs\leads\pluck_arp.wav"), "lead")
        self.assertEqual(infer_stem_type(r"d:\packs\vox\vocal_chop.wav"), "vocal")
        self.assertEqual(infer_stem_type(r"d:\packs\pads\warm_pad.wav"), "harmonic")

    def test_analyze_and_sequential_batch(self):
        with tempfile.TemporaryDirectory() as tmp:
            corpus = os.path.join(tmp, "corpus")
            os.makedirs(os.path.join(corpus, "drums"))
            os.makedirs(os.path.join(corpus, "pads"))
            kick = os.path.join(corpus, "drums", "kick_loop.wav")
            pad = os.path.join(corpus, "pads", "dark_pad.wav")
            lead = os.path.join(corpus, "lead_pluck.wav")
            _write_tone(kick, hz=80.0)
            _write_tone(pad, hz=220.0)
            _write_tone(lead, hz=440.0)
            row = analyze_single_slice(kick)
            self.assertIsNotNone(row)
            assert row is not None
            self.assertEqual(row["stem_type"], "rhythm")
            self.assertIn("kick", row["tags"])
            self.assertIsInstance(row["rms_db"], float)
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            count = batch_index_corpus(corpus, db_path, max_workers=1, limit=3, sequential=True)
            self.assertEqual(count, 3)
            conn = sqlite3.connect(db_path)
            try:
                cols = {info[1] for info in conn.execute("PRAGMA table_info(slice_index)")}
                for name in (
                    "file_path",
                    "filename",
                    "stem_type",
                    "detected_key",
                    "estimated_bpm",
                    "rms_db",
                    "spectral_centroid",
                    "tags",
                    "duration_sec",
                    "stem_type_ml",
                    "stem_type_ml_confidence",
                ):
                    self.assertIn(name, cols)
                hits = query_corpus_slices(conn, ["kick"], "A", limit=8)
                self.assertTrue(any("kick" in path.lower() for path in hits))
            finally:
                conn.close()

    def test_limit_required_without_full(self):
        self.assertEqual(index_main([]), 2)

    def test_workers_default_is_eight(self):
        self.assertEqual(DEFAULT_WORKERS, 8)

    def test_refuse_uploaded_slices(self):
        with self.assertRaises(ValueError):
            batch_index_corpus(
                r"D:\MusicDatasets\uploaded_slices",
                os.path.join(tempfile.gettempdir(), "no.sqlite"),
                limit=1,
                sequential=True,
            )
        with self.assertRaises(ValueError):
            assert_safe_corpus(r"D:\MusicDatasets\uploaded_slices\rock")


class TestDefaultIndexDbPreference(unittest.TestCase):
    """db\\corpus_index.sqlite is the real index; database\\ is the legacy 25-row file."""

    def test_documented_defaults(self):
        self.assertTrue(DEFAULT_DB.lower().endswith(r"\db\corpus_index.sqlite"))
        self.assertTrue(LEGACY_DB.lower().endswith(r"\database\corpus_index.sqlite"))
        self.assertEqual(indexer.DB_PREFERENCE, (DEFAULT_DB, LEGACY_DB))
        self.assertEqual(indexer.ALT_DB, LEGACY_DB)

    def _patched(self, tmp: str):
        preferred = os.path.join(tmp, "db", "corpus_index.sqlite")
        legacy = os.path.join(tmp, "database", "corpus_index.sqlite")
        os.makedirs(os.path.dirname(preferred), exist_ok=True)
        os.makedirs(os.path.dirname(legacy), exist_ok=True)
        patch = mock.patch.multiple(
            indexer,
            DEFAULT_DB=preferred,
            LEGACY_DB=legacy,
            ALT_DB=legacy,
            DB_PREFERENCE=(preferred, legacy),
        )
        return preferred, legacy, patch

    def test_prefers_db_over_legacy_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            preferred, legacy, patch = self._patched(tmp)
            for path in (preferred, legacy):
                open(path, "wb").close()
            with mock.patch.dict(os.environ, {}, clear=False), patch:
                os.environ.pop("CORPUS_INDEX_DB", None)
                self.assertEqual(default_index_db(), preferred)

    def test_falls_back_to_legacy_when_only_database_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            _preferred, legacy, patch = self._patched(tmp)
            open(legacy, "wb").close()
            with mock.patch.dict(os.environ, {}, clear=False), patch:
                os.environ.pop("CORPUS_INDEX_DB", None)
                self.assertEqual(default_index_db(), legacy)

    def test_returns_preferred_when_neither_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            preferred, _legacy, patch = self._patched(tmp)
            with mock.patch.dict(os.environ, {}, clear=False), patch:
                os.environ.pop("CORPUS_INDEX_DB", None)
                self.assertEqual(default_index_db(), preferred)

    def test_env_override_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            preferred, legacy, patch = self._patched(tmp)
            open(preferred, "wb").close()
            override = os.path.join(tmp, "explicit.sqlite")
            with mock.patch.dict(os.environ, {"CORPUS_INDEX_DB": override}), patch:
                self.assertEqual(default_index_db(), override)
            self.assertNotEqual(preferred, legacy)


if __name__ == "__main__":
    unittest.main()
