"""ML stem columns, flagged backfill, and a non-fake numpy fallback."""
from __future__ import annotations

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

from db.index_578gb_corpus import (  # noqa: E402
    INSERT_SQL,
    ensure_ml_columns,
    init_db,
)
from engine.train_stem_classifier import (  # noqa: E402
    backfill_stem_type_ml,
    confusion,
    fit_classifier,
    main as train_main,
    sklearn_available,
)
from ml.boosted_trees import NumpyBoostedTrees  # noqa: E402


def _tone(path: str, hz: float, sr: int = 8000, seconds: float = 0.25) -> None:
    t = np.linspace(0, seconds, int(seconds * sr), endpoint=False)
    sig = (0.25 * np.sin(2 * np.pi * hz * t)).astype(np.float32)
    sf.write(path, np.stack([sig, sig], axis=1), sr)


class TestSklearnProbe(unittest.TestCase):
    def test_sklearn_available_on_this_workstation(self):
        ok, info = sklearn_available()
        self.assertTrue(ok, msg=f"sklearn missing: {info}")
        self.assertTrue(info)


class TestNumpyFallbackNotFake(unittest.TestCase):
    def test_learns_separable_blobs_and_not_perfect_on_overlap(self):
        rng = np.random.default_rng(0)
        n, d = 120, 8
        a = rng.normal(0.0, 0.4, size=(n, d))
        b = rng.normal(3.0, 0.4, size=(n, d))
        X = np.vstack([a, b])
        y = np.array(["drums"] * n + ["bass"] * n)
        model = NumpyBoostedTrees(n_estimators=25, learning_rate=0.2, seed=1)
        model.fit(X, y)
        acc_sep = float(np.mean(model.predict(X) == y))
        self.assertGreater(acc_sep, 0.9)

        overlap_a = rng.normal(0.0, 1.2, size=(80, d))
        overlap_b = rng.normal(0.25, 1.2, size=(80, d))
        Xo = np.vstack([overlap_a, overlap_b])
        yo = np.array(["drums"] * 80 + ["bass"] * 80)
        perm = rng.permutation(len(Xo))
        train, val = perm[:120], perm[120:]
        model2 = NumpyBoostedTrees(n_estimators=20, learning_rate=0.15, seed=2)
        model2.fit(Xo[train], yo[train])
        acc_val = float(np.mean(model2.predict(Xo[val]) == yo[val]))
        self.assertLess(acc_val, 1.0)
        self.assertGreater(acc_val, 0.35)

    def test_fit_classifier_fallback_api(self):
        rng = np.random.default_rng(4)
        X = np.vstack(
            [rng.normal(0, 0.3, (40, 6)), rng.normal(2.5, 0.3, (40, 6))]
        )
        y = np.array(["other"] * 40 + ["vocals"] * 40)
        model, backend, n_iter = fit_classifier(X, y, seed=0, force_fallback=True)
        self.assertIn("numpy", backend.lower())
        self.assertGreater(n_iter, 0)
        pred = model.predict(X)
        self.assertEqual(pred.shape[0], len(y))
        proba = model.predict_proba(X)
        self.assertEqual(proba.shape[1], 2)
        np.testing.assert_allclose(proba.sum(axis=1), 1.0, atol=1e-5)


class TestConfusion(unittest.TestCase):
    def test_matrix_shape_and_accuracy_inputs(self):
        labels = ["drums", "bass"]
        y_true = np.array(["drums", "drums", "bass", "bass"])
        y_pred = np.array(["drums", "bass", "bass", "bass"])
        mat = confusion(y_true, y_pred, labels)
        self.assertEqual(mat.tolist(), [[1, 1], [0, 2]])


