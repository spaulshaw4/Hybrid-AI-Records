import os
import sqlite3
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from db.index_578gb_corpus import assert_safe_corpus, init_db  # noqa: E402
from db.sample_indexer import (  # noqa: E402
    index_directory,
    query_corpus_slices,
    resolve_corpus_bank,
)


class TestSampleIndexer(unittest.TestCase):
    def test_empty_table_returns_empty_list(self):
        conn = sqlite3.connect(":memory:")
        try:
            conn.executescript(
                "CREATE TABLE slice_index ("
                "id INTEGER PRIMARY KEY, file_path TEXT UNIQUE, filename TEXT, "
                "stem_type TEXT, detected_key TEXT, estimated_bpm REAL, "
                "rms_db REAL, spectral_centroid REAL, tags TEXT, duration_sec REAL)"
            )
            self.assertEqual(query_corpus_slices(conn, [], "A"), [])
            self.assertEqual(query_corpus_slices(conn, ["drums", "kick"], "A"), [])
        finally:
            conn.close()

    def test_missing_table_returns_empty(self):
        conn = sqlite3.connect(":memory:")
        try:
            self.assertEqual(query_corpus_slices(conn, ["pad"], "C"), [])
        finally:
            conn.close()

    def test_parameterized_like_and_key_prefer(self):
        conn = sqlite3.connect(":memory:")
        try:
            conn.execute(
                "CREATE TABLE slice_index ("
                "id INTEGER PRIMARY KEY, file_path TEXT UNIQUE, filename TEXT, "
                "stem_type TEXT, detected_key TEXT, estimated_bpm REAL, "
                "rms_db REAL, spectral_centroid REAL, tags TEXT, duration_sec REAL)"
            )
            conn.execute(
                "INSERT INTO slice_index (file_path, filename, stem_type, detected_key, tags) "
                "VALUES (?, ?, ?, ?, ?)",
                (r"C:\a\kick_loop.wav", "kick_loop.wav", "rhythm", "E", "kick drums punchy"),
            )
            conn.execute(
                "INSERT INTO slice_index (file_path, filename, stem_type, detected_key, tags) "
                "VALUES (?, ?, ?, ?, ?)",
                (r"C:\a\pad_soft.wav", "pad_soft.wav", "harmonic", "A", "pad harmonic drone"),
            )
            hits = query_corpus_slices(conn, ["kick"], "E", limit=4, stem_type="rhythm")
            self.assertEqual(hits, [r"C:\a\kick_loop.wav"])
            none = query_corpus_slices(conn, ["kick"], "E", limit=4, stem_type="vocal")
            self.assertEqual(none, [])
        finally:
            conn.close()

    def test_index_directory_from_filenames(self):
        sr = 8000
        with tempfile.TemporaryDirectory() as tmp:
            corpus = os.path.join(tmp, "corpus")
            os.makedirs(os.path.join(corpus, "drums"))
            t = np.linspace(0, 0.2, int(0.2 * sr), endpoint=False)
            sig = (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
            stereo = np.stack([sig, sig], axis=1)
            sf.write(os.path.join(corpus, "drums", "kick_loop.wav"), stereo, sr)
            sf.write(os.path.join(corpus, "pad_drone.wav"), stereo, sr)
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            count = index_directory(corpus, db_path, limit=10, analyze_audio=False)
            self.assertGreaterEqual(count, 2)
            conn = sqlite3.connect(db_path)
            try:
                hits = query_corpus_slices(conn, ["kick"], "A", limit=8)
            finally:
                conn.close()
            self.assertTrue(any("kick" in path.lower() for path in hits))

    def test_refuse_uploaded_slices(self):
        with self.assertRaises(ValueError):
            assert_safe_corpus(r"D:\MusicDatasets\uploaded_slices\alt_rock")

    def test_resolve_missing_db(self):
        self.assertEqual(resolve_corpus_bank(r"Z:\missing\no.sqlite", ["drums"], "rhythm", "A"), [])

    def test_resolve_degrades_to_stem_type_when_tags_miss(self):
        with tempfile.TemporaryDirectory() as tmp:
            wav = os.path.join(tmp, "bass_s4_00001.wav")
            t = np.linspace(0, 0.1, 800, endpoint=False)
            sig = (0.2 * np.sin(2 * np.pi * 110 * t)).astype(np.float32)
            sf.write(wav, np.stack([sig, sig], axis=1), 8000)
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            conn = sqlite3.connect(db_path)
            try:
                conn.execute(
                    "CREATE TABLE slice_index ("
                    "id INTEGER PRIMARY KEY, file_path TEXT UNIQUE, filename TEXT, "
                    "stem_type TEXT, detected_key TEXT, estimated_bpm REAL, "
                    "rms_db REAL, spectral_centroid REAL, tags TEXT, duration_sec REAL)"
                )
                conn.execute(
                    "INSERT INTO slice_index (file_path, filename, stem_type, detected_key, tags) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (wav, "bass_s4_00001.wav", "harmonic", "A", "animal bass clinic s4"),
                )
                conn.commit()
            finally:
                conn.close()
            hits = resolve_corpus_bank(db_path, ["guitar", "distorted"], "harmonic", "D")
            self.assertEqual(hits, [wav])
            empty_tags = resolve_corpus_bank(db_path, [], "harmonic", "D")
            self.assertEqual(empty_tags, [wav])


if __name__ == "__main__":
    unittest.main()
