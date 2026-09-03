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
SCRIPTS = os.path.join(REPO, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from index_corpus_4s import register_corpus  # noqa: E402


def _tone(path: str) -> None:
    t = np.linspace(0, 0.2, 1600, endpoint=False)
    sig = (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    sf.write(path, np.stack([sig, sig], axis=1), 8000)


class TestIndexCorpus4s(unittest.TestCase):
    def test_registers_new_and_preserves_analyzed(self):
        with tempfile.TemporaryDirectory() as tmp:
            corpus = os.path.join(tmp, "corpus")
            os.makedirs(os.path.join(corpus, "drums"))
            old = os.path.join(corpus, "drums", "kick_loop.wav")
            new = os.path.join(corpus, "pad_warm.wav")
            _tone(old)
            _tone(new)
            db = os.path.join(tmp, "corpus_index.sqlite")
            conn = sqlite3.connect(db)
            conn.execute(
                "CREATE TABLE slice_index ("
                "id INTEGER PRIMARY KEY, file_path TEXT UNIQUE, filename TEXT, "
                "stem_type TEXT, detected_key TEXT, estimated_bpm REAL, "
                "rms_db REAL, spectral_centroid REAL, tags TEXT, duration_sec REAL, "
                "stem_type_ml TEXT, stem_type_ml_confidence REAL)"
            )
            conn.execute(
                "INSERT INTO slice_index "
                "(file_path, filename, stem_type, detected_key, estimated_bpm, "
                "rms_db, spectral_centroid, tags, duration_sec, stem_type_ml) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (old, "kick_loop.wav", "rhythm", "F", 90.0, -12.0, 200.0, "kick", 4.0, "kick"),
            )
            conn.commit()
            conn.close()

            summary = register_corpus(corpus, db, read_headers=False)
            self.assertEqual(summary["inserted"], 1)
            self.assertEqual(summary["total"], 2)

            conn = sqlite3.connect(db)
            old_row = conn.execute(
                "SELECT detected_key, estimated_bpm, stem_type_ml FROM slice_index WHERE file_path=?",
                (old,),
            ).fetchone()
            new_row = conn.execute(
                "SELECT stem_type, detected_key, tags FROM slice_index WHERE file_path=?",
                (new,),
            ).fetchone()
            conn.close()
            self.assertEqual(old_row, ("F", 90.0, "kick"))
            self.assertEqual(new_row[0], "harmonic")
            self.assertIsNone(new_row[1])
            self.assertIn("pad", new_row[2])

    def test_refuses_uploaded_slices(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "uploaded_slices")
            os.makedirs(bad)
            db = os.path.join(tmp, "db.sqlite")
            with self.assertRaises(ValueError):
                register_corpus(bad, db)


if __name__ == "__main__":
    unittest.main()
