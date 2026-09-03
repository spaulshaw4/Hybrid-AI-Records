import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.slice_rotator import (  # noqa: E402
    SliceIndexMissingError,
    init_rotation_schema,
    mark_slices_used,
    query_rotated_bank,
    query_rotated_slices,
)


SLICE_INDEX_DDL = """
CREATE TABLE slice_index (
    id INTEGER PRIMARY KEY,
    file_path TEXT UNIQUE,
    filename TEXT,
    stem_type TEXT,
    detected_key TEXT,
    estimated_bpm REAL,
    rms_db REAL,
    spectral_centroid REAL,
    tags TEXT,
    duration_sec REAL
)
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute(SLICE_INDEX_DDL)
    return conn


def _insert(conn: sqlite3.Connection, path: str, stem: str, key: str, tags: str) -> None:
    conn.execute(
        "INSERT INTO slice_index (file_path, filename, stem_type, detected_key, tags) "
        "VALUES (?, ?, ?, ?, ?)",
        (path, os.path.basename(path), stem, key, tags),
    )
    conn.commit()


class TestSliceRotator(unittest.TestCase):
    def test_missing_slice_index_raises(self):
        conn = sqlite3.connect(":memory:")
        try:
            with self.assertRaises(SliceIndexMissingError):
                init_rotation_schema(conn)
            with self.assertRaises(SliceIndexMissingError):
                query_rotated_slices(conn, ["kick"], "A")
        finally:
            conn.close()

    def test_insert_and_empty_tags_are_stem_or_all(self):
        conn = _connect()
        try:
            _insert(conn, r"C:\a\kick_loop.wav", "rhythm", "E", "kick drums punchy")
            _insert(conn, r"C:\a\pad_soft.wav", "harmonic", "A", "pad harmonic drone")
            init_rotation_schema(conn)
            all_hits = query_rotated_slices(conn, [], "A", limit=8)
            self.assertEqual(set(all_hits), {r"C:\a\kick_loop.wav", r"C:\a\pad_soft.wav"})
            rhythm = query_rotated_slices(conn, [], "A", limit=8, stem_type="rhythm")
            self.assertEqual(rhythm, [r"C:\a\kick_loop.wav"])
            tagged = query_rotated_slices(conn, ["kick"], "E", limit=4, stem_type="rhythm")
            self.assertEqual(tagged, [r"C:\a\kick_loop.wav"])
        finally:
            conn.close()

    def test_mark_used_inserts_and_increments(self):
        conn = _connect()
        try:
            path = r"C:\a\kick_loop.wav"
            _insert(conn, path, "rhythm", "E", "kick drums")
            init_rotation_schema(conn)
            self.assertEqual(mark_slices_used(conn, [path]), 1)
            row = conn.execute(
                "SELECT last_used, use_count FROM slice_history WHERE file_path = ?",
                (path,),
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(int(row[1]), 1)
            first_stamp = row[0]
            mark_slices_used(conn, [path])
            row2 = conn.execute(
                "SELECT last_used, use_count FROM slice_history WHERE file_path = ?",
                (path,),
            ).fetchone()
            self.assertEqual(int(row2[1]), 2)
            self.assertGreaterEqual(str(row2[0]), str(first_stamp))
        finally:
            conn.close()

    def test_cooldown_skips_recent_when_pool_has_spare(self):
        conn = _connect()
        try:
            fresh = r"C:\pool\fresh_kick.wav"
            stale = r"C:\pool\stale_kick.wav"
            _insert(conn, fresh, "rhythm", "A", "kick drums")
            _insert(conn, stale, "rhythm", "A", "kick drums")
            init_rotation_schema(conn)
            recent = datetime.now(timezone.utc)
            mark_slices_used(conn, [stale], used_at=recent)
            hits = query_rotated_slices(
                conn, ["kick"], "A", limit=1, stem_type="rhythm", cooldown_hours=6
            )
            self.assertEqual(hits, [fresh])
        finally:
            conn.close()

    def test_fallback_when_cooldown_starves_the_bank(self):
        conn = _connect()
        try:
            only = r"C:\pool\only_kick.wav"
            _insert(conn, only, "rhythm", "A", "kick drums")
            init_rotation_schema(conn)
            mark_slices_used(conn, [only], used_at=datetime.now(timezone.utc))
            hits = query_rotated_slices(
                conn, ["kick"], "A", limit=1, stem_type="rhythm", cooldown_hours=6
            )
            self.assertEqual(hits, [only])
        finally:
            conn.close()

    def test_old_history_is_eligible_again(self):
        conn = _connect()
        try:
            path = r"C:\pool\aged_kick.wav"
            other = r"C:\pool\other_kick.wav"
            _insert(conn, path, "rhythm", "A", "kick drums")
            _insert(conn, other, "rhythm", "A", "kick drums")
            init_rotation_schema(conn)
            aged = datetime.now(timezone.utc) - timedelta(hours=8)
            mark_slices_used(conn, [path], used_at=aged)
            hits = query_rotated_slices(
                conn, [], "A", limit=8, stem_type="rhythm", cooldown_hours=6
            )
            self.assertIn(path, hits)
            self.assertIn(other, hits)
        finally:
            conn.close()

    def test_query_rotated_bank_missing_db_is_empty(self):
        self.assertEqual(
            query_rotated_bank(r"Z:\missing\no.sqlite", ["drums"], "rhythm", "A"),
            [],
        )

    def test_query_rotated_bank_skips_missing_files_and_marks_existing(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = os.path.join(tmp, "kick_loop.wav")
            with open(real, "wb") as handle:
                handle.write(b"RIFF")
            ghost = os.path.join(tmp, "ghost_kick.wav")
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            conn = sqlite3.connect(db_path)
            try:
                conn.execute(SLICE_INDEX_DDL)
                _insert(conn, real, "rhythm", "A", "kick drums")
                _insert(conn, ghost, "rhythm", "A", "kick drums")
                init_rotation_schema(conn)
            finally:
                conn.close()
            hits = query_rotated_bank(db_path, ["kick"], "rhythm", "A", limit=8)
            self.assertEqual(hits, [real])
            check = sqlite3.connect(db_path)
            try:
                row = check.execute(
                    "SELECT use_count FROM slice_history WHERE file_path = ?",
                    (real,),
                ).fetchone()
            finally:
                check.close()
    def test_query_rotated_bank_degrades_to_stem_when_tags_miss(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = os.path.join(tmp, "bass_loop.wav")
            with open(real, "wb") as handle:
                handle.write(b"RIFF")
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            conn = sqlite3.connect(db_path)
            try:
                conn.execute(SLICE_INDEX_DDL)
                _insert(conn, real, "harmonic", "A", "animal bass clinic s4")
                init_rotation_schema(conn)
            finally:
                conn.close()
            hits = query_rotated_bank(
                db_path, ["guitar", "distorted"], "harmonic", "D", limit=8
            )
            self.assertEqual(hits, [real])

    def test_query_rotated_bank_routes_empty_lead_to_harmonic(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = os.path.join(tmp, "pad.wav")
            with open(real, "wb") as handle:
                handle.write(b"RIFF")
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            conn = sqlite3.connect(db_path)
            try:
                conn.execute(SLICE_INDEX_DDL)
                _insert(conn, real, "harmonic", "D", "bass clinic")
                init_rotation_schema(conn)
            finally:
                conn.close()
            hits = query_rotated_bank(db_path, ["lead", "pluck"], "lead", "D", limit=4)
            self.assertEqual(hits, [real])
