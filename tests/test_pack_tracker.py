import os
import sqlite3
import sys
import tempfile
import unittest
import zipfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from db.pack_tracker import (  # noqa: E402
    advance_to_ready,
    advance_to_sliced,
    assert_safe_raw_packs,
    connect_corpus_db,
    extract_zip_to,
    get_pack,
    list_packs,
    main as tracker_main,
    pack_name_from_zip,
    process_incoming_zips,
    refused_zip_name,
)


def _write_zip(path: str, members: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)


def _open_pack(db_path: str, pack_name: str) -> dict:
    conn = connect_corpus_db(db_path)
    try:
        row = get_pack(conn, pack_name)
        return dict(row) if row else {}
    finally:
        conn.close()


class TestPackTracker(unittest.TestCase):
    def test_pack_name_spaces_and_hyphens(self):
        self.assertEqual(pack_name_from_zip("LANDR Sample Pack-Vol 1.zip"), "LANDR_Sample_Pack_Vol_1")
        self.assertEqual(pack_name_from_zip(r"C:\in\LANDR-20260830-011603.zip"), "LANDR_20260830_011603")

    def test_refuses_fma_full_name(self):
        self.assertTrue(refused_zip_name("fma_full.zip"))
        self.assertTrue(refused_zip_name("FMA_FULL.ZIP"))
        self.assertFalse(refused_zip_name("LANDR-20260830-011603.zip"))

    def test_dry_run_registers_pending_no_extract(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            incoming = os.path.join(tmp, "incoming_zips")
            raw = os.path.join(tmp, "raw_packs")
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            os.makedirs(incoming)
            zip_path = os.path.join(incoming, "LANDR Demo Pack.zip")
            _write_zip(zip_path, {"kick.wav": b"RIFF", "__MACOSX/foo": b"x"})
            summary = process_incoming_zips(incoming, raw, db_path, dry_run=True)
            self.assertIn("LANDR Demo Pack.zip", summary["zips"])
            self.assertIn("LANDR_Demo_Pack", summary["registered"])
            self.assertEqual(summary["extracted"], [])
            dest = os.path.join(raw, "LANDR_Demo_Pack", "kick.wav")
            self.assertFalse(os.path.exists(dest))
            row = _open_pack(db_path, "LANDR_Demo_Pack")
            self.assertEqual(row.get("status"), "PENDING")

    def test_extract_skips_macosx_and_is_idempotent(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            incoming = os.path.join(tmp, "incoming_zips")
            raw = os.path.join(tmp, "raw_packs")
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            os.makedirs(incoming)
            zip_path = os.path.join(incoming, "Tiny-Pack.zip")
            _write_zip(
                zip_path,
                {
                    "loop/kick.wav": b"RIFF",
                    "__MACOSX/._kick.wav": b"junk",
                    "loop/.DS_Store": b"ds",
                },
            )
            first = process_incoming_zips(incoming, raw, db_path, dry_run=False)
            self.assertIn("Tiny-Pack.zip", first["extracted"])
            dest_dir = os.path.join(raw, "Tiny_Pack")
            kick = os.path.join(dest_dir, "loop", "kick.wav")
            self.assertTrue(os.path.isfile(kick))
            self.assertFalse(os.path.exists(os.path.join(dest_dir, "__MACOSX")))
            self.assertFalse(os.path.exists(os.path.join(dest_dir, "loop", ".DS_Store")))
            os.remove(kick)
            second = process_incoming_zips(incoming, raw, db_path, dry_run=False)
            self.assertIn("Tiny-Pack.zip", second["skipped"])
            self.assertEqual(second["extracted"], [])
            self.assertFalse(os.path.isfile(kick))
            self.assertEqual(_open_pack(db_path, "Tiny_Pack").get("status"), "UNZIPPED")

    def test_extract_zip_to_direct(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            zip_path = os.path.join(tmp, "x.zip")
            dest = os.path.join(tmp, "out")
            _write_zip(zip_path, {"a.txt": b"hello", "__MACOSX/b": b"no"})
            n = extract_zip_to(zip_path, dest)
            self.assertEqual(n, 1)
            self.assertTrue(os.path.isfile(os.path.join(dest, "a.txt")))

    def test_extract_skips_icon_cr_keeps_wav(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            incoming = os.path.join(tmp, "incoming_zips")
            raw = os.path.join(tmp, "raw_packs")
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            os.makedirs(incoming)
            zip_path = os.path.join(incoming, "Icon Pack.zip")
            _write_zip(
                zip_path,
                {
                    "kit/dummy.wav": b"RIFFWAVEfmt ",
                    "Icon\r": b"macos-icon",
                    "__MACOSX/._dummy.wav": b"appledouble",
                    ".DS_Store": b"ds",
                    "._hidden": b"apple",
                },
            )
            n = extract_zip_to(zip_path, os.path.join(tmp, "direct_out"))
            self.assertGreaterEqual(n, 1)
            self.assertTrue(
                os.path.isfile(os.path.join(tmp, "direct_out", "kit", "dummy.wav"))
            )
            summary = process_incoming_zips(incoming, raw, db_path, dry_run=False)
            self.assertIn("Icon Pack.zip", summary["extracted"])
            self.assertNotIn("Icon Pack.zip", summary["failed"])
            dest_dir = os.path.join(raw, "Icon_Pack")
            wav = os.path.join(dest_dir, "kit", "dummy.wav")
            self.assertTrue(os.path.isfile(wav))
            self.assertEqual(_open_pack(db_path, "Icon_Pack").get("status"), "UNZIPPED")
            icon_on_disk = False
            for dirpath, _, filenames in os.walk(dest_dir):
                for fn in filenames:
                    core = fn.replace("\r", "").replace("\n", "")
                    if core.lower() == "icon":
                        icon_on_disk = True
            self.assertFalse(icon_on_disk)

    def test_all_junk_members_marks_failed(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            incoming = os.path.join(tmp, "incoming_zips")
            raw = os.path.join(tmp, "raw_packs")
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            os.makedirs(incoming)
            _write_zip(
                os.path.join(incoming, "Junk Only.zip"),
                {
                    "Icon\r": b"macos-icon",
                    "__MACOSX/foo": b"no",
                    ".DS_Store": b"ds",
                    "._hidden": b"apple",
                },
            )
            summary = process_incoming_zips(incoming, raw, db_path, dry_run=False)
            self.assertIn("Junk Only.zip", summary["failed"])
            self.assertNotIn("Junk Only.zip", summary["extracted"])
            self.assertEqual(_open_pack(db_path, "Junk_Only").get("status"), "FAILED")

    def test_empty_incoming_exit_zero(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            incoming = os.path.join(tmp, "incoming_zips")
            raw = os.path.join(tmp, "raw_packs")
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            os.makedirs(incoming)
            code = tracker_main(
                ["--incoming", incoming, "--raw-packs", raw, "--db", db_path]
            )
            self.assertEqual(code, 0)
            conn = connect_corpus_db(db_path)
            try:
                self.assertEqual(list_packs(conn), [])
            finally:
                conn.close()

    def test_list_status_does_not_unzip(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            incoming = os.path.join(tmp, "incoming_zips")
            raw = os.path.join(tmp, "raw_packs")
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            os.makedirs(incoming)
            _write_zip(os.path.join(incoming, "Wait.zip"), {"a.txt": b"x"})
            code = tracker_main(
                ["--incoming", incoming, "--raw-packs", raw, "--db", db_path, "--list"]
            )
            self.assertEqual(code, 0)
            self.assertFalse(os.path.exists(os.path.join(raw, "Wait", "a.txt")))
            conn = connect_corpus_db(db_path)
            try:
                self.assertEqual(list_packs(conn), [])
            finally:
                conn.close()

    def test_default_scan_ignores_root_zips(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            incoming = os.path.join(tmp, "incoming_zips")
            raw = os.path.join(tmp, "raw_packs")
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            os.makedirs(incoming)
            _write_zip(os.path.join(tmp, "fma_full.zip"), {"huge.txt": b"no"})
            _write_zip(os.path.join(tmp, "LANDR-root.zip"), {"a.txt": b"x"})
            summary = process_incoming_zips(
                incoming, raw, db_path, dry_run=False, also_scan_root=False, dataset_root=tmp
            )
            self.assertTrue(summary["incoming_empty"])
            self.assertEqual(summary["extracted"], [])
            self.assertEqual(summary["root_listed"], [])
            self.assertFalse(os.path.exists(os.path.join(raw, "LANDR_root", "a.txt")))

    def test_also_scan_root_registers_but_does_not_extract(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            incoming = os.path.join(tmp, "incoming_zips")
            raw = os.path.join(tmp, "raw_packs")
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            os.makedirs(incoming)
            _write_zip(os.path.join(tmp, "fma_full.zip"), {"huge.txt": b"no"})
            _write_zip(os.path.join(tmp, "LANDR-root.zip"), {"a.txt": b"x"})
            summary = process_incoming_zips(
                incoming, raw, db_path, dry_run=False, also_scan_root=True, dataset_root=tmp
            )
            self.assertIn("LANDR-root.zip", summary["root_listed"])
            self.assertIn("fma_full.zip", summary["skipped"])
            self.assertFalse(os.path.exists(os.path.join(raw, "LANDR_root", "a.txt")))
            self.assertEqual(_open_pack(db_path, "LANDR_root").get("status"), "PENDING")

    def test_skips_fma_full_in_incoming(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            incoming = os.path.join(tmp, "incoming_zips")
            raw = os.path.join(tmp, "raw_packs")
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            os.makedirs(incoming)
            _write_zip(os.path.join(incoming, "fma_full.zip"), {"huge.txt": b"no"})
            summary = process_incoming_zips(incoming, raw, db_path, dry_run=False)
            self.assertIn("fma_full.zip", summary["skipped"])
            self.assertEqual(summary["extracted"], [])

    def test_advance_sliced_then_ready_not_from_unzipped(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            conn = connect_corpus_db(db_path)
            try:
                conn.execute(
                    "INSERT INTO pack_manifest "
                    "(pack_name, zip_filename, status, raw_path, slice_count, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    ("Pack_A", "Pack-A.zip", "UNZIPPED", os.path.join(tmp, "Pack_A"), 0, 1.0),
                )
                conn.execute(
                    "INSERT INTO pack_manifest "
                    "(pack_name, zip_filename, status, raw_path, slice_count, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    ("Pack_B", "Pack-B.zip", "UNZIPPED", os.path.join(tmp, "Pack_B"), 0, 1.0),
                )
                conn.commit()
                self.assertEqual(advance_to_ready(conn), 0)
                self.assertEqual(get_pack(conn, "Pack_A")["status"], "UNZIPPED")
                self.assertTrue(advance_to_sliced(conn, "Pack_A", slice_count=4))
                self.assertEqual(get_pack(conn, "Pack_A")["status"], "SLICED")
                self.assertEqual(get_pack(conn, "Pack_A")["slice_count"], 4)
                self.assertEqual(advance_to_ready(conn), 1)
                self.assertEqual(get_pack(conn, "Pack_A")["status"], "READY_TO_GO")
                self.assertEqual(get_pack(conn, "Pack_B")["status"], "UNZIPPED")
            finally:
                conn.close()

    def test_refuses_extract_into_corpus_4s(self):
        with self.assertRaises(ValueError):
            assert_safe_raw_packs(r"D:\MusicDatasets\corpus_4s")
        with self.assertRaises(ValueError):
            assert_safe_raw_packs(r"D:\MusicDatasets\uploaded_slices")
        with self.assertRaises(ValueError):
            assert_safe_raw_packs(r"D:\MusicDatasets")

    def test_creates_pack_manifest_without_wiping_slice_index(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            conn = sqlite3.connect(db_path)
            try:
                conn.execute(
                    "CREATE TABLE slice_index (id INTEGER PRIMARY KEY, file_path TEXT UNIQUE)"
                )
                conn.execute("INSERT INTO slice_index (file_path) VALUES (?)", ("keep.wav",))
                conn.commit()
            finally:
                conn.close()
            opened = connect_corpus_db(db_path)
            try:
                n = opened.execute("SELECT COUNT(*) FROM slice_index").fetchone()[0]
                self.assertEqual(int(n), 1)
                cols = {row[1] for row in opened.execute("PRAGMA table_info(pack_manifest)")}
                for name in (
                    "pack_name",
                    "zip_filename",
                    "status",
                    "raw_path",
                    "slice_count",
                    "updated_at",
                ):
                    self.assertIn(name, cols)
            finally:
                opened.close()

    def test_cli_dry_run(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            incoming = os.path.join(tmp, "incoming_zips")
            raw = os.path.join(tmp, "raw_packs")
            db_path = os.path.join(tmp, "corpus_index.sqlite")
            os.makedirs(incoming)
            _write_zip(os.path.join(incoming, "Cli Pack.zip"), {"a.txt": b"x"})
            code = tracker_main(
                [
                    "--incoming",
                    incoming,
                    "--raw-packs",
                    raw,
                    "--db",
                    db_path,
                    "--dry-run",
                ]
            )
            self.assertEqual(code, 0)
            self.assertFalse(os.path.exists(os.path.join(raw, "Cli_Pack", "a.txt")))
            self.assertEqual(_open_pack(db_path, "Cli_Pack").get("status"), "PENDING")


if __name__ == "__main__":
    unittest.main()