class TestMlColumnsAndBackfill(unittest.TestCase):
    def test_init_db_adds_ml_columns_and_wal(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "corpus_index.sqlite")
            conn = init_db(db)
            try:
                cols = {row[1] for row in conn.execute("PRAGMA table_info(slice_index)")}
                self.assertIn("stem_type_ml", cols)
                self.assertIn("stem_type_ml_confidence", cols)
                self.assertIn("stem_type", cols)
                mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
                self.assertEqual(str(mode).lower(), "wal")
            finally:
                conn.close()

    def test_ensure_ml_columns_on_legacy_table(self):
        conn = sqlite3.connect(":memory:")
        try:
            conn.execute(
                "CREATE TABLE slice_index ("
                "id INTEGER PRIMARY KEY, file_path TEXT UNIQUE, filename TEXT, "
                "stem_type TEXT, detected_key TEXT, estimated_bpm REAL, "
                "rms_db REAL, spectral_centroid REAL, tags TEXT, duration_sec REAL)"
            )
            conn.execute(
                "INSERT INTO slice_index (file_path, filename, stem_type) "
                "VALUES ('a.wav', 'a.wav', 'rhythm')"
            )
            ensure_ml_columns(conn)
            cols = {row[1] for row in conn.execute("PRAGMA table_info(slice_index)")}
            self.assertIn("stem_type_ml", cols)
            stem = conn.execute("SELECT stem_type FROM slice_index").fetchone()[0]
            self.assertEqual(stem, "rhythm")
        finally:
            conn.close()

    def test_upsert_preserves_ml_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "idx.sqlite")
            conn = init_db(db)
            try:
                path = os.path.join(tmp, "kick.wav")
                conn.execute(
                    INSERT_SQL,
                    (path, "kick.wav", "rhythm", "A", 120.0, -20.0, 400.0, "kick", 0.25),
                )
                conn.execute(
                    "UPDATE slice_index SET stem_type_ml = ?, stem_type_ml_confidence = ? "
                    "WHERE file_path = ?",
                    ("drums", 0.91, path),
                )
                conn.execute(
                    INSERT_SQL,
                    (path, "kick.wav", "harmonic", "C", 100.0, -18.0, 500.0, "kick", 0.25),
                )
                row = conn.execute(
                    "SELECT stem_type, stem_type_ml, stem_type_ml_confidence "
                    "FROM slice_index WHERE file_path = ?",
                    (path,),
                ).fetchone()
                self.assertEqual(row[0], "harmonic")
                self.assertEqual(row[1], "drums")
                self.assertAlmostEqual(row[2], 0.91, places=5)
            finally:
                conn.close()

    def test_backfill_does_not_overwrite_stem_type(self):
        with tempfile.TemporaryDirectory() as tmp:
            wav = os.path.join(tmp, "bass_s4_00000.wav")
            _tone(wav, hz=55.0, sr=8000, seconds=0.3)

            db = os.path.join(tmp, "idx.sqlite")
            conn = init_db(db)
            try:
                conn.execute(
                    INSERT_SQL,
                    (wav, "bass_s4_00000.wav", "harmonic", "A", 120.0, -16.0, 200.0, "bass", 0.4),
                )
                conn.commit()
            finally:
                conn.close()

            class FakePred:
                role = "bass"
                confidence = 0.77

            class Stub:
                def __init__(self, model_path: str):
                    self.model_path = model_path

                def predict_file(self, path: str):
                    return FakePred()

            model_path = os.path.join(tmp, "dummy.joblib")
            open(model_path, "wb").write(b"x")
            with mock.patch("ml.stem_classifier.StemClassifier", Stub):
                result = backfill_stem_type_ml(
                    db, model_path=model_path, limit=10, only_unlabeled=True
                )
            self.assertEqual(result["updated"], 1)
            self.assertEqual(result["stem_type_unchanged"], 1)
            conn = sqlite3.connect(db)
            try:
                stem, ml_lab, conf = conn.execute(
                    "SELECT stem_type, stem_type_ml, stem_type_ml_confidence "
                    "FROM slice_index"
                ).fetchone()
            finally:
                conn.close()
            self.assertEqual(stem, "harmonic")
            self.assertEqual(ml_lab, "bass")
            self.assertAlmostEqual(float(conf), 0.77, places=5)

    def test_cli_without_ml_backfill_flag_does_not_write_db(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "idx.sqlite")
            conn = init_db(db)
            conn.close()
            rc = train_main(["--skip-train"])
            self.assertEqual(rc, 2)
            conn = sqlite3.connect(db)
            try:
                n = conn.execute(
                    "SELECT COUNT(*) FROM slice_index WHERE stem_type_ml IS NOT NULL"
                ).fetchone()[0]
            finally:
                conn.close()
            self.assertEqual(n, 0)


if __name__ == "__main__":
    unittest.main()
